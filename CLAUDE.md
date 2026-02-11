# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ankiLite is a lightweight desktop Anki `.apkg` card viewer built with pywebview. Users can open or drag-and-drop `.apkg` files to browse flashcards in a native window.

## Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run the app
python main.py
```

## Architecture

**Python backend** (`main.py`) — Creates a pywebview window and exposes a `js_api` (`Api` class) to the frontend. Handles native file dialogs and drag-and-drop via pywebview's DOM API.

**APKG parser** (`apkg_parser.py`) — Extracts `.apkg` ZIP to a temp dir, opens the SQLite database inside (supports `collection.anki21b` zstd-compressed, `.anki21`, and `.anki2` formats), detects modern vs legacy schema for note type/field definitions, and returns cards as dicts with fields. Media images are inlined as base64 data URIs; `[sound:...]` references are stripped.

**Frontend** (`ui/`) — Single-page app with vanilla JS. Card content containing HTML tags is rendered as-is; plain text is rendered as markdown via `marked.min.js`. The sidebar lists cards (first field as title, second as subtitle); arrow keys navigate between cards.

### Data flow

1. User drops/selects `.apkg` → Python `_on_drop` or `open_file_dialog` fires
2. Python calls `window.evaluate_js("window._loadDeckFromPath(...)")` (drop) or returns path (dialog)
3. JS calls `pywebview.api.load_apkg(path)` → Python `parse_apkg()` runs
4. `parse_apkg` extracts ZIP, reads SQLite, inlines media, returns `{ok, cards}` to JS
5. JS builds sidebar and renders card fields

### Dependencies

- **pywebview >=5.0** — native window with JS bridge
- **zstandard >=0.20.0** — decompresses `.anki21b` format (optional; gracefully degrades)
