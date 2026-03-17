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
