"""Tests for text file import — parsing, bulk creation, and card retrieval."""

import json
import os
import sqlite3
import zipfile
import pytest
from apkg_parser import parse_text_file, DeckSession


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


def _make_apkg(path, cards=None):
    """Build a minimal .apkg fixture."""
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
            count = session.conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            assert count == 2
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
            assert dues == [0, 1, 2]
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
            starter = session.conn.execute("SELECT id FROM notes").fetchall()
            for note in starter:
                session.delete_card(note[0])
            session.bulk_create_cards([["hello", "world"], ["foo", "bar"]])
            out = str(tmp_path / "exported.apkg")
            result = session.export_apkg(out)
            assert result["ok"] is True
        finally:
            session.close()

        session2 = DeckSession(out)
        cards = session2.open()
        assert len(cards) == 2
        assert cards[0]["fields"]["Front"] == "hello"
        assert cards[1]["fields"]["Front"] == "foo"
        session2.close()
