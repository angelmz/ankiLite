"""Persist user preferences in ~/.ankiLite/settings.json."""

import json
import os

DEFAULTS = {"save_mode": "copy"}

_DEFAULT_DIR = os.path.join(os.path.expanduser("~"), ".ankiLite")


def load_settings(config_dir=None):
    """Load settings from disk, falling back to DEFAULTS on any error."""
    config_dir = config_dir or _DEFAULT_DIR
    path = os.path.join(config_dir, "settings.json")
    settings = dict(DEFAULTS)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        if isinstance(data, dict):
            settings.update(data)
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return settings


def save_settings(settings, config_dir=None):
    """Write settings dict to disk, creating the directory if needed."""
    config_dir = config_dir or _DEFAULT_DIR
    os.makedirs(config_dir, exist_ok=True)
    path = os.path.join(config_dir, "settings.json")
    with open(path, "w") as f:
        json.dump(settings, f, indent=2)
