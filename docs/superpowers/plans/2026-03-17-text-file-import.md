# Text File Import Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to drop or open `.txt`/`.csv` files to create Anki cards with a preview dialog, supporting tab/semicolon/comma delimiters.

**Architecture:** Python-side parsing (using `csv` module) with two API round-trips: parse for preview, then bulk-create on confirm. New `DeckSession` methods (`bulk_create_cards`, `get_all_cards`) handle DB operations. Frontend adds an import preview overlay and routes file types by extension.

**Tech Stack:** Python `csv` module, SQLite, pywebview JS bridge, vanilla JS/HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-03-17-text-file-import-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apkg_parser.py` | Modify | Add `parse_text_file()`, `DeckSession.bulk_create_cards()`, `DeckSession.get_all_cards()` |
| `main.py` | Modify | Add `Api.parse_text_file()`, `Api.import_text_cards()`, update `_on_drop` and `open_file_dialog` |
| `ui/app.js` | Modify | Add `_loadTextFromPath`, `confirmImport`, update file dialog routing and Escape handler |
| `ui/index.html` | Modify | Add import preview overlay, update welcome text |
| `ui/style.css` | Modify | Add import preview dialog styles |
| `tests/test_text_import.py` | Create | Tests for `parse_text_file` and `DeckSession.bulk_create_cards` / `get_all_cards` |

---

### Task 1: `parse_text_file()` function

**Files:**
- Create: `tests/test_text_import.py`
- Modify: `apkg_parser.py` (add after line 838, at end of file)

- [ ] **Step 1: Write failing tests for `parse_text_file`**

Create `tests/test_text_import.py`:

```python
"""Tests for text file import — parsing, bulk creation, and card retrieval."""

import os
import pytest
from apkg_parser import parse_text_file


