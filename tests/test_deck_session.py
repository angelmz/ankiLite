"""Tests for DeckSession — open, add_image, export, close."""

import json
import os
import sqlite3
import tempfile
import threading
import zipfile

import pytest

from apkg_parser import DeckSession


def _make_apkg(path, cards=None, wal_mode=False):
    """Build a minimal .apkg fixture at *path*.

    *cards* is a list of (note_id, model_id, flds_string) tuples.
    Defaults to one note with two fields: "Capital of France?" / "Paris".
    If *wal_mode* is True the DB inside the ZIP uses WAL journal mode.
    """
    if cards is None:
        cards = [(1, 1, "Capital of France?\x1fParis")]

    db_path = path + ".db"
    conn = sqlite3.connect(db_path)
    if wal_mode:
        conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT)"
    )
    models = {
        "1": {
            "name": "Basic",
            "flds": [
                {"name": "Front", "ord": 0},
                {"name": "Back", "ord": 1},
            ],
        }
    }
    conn.execute("INSERT INTO col VALUES (1, ?)", (json.dumps(models),))
    conn.execute(
        "CREATE TABLE notes "
        "(id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT, mod INTEGER, usn INTEGER)"
    )
    for nid, mid, flds in cards:
        conn.execute(
            "INSERT INTO notes VALUES (?, ?, ?, 0, 0)", (nid, mid, flds)
        )
    conn.execute(
        "CREATE TABLE cards "
        "(id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER)"
    )
    for nid, _, _ in cards:
        conn.execute("INSERT INTO cards VALUES (?, ?, 1, 0)", (nid * 10, nid))
    conn.commit()
    conn.close()

    with zipfile.ZipFile(path, "w") as zf:
        zf.write(db_path, "collection.anki2")
        # Include WAL sidecar if it exists (WAL mode)
        wal_path = db_path + "-wal"
        if os.path.exists(wal_path):
            zf.write(wal_path, "collection.anki2-wal")
        zf.writestr("media", "{}")

    os.remove(db_path)
    wal_path = db_path + "-wal"
    if os.path.exists(wal_path):
        os.remove(wal_path)
    shm_path = db_path + "-shm"
    if os.path.exists(shm_path):
        os.remove(shm_path)


@pytest.fixture()
def apkg_file(tmp_path):
    """Create a disposable .apkg fixture and return its path."""
    p = str(tmp_path / "test.apkg")
    _make_apkg(p)
    return p


@pytest.fixture()
def apkg_file_wal(tmp_path):
    """Create a disposable .apkg fixture with WAL journal mode."""
    p = str(tmp_path / "test_wal.apkg")
    _make_apkg(p, wal_mode=True)
    return p


