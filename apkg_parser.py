"""Parse .apkg files (Anki deck packages) and extract cards with inline media."""

import base64
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import tempfile
import time
import uuid
import zipfile

try:
    import zstandard
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False


def _extract_apkg(path):
    """Extract .apkg ZIP to a temp directory. Returns the temp dir path."""
    tmp = tempfile.mkdtemp(prefix="ankiLite_")
    with zipfile.ZipFile(path, "r") as zf:
        zf.extractall(tmp)
    return tmp


ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


def _maybe_decompress(data):
    """Decompress zstd data if it starts with the zstd magic bytes."""
    if data[:4] == ZSTD_MAGIC and HAS_ZSTD:
        dctx = zstandard.ZstdDecompressor()
        reader = dctx.stream_reader(data)
        result = reader.read()
        reader.close()
        return result
    return data


def _load_media_map(tmp_dir):
    """Load the media JSON mapping (numeric filename -> original name)."""
    media_path = os.path.join(tmp_dir, "media")
    if not os.path.exists(media_path):
        return {}
    with open(media_path, "rb") as f:
        raw = _maybe_decompress(f.read())
    if not raw or not raw.strip():
        return {}
    return json.loads(raw.decode("utf-8"))


def _open_db(tmp_dir):
    """Open the SQLite database from the extracted apkg.

    Tries collection.anki21b (zstd-compressed), collection.anki21, then collection.anki2.
    Returns (connection, db_filename).
    """
    # Try zstd-compressed format first
    anki21b = os.path.join(tmp_dir, "collection.anki21b")
    if os.path.exists(anki21b) and HAS_ZSTD:
        decompressed_path = os.path.join(tmp_dir, "collection.anki21")
        with open(anki21b, "rb") as f:
            data = _maybe_decompress(f.read())
        with open(decompressed_path, "wb") as f:
            f.write(data)
        conn = sqlite3.connect(decompressed_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=DELETE")
        return conn, "collection.anki21"

    for name in ("collection.anki21", "collection.anki2"):
        db_path = os.path.join(tmp_dir, name)
        if os.path.exists(db_path):
            conn = sqlite3.connect(db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=DELETE")
            return conn, name

    raise FileNotFoundError("No Anki database found in .apkg")


def _detect_schema(conn):
    """Detect whether DB uses modern (notetypes table) or legacy (col.models JSON) schema."""
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    if "notetypes" in tables:
        return "modern"
    return "legacy"


def _get_models_legacy(conn):
    """Extract model definitions from legacy schema (col.models JSON).

    Returns {mid: {"name": str, "fields": [field_name, ...], "templates": [...], "css": str}}.
    """
    row = conn.execute("SELECT models FROM col").fetchone()
    models_json = json.loads(row[0])
    result = {}
    for mid, model in models_json.items():
        fields = [f["name"] for f in sorted(model["flds"], key=lambda x: x["ord"])]
        templates = [{"name": t["name"], "qfmt": t["qfmt"], "afmt": t["afmt"], "ord": t["ord"]}
                     for t in sorted(model.get("tmpls", []), key=lambda x: x["ord"])]
        result[int(mid)] = {"name": model["name"], "fields": fields, "templates": templates, "css": model.get("css", "")}
    return result


def _extract_css_from_notetype_config(blob):
    """Extract CSS string from Anki's NoteType protobuf config blob.

    CSS is stored as field 8 (wire type 2 = length-delimited) in the protobuf.
    Returns empty string if extraction fails.
    """
    if not blob:
        return ""
    try:
        i = 0
        while i < len(blob):
            # Read varint tag
            tag = 0
            shift = 0
            while i < len(blob):
                b = blob[i]
                i += 1
                tag |= (b & 0x7F) << shift
                shift += 7
                if not (b & 0x80):
                    break
            field_number = tag >> 3
            wire_type = tag & 0x07
            if wire_type == 0:  # varint
                while i < len(blob) and blob[i] & 0x80:
                    i += 1
                i += 1
            elif wire_type == 2:  # length-delimited
                length = 0
                shift = 0
                while i < len(blob):
                    b = blob[i]
                    i += 1
                    length |= (b & 0x7F) << shift
                    shift += 7
                    if not (b & 0x80):
                        break
                data = blob[i:i + length]
                i += length
                if field_number == 8:
                    return data.decode("utf-8", errors="replace")
            elif wire_type == 5:  # 32-bit
                i += 4
            elif wire_type == 1:  # 64-bit
                i += 8
            else:
                break
    except Exception:
        pass
    return ""


def _get_models_modern(conn):
    """Extract model definitions from modern schema (notetypes + fields tables).

    Returns {mid: {"name": str, "fields": [field_name, ...], "templates": [...], "css": str}}.
    """
    # Check if templates table exists
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    has_templates_table = "templates" in tables

    result = {}
    notetypes = conn.execute("SELECT id, name, config FROM notetypes").fetchall()
    for nt in notetypes:
        mid = nt[0]
        name = nt[1]
        config_blob = nt[2] if len(nt) > 2 else None
        fields_rows = conn.execute(
            "SELECT name FROM fields WHERE ntid = ? ORDER BY ord", (mid,)
        ).fetchall()
        fields = [r[0] for r in fields_rows]

        templates = []
        if has_templates_table:
            tmpl_rows = conn.execute(
                "SELECT name, config FROM templates WHERE ntid = ? ORDER BY ord", (mid,)
            ).fetchall()
            for idx, tr in enumerate(tmpl_rows):
                tmpl_name = tr[0]
                tmpl_config = tr[1]
                qfmt, afmt = _extract_template_qfmt_afmt(tmpl_config)
                templates.append({"name": tmpl_name, "qfmt": qfmt, "afmt": afmt, "ord": idx})

        css = _extract_css_from_notetype_config(config_blob) if config_blob else ""
        result[mid] = {"name": name, "fields": fields, "templates": templates, "css": css}
    return result


def _extract_template_qfmt_afmt(config_blob):
    """Extract qfmt and afmt from a template's protobuf config blob.

    In Anki's Template protobuf, qfmt is field 2 and afmt is field 3.
    """
    qfmt = ""
    afmt = ""
    if not config_blob:
        return qfmt, afmt
    try:
        i = 0
        while i < len(config_blob):
            tag = 0
            shift = 0
            while i < len(config_blob):
                b = config_blob[i]
                i += 1
                tag |= (b & 0x7F) << shift
                shift += 7
                if not (b & 0x80):
                    break
            field_number = tag >> 3
            wire_type = tag & 0x07
            if wire_type == 0:  # varint
                while i < len(config_blob) and config_blob[i] & 0x80:
                    i += 1
                i += 1
            elif wire_type == 2:  # length-delimited
                length = 0
                shift = 0
                while i < len(config_blob):
                    b = config_blob[i]
                    i += 1
                    length |= (b & 0x7F) << shift
                    shift += 7
                    if not (b & 0x80):
                        break
                data = config_blob[i:i + length]
                i += length
                if field_number == 2:
                    qfmt = data.decode("utf-8", errors="replace")
                elif field_number == 3:
                    afmt = data.decode("utf-8", errors="replace")
            elif wire_type == 5:  # 32-bit
                i += 4
            elif wire_type == 1:  # 64-bit
                i += 8
            else:
                break
    except Exception:
        pass
    return qfmt, afmt


def _media_to_base64(filename, tmp_dir, media_map):
    """Convert a media filename to a base64 data URI.

    Looks up the file in the media map (reverse lookup: original name -> numeric key),
    then reads and encodes it.
    """
    reverse = {v: k for k, v in media_map.items()}
    numeric = reverse.get(filename)
    if numeric is None:
        return None
    file_path = os.path.join(tmp_dir, numeric)
    if not os.path.exists(file_path):
        return None
    mime, _ = mimetypes.guess_type(filename)
    if mime is None:
        mime = "application/octet-stream"
    with open(file_path, "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{data}"


def _inline_images(html, tmp_dir, media_map, uri_to_filename=None):
    """Replace <img src="filename"> references with inline base64 data URIs.

    If *uri_to_filename* dict is provided, records data_uri → filename mappings
    so they can be reversed later (de-inlining).
    """
    def replace_src(match):
        filename = match.group(1)
        data_uri = _media_to_base64(filename, tmp_dir, media_map)
        if data_uri:
            if uri_to_filename is not None:
                uri_to_filename[data_uri] = filename
            return f'src="{data_uri}"'
        return match.group(0)

    return re.sub(r'src="([^"]+)"', replace_src, html)


def _strip_sound(text):
    """Remove [sound:...] references."""
    return re.sub(r'\[sound:[^\]]+\]', '', text)


class DeckSession:
    """Persistent session for an opened .apkg deck.

    Keeps the extracted working directory and SQLite connection alive so that
    cards can be edited (e.g. images added) and then exported back to .apkg.
    """

    def __init__(self, apkg_path):
        self.apkg_path = apkg_path
        self.tmp_dir = None
        self.conn = None
        self.db_filename = None
        self.media_map = {}
        self.models = {}
        self._next_media_key = 0
        self._uri_to_filename = {}  # data_uri → media filename for de-inlining

    def open(self):
        """Extract .apkg, open DB, parse cards. Returns list of card dicts."""
        self.tmp_dir = _extract_apkg(self.apkg_path)
        self.media_map = _load_media_map(self.tmp_dir)
        self.conn, self.db_filename = _open_db(self.tmp_dir)
        schema = _detect_schema(self.conn)

        if schema == "modern":
            self.models = _get_models_modern(self.conn)
        else:
            self.models = _get_models_legacy(self.conn)

        # Compute next media key from existing numeric keys
        if self.media_map:
            max_key = max(int(k) for k in self.media_map.keys())
            self._next_media_key = max_key + 1
        else:
            self._next_media_key = 0

        # Build a map of note_id -> (card due position, card ord) for ordering
        card_positions = {}
        card_ords = {}
        for row in self.conn.execute("SELECT nid, due, ord FROM cards ORDER BY due"):
            if row[0] not in card_positions:
                card_positions[row[0]] = row[1]
            if row[0] not in card_ords:
                card_ords[row[0]] = row[2]

        notes = self.conn.execute("SELECT id, mid, flds, mod FROM notes").fetchall()
        cards = []
        for note in notes:
            note_id = note[0]
            mid = note[1]
            flds_raw = note[2]
            mod_ts = note[3]

            model = self.models.get(mid)
            if model is None:
                continue

            field_values = flds_raw.split("\x1f")
            field_names = model["fields"]

            fields = {}
            for i, name in enumerate(field_names):
                val = field_values[i] if i < len(field_values) else ""
                val = _strip_sound(val)
                val = _inline_images(val, self.tmp_dir, self.media_map,
                                     self._uri_to_filename)
                fields[name] = val

            cards.append({
                "note_id": note_id,
                "model_id": mid,
                "model": model["name"],
                "fields": fields,
                "created_ts": note_id // 1000,
                "mod_ts": mod_ts,
                "card_ord": card_ords.get(note_id, 0),
            })

        # Sort cards by their due position in the cards table
        cards.sort(key=lambda c: card_positions.get(c["note_id"], 0))

        # Normalize due values to sequential 0, 1, 2, ...
        for i, card in enumerate(cards):
            self.conn.execute(
                "UPDATE cards SET due = ? WHERE nid = ?",
                (i, card["note_id"]),
            )
        self.conn.commit()

        return cards

    def add_image(self, note_id, field_name, image_bytes, ext):
        """Add an image to a note's field.

        Saves the image file in the working dir, updates the media map,
        appends <img> to the field in the DB, and returns the base64 data URI.
        """
        # Determine filename
        media_filename = f"paste_{self._next_media_key}{ext}"
        numeric_key = str(self._next_media_key)
        self._next_media_key += 1

        # Write image file to working dir
        file_path = os.path.join(self.tmp_dir, numeric_key)
        with open(file_path, "wb") as f:
            f.write(image_bytes)

        # Update media map
        self.media_map[numeric_key] = media_filename

        # Build data URI for display
        mime, _ = mimetypes.guess_type(media_filename)
        if mime is None:
            mime = "application/octet-stream"
        data_uri = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

        # Update DB: append <img> tag to the field
        row = self.conn.execute(
            "SELECT mid, flds FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        if row is None:
            return {"ok": False, "error": "Note not found"}

        mid = row[0]
        flds_raw = row[1]
        model = self.models.get(mid)
        if model is None:
            return {"ok": False, "error": "Model not found"}

        field_values = flds_raw.split("\x1f")
        field_names = model["fields"]

        try:
            field_idx = field_names.index(field_name)
        except ValueError:
            return {"ok": False, "error": f"Field '{field_name}' not found"}

        # Pad field_values if needed
        while len(field_values) <= field_idx:
            field_values.append("")

        img_tag = f'<img src="{media_filename}">'
        field_values[field_idx] += img_tag

        new_flds = "\x1f".join(field_values)
        self.conn.execute(
            "UPDATE notes SET flds = ?, mod = ?, usn = -1 WHERE id = ?",
            (new_flds, int(time.time()), note_id),
        )
        self.conn.commit()

        # Register for de-inlining
        self._uri_to_filename[data_uri] = media_filename

        return {"ok": True, "data_uri": data_uri}

    def remove_image(self, note_id, field_name, image_index):
        """Remove the Nth <img> tag from a note's field. Saves immediately."""
        row = self.conn.execute(
            "SELECT mid, flds FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        if row is None:
            return {"ok": False, "error": "Note not found"}

        mid = row[0]
        flds_raw = row[1]
        model = self.models.get(mid)
        if model is None:
            return {"ok": False, "error": "Model not found"}

        field_values = flds_raw.split("\x1f")
        field_names = model["fields"]

        try:
            field_idx = field_names.index(field_name)
        except ValueError:
            return {"ok": False, "error": f"Field '{field_name}' not found"}

        if field_idx >= len(field_values):
            return {"ok": False, "error": "Field index out of range"}

        field_text = field_values[field_idx]
        matches = list(re.finditer(r'<img\s[^>]*>', field_text))

        if image_index < 0 or image_index >= len(matches):
            return {"ok": False, "error": "Image index out of range"}

        match = matches[image_index]
        field_values[field_idx] = field_text[:match.start()] + field_text[match.end():]

        new_flds = "\x1f".join(field_values)
        self.conn.execute(
            "UPDATE notes SET flds = ?, mod = ?, usn = -1 WHERE id = ?",
            (new_flds, int(time.time()), note_id),
        )
        self.conn.commit()
        return {"ok": True}

    def _deinline_field(self, html):
        """Replace base64 data URIs back to media filenames before storing."""
        def replace_uri(match):
            uri = match.group(1)
            filename = self._uri_to_filename.get(uri)
            if filename:
                return f'src="{filename}"'
            return match.group(0)

        return re.sub(r'src="(data:[^"]+)"', replace_uri, html)

    def update_field(self, note_id, field_name, new_value):
        """Update a single field's value for a note. De-inlines images first."""
        row = self.conn.execute(
            "SELECT mid, flds FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        if row is None:
            return {"ok": False, "error": "Note not found"}

        mid = row[0]
        flds_raw = row[1]
        model = self.models.get(mid)
        if model is None:
            return {"ok": False, "error": "Model not found"}

        field_values = flds_raw.split("\x1f")
        field_names = model["fields"]

        try:
            field_idx = field_names.index(field_name)
        except ValueError:
            return {"ok": False, "error": f"Field '{field_name}' not found"}

        while len(field_values) <= field_idx:
            field_values.append("")

        field_values[field_idx] = self._deinline_field(new_value)

        new_flds = "\x1f".join(field_values)
        self.conn.execute(
            "UPDATE notes SET flds = ?, mod = ?, usn = -1 WHERE id = ?",
            (new_flds, int(time.time()), note_id),
        )
        self.conn.commit()
        return {"ok": True}

    def create_card(self, model_id, position=None):
        """Create a new card with empty fields for the given model.

        If position is given (0-indexed), insert at that position and shift
        subsequent cards' due values forward.
        """
        model = self.models.get(model_id)
        if model is None:
            return {"ok": False, "error": "Model not found"}

        # Generate unique IDs
        note_id = int(time.time() * 1000)
        card_id = note_id + 1
        guid = str(uuid.uuid4())[:10]
        now = int(time.time())

        # Get deck_id from an existing card
        row = self.conn.execute("SELECT did FROM cards LIMIT 1").fetchone()
        if row is None:
            return {"ok": False, "error": "No cards in deck to determine deck_id"}
        deck_id = row[0]

        # Determine due position
        if position is not None:
            # Shift existing cards at or after this position
            self.conn.execute(
                "UPDATE cards SET due = due + 1 WHERE due >= ?",
                (position,),
            )
            due = position
        else:
            row = self.conn.execute("SELECT MAX(due) FROM cards").fetchone()
            due = (row[0] + 1) if row[0] is not None else 0

        # Create empty fields joined by \x1f
        field_count = len(model["fields"])
        empty_fields = "\x1f".join([""] * field_count)

        # Insert into notes table
        self.conn.execute(
            """INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
               VALUES (?, ?, ?, ?, -1, '', ?, '', 0, 0, '')""",
            (note_id, guid, model_id, now, empty_fields),
        )

        # Insert into cards table with correct due position
        self.conn.execute(
            """INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
               VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')""",
            (card_id, note_id, deck_id, now, due),
        )
        self.conn.commit()

        # Build card dict matching open() format
        fields = {name: "" for name in model["fields"]}
        card = {
            "note_id": note_id,
            "model_id": model_id,
            "model": model["name"],
            "fields": fields,
            "created_ts": note_id // 1000,
            "mod_ts": now,
        }
        return {"ok": True, "card": card}

    def delete_card(self, note_id):
        """Delete a card and its associated note."""
        # Verify note exists
        row = self.conn.execute(
            "SELECT id FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        if row is None:
            return {"ok": False, "error": "Note not found"}

        # Get the due value before deleting so we can shift subsequent cards
        card_row = self.conn.execute(
            "SELECT due FROM cards WHERE nid = ?", (note_id,)
        ).fetchone()
        due_val = card_row[0] if card_row else None

        # Delete from cards table first (references note)
        self.conn.execute("DELETE FROM cards WHERE nid = ?", (note_id,))
        # Delete from notes table
        self.conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))

        # Shift subsequent cards' positions down to keep sequential ordering
        if due_val is not None:
            self.conn.execute(
                "UPDATE cards SET due = due - 1 WHERE due > ?",
                (due_val,),
            )

        self.conn.commit()
        return {"ok": True}

    def export_apkg(self, output_path):
        """Export the modified deck as a new .apkg file."""
        try:
            self.conn.commit()
            # Checkpoint any WAL data into the main DB file
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass

            # Write updated media map
            media_json = json.dumps(self.media_map).encode("utf-8")
            media_path = os.path.join(self.tmp_dir, "media")
            with open(media_path, "wb") as f:
                f.write(media_json)

            # Build the .apkg ZIP
            with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
                # Add the database file
                db_path = os.path.join(self.tmp_dir, self.db_filename)
                zf.write(db_path, self.db_filename)

                # Add media map
                zf.write(media_path, "media")

                # Add all numeric media files
                for key in self.media_map:
                    fpath = os.path.join(self.tmp_dir, key)
                    if os.path.exists(fpath):
                        zf.write(fpath, key)

            return {"ok": True, "path": output_path}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def close(self):
        """Close the DB connection and clean up the working directory."""
        if self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None
        if self.tmp_dir and os.path.exists(self.tmp_dir):
            shutil.rmtree(self.tmp_dir, ignore_errors=True)
            self.tmp_dir = None


def parse_apkg(path):
    """Parse an .apkg file and return a list of card dicts (backward-compatible wrapper).

    Each card dict has:
      - "note_id": int
      - "model": str (model/note type name)
      - "fields": {"FieldName": "value", ...}

    Images are inlined as base64 data URIs. Sound references are stripped.
    """
    session = DeckSession(path)
    try:
        return session.open()
    finally:
        session.close()
