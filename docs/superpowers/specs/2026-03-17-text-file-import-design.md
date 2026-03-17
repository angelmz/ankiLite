# Text File Import for ankiLite

## Summary

Allow users to drop or open `.txt` and `.csv` files to create Anki cards, similar to Anki desktop's text import. Supports tab, semicolon, and comma delimiters with auto-detection. Shows a preview dialog before importing. Can create a new deck or add to the currently open deck.

## Requirements

- **Formats:** Tab-separated, semicolon-separated, comma-separated with auto-detection
- **Header detection:** Auto-detect if first row is a header (skip it) or card data (keep it)
- **Field mapping:** Positional — first column = first field, second = second field, etc.
- **Import target:** If a deck is open, user chooses "add to current" or "create new"; if no deck open, creates new
- **Preview:** Show a dialog with detected delimiter, card count, and sample rows before confirming
- **Integration:** Imported cards are regular session cards — editing, saving, exporting all work as-is

## Design

### 1. Text file parsing — `parse_text_file(path)` in `apkg_parser.py`

New standalone function added to the existing parser module.

**Encoding:** Read as UTF-8 (handle BOM). Fall back to latin-1 if UTF-8 decode fails.

**Delimiter detection (consistency-based):**
1. Read all non-empty lines
2. For each candidate delimiter (`\t`, `;`, `,`): count how many lines produce the same column count (>1 column) when split by that delimiter
3. Pick the delimiter with the highest consistency count
4. Tie-break: prefer tab > semicolon > comma

**Parsing:** Use Python `csv.reader` with the detected delimiter. Skip empty rows. Strip whitespace from each cell.

**Header detection:** The first row is treated as a header if:
- It has the same column count as the majority of data rows, AND
- At least one cell (case-insensitive) matches common field names: `front`, `back`, `question`, `answer`, `term`, `definition`, `prompt`, `response`

If detected as header, it is separated from the data rows.

**Return value:**
```python
{
    "ok": True,
    "rows": [["col1", "col2", ...], ...],  # data rows (no header)
    "delimiter": "\t",                       # detected delimiter name
    "has_header": True,                      # whether header was detected
    "header_row": ["Front", "Back"],         # the header row if detected, else None
    "num_fields": 2                          # max columns across all rows
}
```

### 2. API methods — `Api` class in `main.py`

**`parse_text_file(path)`**
- Calls the parser function
- Returns the preview data to JS

**`import_text_cards(path, mode)`** — Takes the file path (not rows) and mode string. Python re-parses the file to avoid passing large arrays over the JS bridge.
- Calls `self._close_session()` first if `mode="new"` (prevents temp dir leaks).
- `mode="new"`: Calls `DeckSession.create_new(filename_stem)`, sets `self.session`, then deletes the empty starter card that `create_new` inserts, then calls `self.session.bulk_create_cards(rows)`. Returns `{ok, cards, models}`.
- `mode="current"`: Requires `self.session` to exist. Calls `self.session.bulk_create_cards(rows)`. Returns `{ok, cards, models}` with the full updated card list.

New `DeckSession` method: **`bulk_create_cards(rows)`**
- Takes a list of `[col1, col2, ...]` rows
- Uses the first model in `self.models`
- Resolves `deck_id` from existing cards (`SELECT did FROM cards LIMIT 1`) or falls back to `self.deck_id` (same pattern as existing `create_card`)
- For each row: generate note_id, card_id, guid; map columns positionally to fields (pad with empty strings if row has fewer columns than model fields; ignore extra columns); insert into `notes` and `cards` tables
- Sequential due values starting after current max
- Single `conn.commit()` at the end
- Returns the list of newly created card dicts (including `card_ord`)

New `DeckSession` method: **`get_all_cards()`**
- Reads all notes + cards from DB and returns card dicts in due order (same format as `open()` but without ZIP extraction, media map loading, or due normalization — those are already done)
- Used by `import_text_cards` to return the full card list after bulk insert

### 3. Frontend changes

**`main.py` — `_on_drop` handler:**
- Currently checks `path.endswith(".apkg")`. Extend to also handle `.txt` and `.csv`:
  ```python
  if path.endswith(".apkg"):
      window.evaluate_js(f"window._loadDeckFromPath({json.dumps(path)})")
  elif path.endswith((".txt", ".csv")):
      window.evaluate_js(f"window._loadTextFromPath({json.dumps(path)})")
  ```

**`main.py` — `open_file_dialog`:**
- Add text file types: `file_types=("Anki Package (*.apkg)", "Text Files (*.txt;*.csv)")`
- Returns the path as before; the JS caller must check the extension and route to `loadDeck()` or `_loadTextFromPath()` accordingly

**`ui/index.html` — New import preview overlay:**
```html
<div id="import-preview-overlay" class="hidden">
  <div id="import-preview-panel">
    <h3>Import Text File</h3>
    <p id="import-info"><!-- e.g. "Found 42 cards (tab-separated)" --></p>
    <div id="import-sample"><!-- sample table --></div>
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

**`ui/app.js` — New functions:**

`window._loadTextFromPath(path)`:
1. Call `pywebview.api.parse_text_file(path)`
2. Store parsed result and path in module-level variables
3. Populate and show the import preview overlay:
   - Info line: "Found N cards (tab/semicolon/comma-separated)"
   - If `has_header`: note "Header detected: Front, Back"
   - Sample table: first 5 rows rendered as an HTML table
   - Show import target radios only if a deck session is currently open

`confirmImport()`:
1. Read selected mode from radios (default "new" if no deck open)
2. Call `pywebview.api.import_text_cards(storedPath, mode)`
3. On success: hide overlay, call existing deck-rendering logic with returned cards/models
4. On error: show toast with error message

**JS file dialog routing (`btnOpen` click handler):**
- After `open_file_dialog()` returns a path, check extension:
  - `.apkg` → `loadDeck(path)`
  - `.txt` / `.csv` → `_loadTextFromPath(path)`

**Escape key handling:**
- Add the import preview overlay to the existing global keydown Escape handler (same pattern as delete-confirm and create-deck overlays)

**Welcome screen text:**
- Update drop zone text from "Drop an .apkg file here" to also mention `.txt` / `.csv` files

**`ui/style.css`:**
- Style `#import-preview-panel` matching existing dialog styles (reuse `.confirm-buttons`, panel sizing pattern from delete/create dialogs)
- Style the sample table: bordered, small font, max-height with scroll, max 5 rows

### 4. Data flow

```
User drops .txt/.csv
  → Python _on_drop → evaluate_js("_loadTextFromPath(...)")
  → JS calls pywebview.api.parse_text_file(path)
  → Python reads file, detects delimiter/header, returns preview data
  → JS shows import preview dialog
  → User clicks Import
  → JS calls pywebview.api.import_text_cards(path, mode)
  → Python re-parses file, bulk-creates cards (new deck or current session)
  → Python returns {ok, cards, models}
  → JS renders deck with standard showDeck logic
```

### 5. Edge cases

- **Empty file:** Parser returns `{ok: false, error: "File is empty"}`
- **Single-column file:** Creates cards with only the first field populated
- **Mismatched column counts:** Pad short rows with empty strings, ignore extra columns beyond model field count
- **Large files:** Python re-parses the file on import (not passed over JS bridge), so size is only limited by memory. Preview only shows first 5 rows regardless.
- **Binary/non-text files:** UTF-8 decode failure caught, falls back to latin-1; if still garbage, user sees it in preview and can cancel
- **File dialog returns .txt when user expected .apkg:** File dialog now shows both types in separate filters, so intent is clear