class TestDeckSession:
    def test_open_returns_cards(self, apkg_file):
        session = DeckSession(apkg_file)
        try:
            cards = session.open()
            assert len(cards) == 1
            assert cards[0]["fields"]["Front"] == "Capital of France?"
            assert cards[0]["fields"]["Back"] == "Paris"
        finally:
            session.close()

    def test_add_image_cross_thread(self, apkg_file):
        """Open in main thread, call add_image from a background thread."""
        session = DeckSession(apkg_file)
        session.open()
        result = {}
        error = []

        def worker():
            try:
                result.update(
                    session.add_image(1, "Back", b"\x89PNG fake", ".png")
                )
            except Exception as exc:
                error.append(exc)

        t = threading.Thread(target=worker)
        t.start()
        t.join()
        session.close()

        assert not error, f"Cross-thread add_image raised: {error[0]}"
        assert result.get("ok") is True
        assert "data_uri" in result

    def test_add_image_appends_to_field(self, apkg_file):
        session = DeckSession(apkg_file)
        session.open()
        result = session.add_image(1, "Back", b"\x89PNG fake", ".png")
        assert result["ok"] is True
        assert result["data_uri"].startswith("data:image/png;base64,")

        # Verify DB was updated
        row = session.conn.execute(
            "SELECT flds FROM notes WHERE id = 1"
        ).fetchone()
        fields = row[0].split("\x1f")
        assert "<img src=" in fields[1]
        session.close()

    def test_export_roundtrip(self, apkg_file, tmp_path):
        session = DeckSession(apkg_file)
        session.open()
        session.add_image(1, "Back", b"\x89PNG fake", ".png")
        out = str(tmp_path / "exported.apkg")
        result = session.export_apkg(out)
        assert result["ok"] is True
        session.close()

        # Re-open and verify
        session2 = DeckSession(out)
        cards = session2.open()
        assert "<img src=" in cards[0]["fields"]["Back"]
        session2.close()

    def test_remove_image(self, apkg_file):
        session = DeckSession(apkg_file)
        session.open()
        session.add_image(1, "Back", b"\x89PNG img1", ".png")
        session.add_image(1, "Back", b"\x89PNG img2", ".png")

        # Remove the first image (index 0)
        result = session.remove_image(1, "Back", 0)
        assert result["ok"] is True

        row = session.conn.execute(
            "SELECT flds FROM notes WHERE id = 1"
        ).fetchone()
        fields = row[0].split("\x1f")
        # Only the second image should remain
        assert fields[1].count("<img") == 1
        assert "paste_1" in fields[1]
        session.close()

    def test_remove_image_cross_thread(self, apkg_file):
        """Open in main thread, call remove_image from a background thread."""
        session = DeckSession(apkg_file)
        session.open()
        session.add_image(1, "Back", b"\x89PNG fake", ".png")
        result = {}
        error = []

        def worker():
            try:
                result.update(session.remove_image(1, "Back", 0))
            except Exception as exc:
                error.append(exc)

        t = threading.Thread(target=worker)
        t.start()
        t.join()
        session.close()

        assert not error, f"Cross-thread remove_image raised: {error[0]}"
        assert result.get("ok") is True

    def test_update_field_changes_text(self, apkg_file):
        session = DeckSession(apkg_file)
        session.open()
        result = session.update_field(1, "Back", "Lyon")
        assert result["ok"] is True
        row = session.conn.execute(
            "SELECT flds FROM notes WHERE id = 1"
        ).fetchone()
        assert row[0].split("\x1f")[1] == "Lyon"
        session.close()

    def test_update_field_preserves_other_fields(self, apkg_file):
        session = DeckSession(apkg_file)
        session.open()
        session.update_field(1, "Back", "Lyon")
        row = session.conn.execute(
            "SELECT flds FROM notes WHERE id = 1"
        ).fetchone()
        fields = row[0].split("\x1f")
        assert fields[0] == "Capital of France?"
        assert fields[1] == "Lyon"
        session.close()

    def test_update_field_nonexistent_note(self, apkg_file):
        session = DeckSession(apkg_file)
        session.open()
        result = session.update_field(999, "Back", "nope")
        assert result["ok"] is False
        assert "not found" in result["error"].lower()
        session.close()

    def test_update_field_nonexistent_field(self, apkg_file):
        session = DeckSession(apkg_file)
        session.open()
        result = session.update_field(1, "NoSuchField", "nope")
        assert result["ok"] is False
        assert "not found" in result["error"].lower()
        session.close()

    def test_update_field_roundtrip_export(self, apkg_file, tmp_path):
        session = DeckSession(apkg_file)
        session.open()
        session.update_field(1, "Back", "Marseille")
        out = str(tmp_path / "edited.apkg")
        session.export_apkg(out)
        session.close()

        session2 = DeckSession(out)
        cards = session2.open()
        assert cards[0]["fields"]["Back"] == "Marseille"
        session2.close()

    def test_export_overwrite_original(self, apkg_file):
        """Exporting to the original apkg_path works (temp copy is independent)."""
        session = DeckSession(apkg_file)
        session.open()
        session.update_field(1, "Back", "Nice")
        result = session.export_apkg(session.apkg_path)
        assert result["ok"] is True
        session.close()

        session2 = DeckSession(apkg_file)
        cards = session2.open()
        assert cards[0]["fields"]["Back"] == "Nice"
        session2.close()

    def test_open_returns_timestamps(self, apkg_file):
        session = DeckSession(apkg_file)
        try:
            cards = session.open()
            assert "created_ts" in cards[0]
            assert "mod_ts" in cards[0]
        finally:
            session.close()

    def test_timestamps_with_realistic_ids(self, tmp_path):
        p = str(tmp_path / "ts.apkg")
        _make_apkg(p, cards=[(1678901234567, 1, "Q\x1fA")])
        session = DeckSession(p)
        try:
            cards = session.open()
            assert cards[0]["created_ts"] == 1678901234
        finally:
            session.close()

    def test_mod_ts_updates_after_edit(self, apkg_file):
        session = DeckSession(apkg_file)
        try:
            session.open()
            session.update_field(1, "Back", "Updated")
            row = session.conn.execute(
                "SELECT mod FROM notes WHERE id = 1"
            ).fetchone()
            assert row[0] > 0
        finally:
            session.close()

    def test_close_cleans_up(self, apkg_file):
        session = DeckSession(apkg_file)
        session.open()
        tmp_dir = session.tmp_dir
        assert os.path.isdir(tmp_dir)
        session.close()
        assert not os.path.exists(tmp_dir)

    def test_export_roundtrip_wal_mode(self, apkg_file_wal, tmp_path):
        """Images survive export from a WAL-mode DB."""
        session = DeckSession(apkg_file_wal)
        session.open()
        session.add_image(1, "Back", b"\x89PNG fake", ".png")
        out = str(tmp_path / "exported_wal.apkg")
        result = session.export_apkg(out)
        assert result["ok"] is True
        session.close()

        session2 = DeckSession(out)
        cards = session2.open()
        assert "<img src=" in cards[0]["fields"]["Back"]
        session2.close()

    def test_add_image_then_update_field_roundtrip(self, apkg_file, tmp_path):
        """Simulates paste then blur: add_image + update_field + export preserves images."""
        session = DeckSession(apkg_file)
        session.open()
        res = session.add_image(1, "Back", b"\x89PNG fake", ".png")
        assert res["ok"] is True
        data_uri = res["data_uri"]

        # Simulate blur: JS sends HTML with data URI back
        new_value = 'Paris<img src="' + data_uri + '">'
        session.update_field(1, "Back", new_value)

        # Verify DB stores filename, not data URI
        row = session.conn.execute(
            "SELECT flds FROM notes WHERE id = 1"
        ).fetchone()
        db_back = row[0].split("\x1f")[1]
        assert "paste_" in db_back
        assert "data:" not in db_back

        out = str(tmp_path / "blur_export.apkg")
        session.export_apkg(out)
        session.close()

        # Image survives export + reopen
        session2 = DeckSession(out)
        cards = session2.open()
        back = cards[0]["fields"]["Back"]
        assert "<img src=" in back
        assert "Paris" in back
        session2.close()

    def test_deinline_field_replaces_known_uris(self, apkg_file):
        """_deinline_field() converts data URIs to filenames."""
        session = DeckSession(apkg_file)
        session.open()
        res = session.add_image(1, "Back", b"\x89PNG fake", ".png")
        data_uri = res["data_uri"]

        html = f'text<img src="{data_uri}">more'
        result = session._deinline_field(html)
        assert "paste_" in result
        assert "data:" not in result
        session.close()

    def test_update_field_deinlines_after_paste(self, apkg_file):
        """DB stores filenames not data URIs after paste+blur."""
        session = DeckSession(apkg_file)
        session.open()
        res = session.add_image(1, "Back", b"\x89PNG fake", ".png")
        data_uri = res["data_uri"]

        session.update_field(1, "Back", f'Paris<img src="{data_uri}">')
        row = session.conn.execute(
            "SELECT flds FROM notes WHERE id = 1"
        ).fetchone()
        back = row[0].split("\x1f")[1]
        assert "paste_" in back
        assert "data:" not in back
        session.close()

    def test_multiple_images_persist_roundtrip(self, apkg_file, tmp_path):
        """Multiple pasted images all survive export + reopen."""
        session = DeckSession(apkg_file)
        session.open()
        session.add_image(1, "Back", b"\x89PNG img1", ".png")
        session.add_image(1, "Back", b"\x89PNG img2", ".png")

        out = str(tmp_path / "multi_img.apkg")
        session.export_apkg(out)
        session.close()

        session2 = DeckSession(out)
        cards = session2.open()
        back = cards[0]["fields"]["Back"]
        assert back.count("<img") == 2
        session2.close()

    def test_export_overwrite_preserves_images(self, apkg_file):
        """Overwrite save mode preserves images."""
        session = DeckSession(apkg_file)
        session.open()
        session.add_image(1, "Back", b"\x89PNG fake", ".png")
        result = session.export_apkg(session.apkg_path)
        assert result["ok"] is True
        session.close()

        session2 = DeckSession(apkg_file)
        cards = session2.open()
        assert "<img src=" in cards[0]["fields"]["Back"]
        session2.close()

    def test_wal_mode_changed_to_delete_after_open(self, apkg_file_wal):
        """Journal mode is DELETE after opening a WAL-mode DB."""
        session = DeckSession(apkg_file_wal)
        session.open()
        row = session.conn.execute("PRAGMA journal_mode").fetchone()
        assert row[0] == "delete"
        session.close()
