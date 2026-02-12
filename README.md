# ankiLite

A lightweight desktop viewer and editor for Anki `.apkg` flashcard decks. Open any `.apkg` file to browse, edit, and manage your cards in a clean native window — no Anki installation required.

## Features

- **Open any `.apkg` file** — drag-and-drop or file dialog, supports all Anki deck formats (`.anki2`, `.anki21`, `.anki21b` with zstd compression)
- **Recent files** — quickly reopen previously loaded decks from the drop zone
- **Browse cards** — sidebar lists all cards with previews; arrow keys for quick navigation
- **Create & delete cards** — add new cards or remove existing ones without leaving the app
- **Inline editing** — click any field to edit text and HTML directly; changes save automatically
- **Image management** — paste from clipboard, add from file (`+img` button), copy to clipboard, or select and delete with backspace
- **Filter & sort** — filter cards by image content, sort by creation or modification date
- **Save options** — save as a new `.apkg` or overwrite the original, with configurable default behavior
- **Settings** — configure default save mode (copy vs overwrite) and quit-on-save; persisted in `~/.ankiLite/settings.json`
- **Zero config** — single `python main.py` to launch; no database setup, no accounts

## Install

```bash
git clone https://github.com/angelmz/ankiLite
cd ankiLite
pip install -r requirements.txt
```

### Requirements

- Python 3.6+
- [pywebview](https://pywebview.flowrl.com/) 5.0+ (native window)
- [zstandard](https://pypi.org/project/zstandard/) 0.20+ (for `.anki21b` format support)

## Usage

```bash
python main.py
```

Drop an `.apkg` file onto the window, click **Open File** to browse, or pick a deck from **Recent**.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `←` `↑` | Previous card |
| `→` `↓` | Next card |
| `Cmd+V` | Paste image from clipboard |
| `Cmd+C` | Copy selected image to clipboard |
| `Backspace` / `Delete` | Remove selected image |
| `Escape` | Stop editing a field / dismiss dialogs |

### Filtering and sorting

Use the dropdowns in the sidebar toolbar to:

- **Filter** — show all cards, only cards with images, or only cards without images
- **Sort** — original order, newest/oldest created, or newest/oldest modified

The header updates to show how many cards match (e.g. "12 of 50 cards").

## Architecture

```
main.py                 App entry point, pywebview window + JS API bridge
apkg_parser.py          .apkg extraction, SQLite parsing, media inlining, card CRUD, export
settings.py             User preferences (~/.ankiLite/settings.json), recent files tracking
ui/
  index.html            Single-page app shell
  style.css             All styles
  app.js                Frontend logic (rendering, filtering, editing, card management)
  marked.min.js         Markdown renderer (vendored)
tests/
  test_deck_session.py  Backend tests for parsing, editing, card CRUD, export
  test_settings.py      Settings persistence tests
```

### Data flow

1. User drops/selects `.apkg` file (or picks from recent files)
2. Python extracts ZIP, opens SQLite, inlines media as base64 data URIs
3. Card dicts are returned to JS with fields, timestamps, and model info
4. Frontend renders cards with filter/sort controls; edits call back to Python
5. Creating/deleting cards updates SQLite in real time
6. On save, Python de-inlines base64 back to media files and rebuilds the `.apkg` ZIP

## Tests

```bash
python -m pytest tests/ -v
```

## License

MIT