class TestParseTextFile:
    def test_tab_separated(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_text("hello\tworld\nfoo\tbar\n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["ok"] is True
        assert result["rows"] == [["hello", "world"], ["foo", "bar"]]
        assert result["delimiter"] == "tab"
        assert result["num_fields"] == 2
        assert result["has_header"] is False

    def test_semicolon_separated(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_text("hello;world\nfoo;bar\n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["ok"] is True
        assert result["delimiter"] == "semicolon"
        assert result["rows"] == [["hello", "world"], ["foo", "bar"]]

    def test_comma_separated(self, tmp_path):
        f = tmp_path / "cards.csv"
        f.write_text("hello,world\nfoo,bar\n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["ok"] is True
        assert result["delimiter"] == "comma"

    def test_header_detected(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_text("Front\tBack\nhello\tworld\nfoo\tbar\n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["has_header"] is True
        assert result["header_row"] == ["Front", "Back"]
        assert len(result["rows"]) == 2
        assert result["rows"][0] == ["hello", "world"]

    def test_no_header_when_no_keywords(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_text("apple\torange\ncat\tdog\n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["has_header"] is False
        assert result["header_row"] is None
        assert len(result["rows"]) == 2

    def test_empty_file(self, tmp_path):
        f = tmp_path / "empty.txt"
        f.write_text("", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["ok"] is False
        assert "empty" in result["error"].lower()

    def test_single_column(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_text("hello\nworld\n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["ok"] is True
        assert result["num_fields"] == 1
        assert result["rows"] == [["hello"], ["world"]]

    def test_skips_empty_lines(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_text("a\tb\n\n\nc\td\n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert len(result["rows"]) == 2

    def test_utf8_bom(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_bytes(b"\xef\xbb\xbfhello\tworld\n")
        result = parse_text_file(str(f))
        assert result["ok"] is True
        assert result["rows"][0][0] == "hello"

    def test_latin1_fallback(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_bytes(b"caf\xe9\tgood\n")
        result = parse_text_file(str(f))
        assert result["ok"] is True
        assert "caf" in result["rows"][0][0]

    def test_strips_whitespace(self, tmp_path):
        f = tmp_path / "cards.txt"
        f.write_text("  hello  \t  world  \n", encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["rows"][0] == ["hello", "world"]

    def test_consistency_based_delimiter(self, tmp_path):
        """A CSV with tabs in content should still detect comma as delimiter."""
        f = tmp_path / "cards.csv"
        f.write_text('hello,world\n"has\ttab",value\n', encoding="utf-8")
        result = parse_text_file(str(f))
        assert result["delimiter"] == "comma"
        assert len(result["rows"]) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/angel/school/ankiLite && python -m pytest tests/test_text_import.py::TestParseTextFile -v`
Expected: FAIL — `ImportError: cannot import name 'parse_text_file'`

- [ ] **Step 3: Implement `parse_text_file` in `apkg_parser.py`**

Add `import csv` and `from collections import Counter` to the imports at the top of `apkg_parser.py` (after the existing imports around line 13):

```python
import csv
from collections import Counter
```

Then add at end of `apkg_parser.py` (after line 838):

```python
HEADER_KEYWORDS = {"front", "back", "question", "answer", "term", "definition", "prompt", "response"}


def _detect_delimiter(lines):
    """Pick the delimiter that produces the most consistent column count across lines."""
    candidates = [("\t", "tab"), (";", "semicolon"), (",", "comma")]
    best_delim = ","
    best_name = "comma"
    best_score = 0

    for delim, name in candidates:
        # Count lines where splitting produces >1 column
        counts = {}
        for line in lines:
            cols = len(next(csv.reader([line], delimiter=delim)))
            if cols > 1:
                counts[cols] = counts.get(cols, 0) + 1
        if counts:
            score = max(counts.values())
            if score > best_score or (score == best_score and candidates.index((delim, name)) < candidates.index((best_delim, best_name))):
                best_score = score
                best_delim = delim
                best_name = name

    return best_delim, best_name


def _detect_header(rows):
    """Check if the first row looks like a header (contains common field name keywords)."""
    if len(rows) < 2:
        return False
    first = rows[0]
    rest_col_counts = [len(r) for r in rows[1:]]
    if not rest_col_counts:
        return False
    # Most common column count among data rows
    most_common_count = Counter(rest_col_counts).most_common(1)[0][0]
    if len(first) != most_common_count:
        return False
    # Check if any cell matches a header keyword
    return any(cell.strip().lower() in HEADER_KEYWORDS for cell in first)


def parse_text_file(path):
    """Parse a text file (.txt/.csv) and return rows for import preview.

    Returns {ok, rows, delimiter, has_header, header_row, num_fields} or {ok: False, error}.
    """
    # Read file with encoding detection
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except Exception as e:
        return {"ok": False, "error": str(e)}

    # Decode: try UTF-8 (with BOM), fall back to latin-1
    if raw.startswith(b"\xef\xbb\xbf"):
        text = raw[3:].decode("utf-8")
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")

    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return {"ok": False, "error": "File is empty"}

    delim, delim_name = _detect_delimiter(lines)

    # Parse with csv.reader
    reader = csv.reader(lines, delimiter=delim)
    rows = []
    for row in reader:
        stripped = [cell.strip() for cell in row]
        if any(cell for cell in stripped):
            rows.append(stripped)

    if not rows:
        return {"ok": False, "error": "File is empty"}

    has_header = _detect_header(rows)
    header_row = rows[0] if has_header else None
    data_rows = rows[1:] if has_header else rows

    num_fields = max(len(r) for r in data_rows) if data_rows else 0

    return {
        "ok": True,
        "rows": data_rows,
        "delimiter": delim_name,
        "has_header": has_header,
        "header_row": header_row,
        "num_fields": num_fields,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/angel/school/ankiLite && python -m pytest tests/test_text_import.py::TestParseTextFile -v`
Expected: All 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/test_text_import.py apkg_parser.py
git commit -m "feat: add parse_text_file for text/CSV import"
```

---

### Task 2: `DeckSession.bulk_create_cards()` and `DeckSession.get_all_cards()`

**Files:**
- Modify: `tests/test_text_import.py` (append new test class)
- Modify: `apkg_parser.py:303-512` (add methods to `DeckSession` class)

- [ ] **Step 1: Write failing tests**

Append to `tests/test_text_import.py`:

```python
import json
import sqlite3
import zipfile
from apkg_parser import DeckSession


def _make_apkg(path, cards=None):
    """Build a minimal .apkg fixture (same helper as test_deck_session.py)."""
    if cards is None:
        cards = [(1, 1, "Capital of France?\x1fParis")]
    db_path = path + ".db"
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT)")
    models = {
        "1": {
            "name": "Basic",
            "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}],
            "tmpls": [{"name": "Card 1", "qfmt": "{{Front}}", "afmt": "{{FrontSide}}<hr id=answer>{{Back}}", "ord": 0}],
            "css": ".card { font-family: arial; }",
        }
    }
    conn.execute("INSERT INTO col VALUES (1, ?)", (json.dumps(models),))
    conn.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, flds TEXT, mod INTEGER, usn INTEGER, tags TEXT, sfld TEXT, csum INTEGER, flags INTEGER, data TEXT)")
    for nid, mid, flds in cards:
        conn.execute("INSERT INTO notes VALUES (?, ?, ?, ?, 0, 0, '', '', 0, 0, '')", (nid, str(nid), mid, flds))
    conn.execute("CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, usn INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)")
    for idx, (nid, _, _) in enumerate(cards):
        conn.execute("INSERT INTO cards VALUES (?, ?, 1, 0, 0, 0, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')", (nid * 10, nid, idx))
    conn.commit()
    conn.close()
    with zipfile.ZipFile(path, "w") as zf:
        zf.write(db_path, "collection.anki2")
        zf.writestr("media", "{}")
    os.remove(db_path)


class TestBulkCreateCards:
    def test_bulk_create_on_new_deck(self):
        session, _ = DeckSession.create_new("TestDeck")
        try:
            rows = [["hello", "world"], ["foo", "bar"]]
            new_cards = session.bulk_create_cards(rows)
            assert len(new_cards) == 2
            assert new_cards[0]["fields"]["Front"] == "hello"
            assert new_cards[0]["fields"]["Back"] == "world"
            assert new_cards[1]["fields"]["Front"] == "foo"
            assert new_cards[1]["fields"]["Back"] == "bar"
        finally:
            session.close()

    def test_bulk_create_appends_to_existing(self, tmp_path):
        p = str(tmp_path / "test.apkg")
        _make_apkg(p)
        session = DeckSession(p)
        session.open()
        try:
            rows = [["new front", "new back"]]
            new_cards = session.bulk_create_cards(rows)
            assert len(new_cards) == 1
            assert new_cards[0]["fields"]["Front"] == "new front"
            # Verify total cards in DB
            count = session.conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            assert count == 2  # original + new
        finally:
            session.close()

    def test_bulk_create_pads_short_rows(self):
        session, _ = DeckSession.create_new("TestDeck")
        try:
            rows = [["only front"]]
            new_cards = session.bulk_create_cards(rows)
            assert new_cards[0]["fields"]["Front"] == "only front"
            assert new_cards[0]["fields"]["Back"] == ""
        finally:
            session.close()

    def test_bulk_create_ignores_extra_columns(self):
        session, _ = DeckSession.create_new("TestDeck")
        try:
            rows = [["front", "back", "extra", "more"]]
            new_cards = session.bulk_create_cards(rows)
            assert new_cards[0]["fields"]["Front"] == "front"
            assert new_cards[0]["fields"]["Back"] == "back"
            assert "extra" not in str(new_cards[0]["fields"])
        finally:
            session.close()

    def test_bulk_create_due_values_sequential(self, tmp_path):
        p = str(tmp_path / "test.apkg")
        _make_apkg(p)
        session = DeckSession(p)
        session.open()
        try:
            rows = [["a", "b"], ["c", "d"]]
            session.bulk_create_cards(rows)
            dues = [r[0] for r in session.conn.execute("SELECT due FROM cards ORDER BY due").fetchall()]
            assert dues == [0, 1, 2]  # original card at 0, new at 1 and 2
        finally:
            session.close()

    def test_bulk_create_returns_card_ord(self):
        session, _ = DeckSession.create_new("TestDeck")
        try:
            rows = [["a", "b"]]
            new_cards = session.bulk_create_cards(rows)
            assert "card_ord" in new_cards[0]
        finally:
            session.close()


class TestGetAllCards:
    def test_get_all_cards_matches_open(self, tmp_path):
        p = str(tmp_path / "test.apkg")
        _make_apkg(p)
        session = DeckSession(p)
        cards_from_open = session.open()
        cards_from_get = session.get_all_cards()
        assert len(cards_from_get) == len(cards_from_open)
        assert cards_from_get[0]["note_id"] == cards_from_open[0]["note_id"]
        assert cards_from_get[0]["fields"] == cards_from_open[0]["fields"]
        session.close()

    def test_get_all_cards_after_bulk_create(self, tmp_path):
        p = str(tmp_path / "test.apkg")
        _make_apkg(p)
        session = DeckSession(p)
        session.open()
        session.bulk_create_cards([["new", "card"]])
        all_cards = session.get_all_cards()
        assert len(all_cards) == 2
        session.close()


class TestImportExportRoundtrip:
    def test_bulk_created_cards_survive_export(self, tmp_path):
        """Cards created via bulk import can be exported and re-opened."""
        session, _ = DeckSession.create_new("RoundtripDeck")
        try:
            # Delete starter card
            starter = session.conn.execute("SELECT id FROM notes").fetchall()
            for note in starter:
                session.delete_card(note[0])
            session.bulk_create_cards([["hello", "world"], ["foo", "bar"]])
            out = str(tmp_path / "exported.apkg")
            result = session.export_apkg(out)
            assert result["ok"] is True
        finally:
            session.close()

        # Re-open and verify
        session2 = DeckSession(out)
        cards = session2.open()
        assert len(cards) == 2
        assert cards[0]["fields"]["Front"] == "hello"
        assert cards[1]["fields"]["Front"] == "foo"
        session2.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/angel/school/ankiLite && python -m pytest tests/test_text_import.py::TestBulkCreateCards tests/test_text_import.py::TestGetAllCards -v`
Expected: FAIL — `AttributeError: 'DeckSession' object has no attribute 'bulk_create_cards'`

- [ ] **Step 3: Implement `bulk_create_cards` and `get_all_cards`**

Add these methods to `DeckSession` class in `apkg_parser.py`, after the `delete_card` method (after line 774):

```python
    def bulk_create_cards(self, rows):
        """Bulk-insert cards from parsed text rows.

        Each row is a list of field values mapped positionally to the first model's fields.
        Returns list of newly created card dicts.
        """
        # Use first model
        model_id = next(iter(self.models))
        model = self.models[model_id]
        field_names = model["fields"]

        # Resolve deck_id
        row = self.conn.execute("SELECT did FROM cards LIMIT 1").fetchone()
        if row is not None:
            deck_id = row[0]
        elif self.deck_id is not None:
            deck_id = self.deck_id
        else:
            deck_id = 1

        # Get current max due
        max_due_row = self.conn.execute("SELECT MAX(due) FROM cards").fetchone()
        next_due = (max_due_row[0] + 1) if max_due_row[0] is not None else 0

        now = int(time.time())
        # Use max existing note_id + 1000 to avoid collisions with recently deleted IDs
        max_id_row = self.conn.execute("SELECT MAX(id) FROM notes").fetchone()
        base_id = max(int(time.time() * 1000), (max_id_row[0] or 0) + 1000)
        new_cards = []

        for i, text_row in enumerate(rows):
            note_id = base_id + (i * 2)
            card_id = note_id + 1
            guid = str(uuid.uuid4())[:10]

            # Map columns to fields positionally
            field_values = []
            for j in range(len(field_names)):
                if j < len(text_row):
                    field_values.append(text_row[j])
                else:
                    field_values.append("")
            flds = "\x1f".join(field_values)

            self.conn.execute(
                "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, -1, '', ?, '', 0, 0, '')",
                (note_id, guid, model_id, now, flds),
            )
            self.conn.execute(
                "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')",
                (card_id, note_id, deck_id, now, next_due + i),
            )

            fields = {}
            for j, name in enumerate(field_names):
                fields[name] = field_values[j] if j < len(field_values) else ""
            new_cards.append({
                "note_id": note_id,
                "model_id": model_id,
                "model": model["name"],
                "fields": fields,
                "tags": [],
                "created_ts": note_id // 1000,
                "mod_ts": now,
                "card_ord": 0,
            })

        self.conn.commit()
        return new_cards

    def get_all_cards(self):
        """Re-read all cards from DB in due order. Like open() but without extraction."""
        card_positions = {}
        card_ords = {}
        for row in self.conn.execute("SELECT nid, due, ord FROM cards ORDER BY due"):
            if row[0] not in card_positions:
                card_positions[row[0]] = row[1]
            if row[0] not in card_ords:
                card_ords[row[0]] = row[2]

        notes = self.conn.execute("SELECT id, mid, flds, mod, tags FROM notes").fetchall()
        cards = []
        for note in notes:
            note_id = note[0]
            mid = note[1]
            flds_raw = note[2]
            mod_ts = note[3]
            tags_raw = note[4]
            tags = [t for t in tags_raw.strip().split() if t] if tags_raw else []

            model = self.models.get(mid)
            if model is None:
                continue

            field_values = flds_raw.split("\x1f")
            field_names = model["fields"]

            fields = {}
            for i, name in enumerate(field_names):
                val = field_values[i] if i < len(field_values) else ""
                val = _strip_sound(val)
                val = _inline_images(val, self.tmp_dir, self.media_map, self._uri_to_filename)
                fields[name] = val

            cards.append({
                "note_id": note_id,
                "model_id": mid,
                "model": model["name"],
                "fields": fields,
                "tags": tags,
                "created_ts": note_id // 1000,
                "mod_ts": mod_ts,
                "card_ord": card_ords.get(note_id, 0),
            })

        cards.sort(key=lambda c: card_positions.get(c["note_id"], 0))
        return cards
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/angel/school/ankiLite && python -m pytest tests/test_text_import.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apkg_parser.py tests/test_text_import.py
git commit -m "feat: add bulk_create_cards and get_all_cards to DeckSession"
```

---

### Task 3: API methods in `main.py`

**Files:**
- Modify: `main.py:60-95` (add methods to `Api` class)

- [ ] **Step 1: Add `parse_text_file` and `import_text_cards` to `Api`**

Add these imports at the top of `main.py` (after `from apkg_parser import DeckSession`):

```python
from apkg_parser import parse_text_file
```

Add these methods to the `Api` class (after `delete_card`, around line 315):

```python
    def parse_text_file(self, path):
        """Parse a text/CSV file and return preview data."""
        try:
            return parse_text_file(path)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def import_text_cards(self, path, mode):
        """Import cards from a text file. mode is 'new' or 'current'."""
        try:
            parsed = parse_text_file(path)
            if not parsed["ok"]:
                return parsed
            rows = parsed["rows"]
            if not rows:
                return {"ok": False, "error": "No cards to import"}

            if mode == "new":
                self._close_session()
                filename = os.path.splitext(os.path.basename(path))[0]
                session, _ = DeckSession.create_new(filename)
                self.session = session
                # Delete the empty starter card
                starter_notes = session.conn.execute("SELECT id FROM notes").fetchall()
                for note in starter_notes:
                    session.delete_card(note[0])
                # Bulk insert the parsed rows
                session.bulk_create_cards(rows)
            elif mode == "current":
                if not self.session:
                    return {"ok": False, "error": "No deck is currently open"}
                self.session.bulk_create_cards(rows)
            else:
                return {"ok": False, "error": f"Unknown mode: {mode}"}

            all_cards = self.session.get_all_cards()
            models = {}
            for mid, model in self.session.models.items():
                models[str(mid)] = {
                    "name": model["name"],
                    "templates": model.get("templates", []),
                    "css": model.get("css", ""),
                }
            return {"ok": True, "cards": all_cards, "models": models}
        except Exception as e:
            return {"ok": False, "error": str(e)}
```

- [ ] **Step 2: Update `_on_drop` to handle text files**

In `main.py`, modify the `_on_drop` function (around line 329-341):

Replace:
```python
            if path and path.endswith(".apkg"):
                window.evaluate_js(
                    f"window._loadDeckFromPath({json.dumps(path)})"
                )
                return
```

With:
```python
            if path:
                if path.endswith(".apkg"):
                    window.evaluate_js(
                        f"window._loadDeckFromPath({json.dumps(path)})"
                    )
                    return
                elif path.lower().endswith((".txt", ".csv")):
                    window.evaluate_js(
                        f"window._loadTextFromPath({json.dumps(path)})"
                    )
                    return
```

- [ ] **Step 3: Update `open_file_dialog` to include text file types**

In `main.py`, modify `open_file_dialog` (around line 99-102):

Replace:
```python
            file_types=("Anki Package (*.apkg)",),
```

With:
```python
            file_types=("Anki Package (*.apkg)", "Text Files (*.txt;*.csv)"),
```

- [ ] **Step 4: Run all existing tests to verify nothing is broken**

Run: `cd /Users/angel/school/ankiLite && python -m pytest tests/ -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add main.py
git commit -m "feat: add text import API methods and update drop/dialog handlers"
```

---

### Task 4: Frontend — import preview overlay HTML and CSS

**Files:**
- Modify: `ui/index.html:11-13` (welcome text), `ui/index.html:128` (add overlay before loading div)
- Modify: `ui/style.css` (append new styles)

- [ ] **Step 1: Update welcome screen text in `index.html`**

In `ui/index.html` line 13, replace:
```html
      <p>Drop an <strong>.apkg</strong> file here to view cards</p>
```
With:
```html
      <p>Drop an <strong>.apkg</strong>, <strong>.txt</strong>, or <strong>.csv</strong> file here</p>
```

- [ ] **Step 2: Add import preview overlay to `index.html`**

In `ui/index.html`, add before the `<!-- Loading overlay -->` comment (before line 144):

```html
  <!-- Import preview dialog -->
  <div id="import-preview-overlay" class="hidden">
    <div id="import-preview-panel">
      <h3>Import Text File</h3>
      <p id="import-info"></p>
      <div id="import-sample"></div>
      <div id="import-target" class="hidden">
        <label><input type="radio" name="import_mode" value="current" checked> Add to current deck</label>
        <label><input type="radio" name="import_mode" value="new"> Create new deck</label>
      </div>
      <div class="confirm-buttons">
        <button id="btn-import-cancel">Cancel</button>
        <button id="btn-import-confirm">Import</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add import preview styles to `style.css`**

Append to `ui/style.css`:

```css
/* Import preview dialog */
#import-preview-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  z-index: 150;
}

#import-preview-panel {
  background: var(--card-bg);
  border-radius: 14px;
  padding: 28px 32px;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
}

#import-preview-panel h3 {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 8px;
}

#import-info {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}

#import-sample {
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

#import-sample table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

#import-sample th,
#import-sample td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#import-sample th {
  background: var(--bg);
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  position: sticky;
  top: 0;
}

#import-target {
  margin-bottom: 16px;
}

#import-target label {
  display: block;
  font-size: 14px;
  padding: 6px 0;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
}

#import-target input[type="radio"] {
  margin-right: 8px;
}

#btn-import-confirm {
  border: none;
  background: var(--accent);
  color: white;
}

#btn-import-confirm:hover {
  opacity: 0.85;
}
```

- [ ] **Step 4: Verify HTML/CSS renders (visual check)**

Run the app: `cd /Users/angel/school/ankiLite && python main.py`
Check: Welcome screen says ".apkg, .txt, or .csv". (The overlay won't be wired up yet.)

- [ ] **Step 5: Commit**

```bash
git add ui/index.html ui/style.css
git commit -m "feat: add import preview overlay HTML and CSS"
```

---

### Task 5: Frontend — JavaScript import logic

**Files:**
- Modify: `ui/app.js` (add new functions, update existing handlers)

- [ ] **Step 1: Add DOM references for import overlay elements**

In `ui/app.js`, add after the existing DOM references (around line 43, after `const tagsInput`):

```javascript
  const importPreviewOverlay = document.getElementById("import-preview-overlay");
  const importInfo = document.getElementById("import-info");
  const importSample = document.getElementById("import-sample");
  const importTarget = document.getElementById("import-target");
  const btnImportCancel = document.getElementById("btn-import-cancel");
  const btnImportConfirm = document.getElementById("btn-import-confirm");
```

Add module-level variable (after `let selectedFilterTags = [];`):

```javascript
  let pendingImportPath = null;
```

- [ ] **Step 2: Add `_loadTextFromPath` and `confirmImport` functions**

Add before the `// ── Drag and drop ──` section (around line 1218):

```javascript
  // ── Text file import ──

  window._loadTextFromPath = async function (path) {
    try {
      const result = await pywebview.api.parse_text_file(path);
      if (!result.ok) {
        alert("Error parsing file: " + result.error);
        return;
      }
      pendingImportPath = path;

      // Build info line
      var delimNames = {tab: "tab-separated", semicolon: "semicolon-separated", comma: "comma-separated"};
      var info = "Found " + result.rows.length + " cards (" + (delimNames[result.delimiter] || result.delimiter) + ")";
      if (result.has_header && result.header_row) {
        info += "<br>Header detected: " + result.header_row.map(escapeHtml).join(", ");
      }
      importInfo.innerHTML = info;

      // Build sample table (first 5 rows)
      var sampleRows = result.rows.slice(0, 5);
      var numCols = result.num_fields;
      var tableHtml = "<table><thead><tr>";
      for (var c = 0; c < numCols; c++) {
        var header = (result.has_header && result.header_row && result.header_row[c])
          ? escapeHtml(result.header_row[c])
          : "Field " + (c + 1);
        tableHtml += "<th>" + header + "</th>";
      }
      tableHtml += "</tr></thead><tbody>";
      sampleRows.forEach(function (row) {
        tableHtml += "<tr>";
        for (var c = 0; c < numCols; c++) {
          tableHtml += "<td>" + escapeHtml(row[c] || "") + "</td>";
        }
        tableHtml += "</tr>";
      });
      if (result.rows.length > 5) {
        tableHtml += '<tr><td colspan="' + numCols + '" style="text-align:center;color:var(--text-secondary);font-style:italic;">... and ' + (result.rows.length - 5) + ' more</td></tr>';
      }
      tableHtml += "</tbody></table>";
      importSample.innerHTML = tableHtml;

      // Show/hide import target radios
      if (!viewer.classList.contains("hidden") && cards.length > 0) {
        importTarget.classList.remove("hidden");
      } else {
        importTarget.classList.add("hidden");
      }

      importPreviewOverlay.classList.remove("hidden");
    } catch (e) {
      alert("Failed to parse text file: " + e);
    }
  };

  async function confirmImport() {
    var mode = "new";
    if (!importTarget.classList.contains("hidden")) {
      var checked = document.querySelector('input[name="import_mode"]:checked');
      if (checked) mode = checked.value;
    }

    importPreviewOverlay.classList.add("hidden");
    loading.classList.remove("hidden");

    try {
      var result = await pywebview.api.import_text_cards(pendingImportPath, mode);
      if (!result.ok) {
        showToast("Import failed: " + result.error);
        return;
      }
      cards = result.cards;
      models = result.models || {};

      // Reset filter/sort/search
      searchInput.value = "";
      filterImages.value = "all";
      sortOrder.value = "original";
      selectedFilterTags = [];
      displayCards = cards.slice();

      deckTitle.textContent = cards.length + " cards";
      buildSidebar();
      buildTagFilterBar();

      dropZone.classList.add("hidden");
      viewer.classList.remove("hidden");
      if (cards.length > 0) showCard(0);
      showToast("Imported " + cards.length + " cards");
    } catch (e) {
      alert("Import failed: " + e);
    } finally {
      loading.classList.add("hidden");
      pendingImportPath = null;
    }
  }

  btnImportCancel.addEventListener("click", function () {
    importPreviewOverlay.classList.add("hidden");
    pendingImportPath = null;
  });

  btnImportConfirm.addEventListener("click", confirmImport);
```

- [ ] **Step 3: Update file dialog routing in `btnOpen` click handler**

In `ui/app.js`, find the `btnOpen` click handler (around line 1249-1258). Replace:

```javascript
      if (path) {
        loadDeck(path);
      }
```

With:

```javascript
      if (path) {
        if (path.toLowerCase().endsWith(".txt") || path.toLowerCase().endsWith(".csv")) {
          window._loadTextFromPath(path);
        } else {
          loadDeck(path);
        }
      }
```

- [ ] **Step 4: Add Escape handler for import overlay**

In `ui/app.js`, find the global keydown handler (around line 1324). Add this block after the create-deck-overlay Escape handler (after line 1331):

```javascript
    // Handle Escape for import preview dialog
    if (!importPreviewOverlay.classList.contains("hidden")) {
      if (e.key === "Escape") {
        importPreviewOverlay.classList.add("hidden");
        pendingImportPath = null;
      }
      return;
    }
```

- [ ] **Step 5: Run the app and test end-to-end**

Run: `cd /Users/angel/school/ankiLite && python main.py`
Create a test file: `echo -e "hello\tworld\nfoo\tbar" > /tmp/test_cards.txt`
Test:
1. Drop `test_cards.txt` on the app → preview dialog appears with 2 cards, tab-separated
2. Click Import → new deck created with 2 cards
3. Click "New Deck" to go back, open again via file dialog selecting a `.csv` file
4. With a deck loaded, drop another `.txt` → radio buttons appear for "Add to current deck" vs "Create new deck"
5. Press Escape to dismiss import dialog

- [ ] **Step 6: Run all tests**

Run: `cd /Users/angel/school/ankiLite && python -m pytest tests/ -v`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add ui/app.js
git commit -m "feat: add text import JS logic with preview dialog and file routing"
```
