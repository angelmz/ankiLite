"""Tests for settings module."""

import json
import os

from settings import DEFAULTS, load_settings, save_settings


class TestSettings:
    def test_default_settings(self, tmp_path):
        """No file on disk → returns defaults."""
        result = load_settings(config_dir=str(tmp_path))
        assert result == DEFAULTS

    def test_save_and_load_roundtrip(self, tmp_path):
        """Save then load returns updated values."""
        settings = {"save_mode": "overwrite"}
        save_settings(settings, config_dir=str(tmp_path))
        result = load_settings(config_dir=str(tmp_path))
        assert result["save_mode"] == "overwrite"

    def test_load_corrupt_json_returns_defaults(self, tmp_path):
        """Corrupt JSON falls back to defaults gracefully."""
        path = os.path.join(str(tmp_path), "settings.json")
        with open(path, "w") as f:
            f.write("not valid json {{{")
        result = load_settings(config_dir=str(tmp_path))
        assert result == DEFAULTS

    def test_save_creates_directory(self, tmp_path):
        """Creates config directory if missing."""
        nested = os.path.join(str(tmp_path), "sub", "dir")
        save_settings({"save_mode": "copy"}, config_dir=nested)
        assert os.path.isfile(os.path.join(nested, "settings.json"))

    def test_partial_settings_merged_with_defaults(self, tmp_path):
        """Missing keys get filled from defaults."""
        path = os.path.join(str(tmp_path), "settings.json")
        with open(path, "w") as f:
            json.dump({"extra_key": "hello"}, f)
        result = load_settings(config_dir=str(tmp_path))
        assert result["save_mode"] == DEFAULTS["save_mode"]
        assert result["extra_key"] == "hello"
