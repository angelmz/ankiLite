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

**Delimiter detection:**
1. Read all non-empty lines
2. If any line contains a tab character → delimiter is `\t`
3. Else if any line contains a semicolon → delimiter is `;`
4. Else → delimiter is `,`

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

**`import_text_cards(rows, mode)`**
- `mode="new"`: Calls `DeckSession.create_new(filename_stem)`, then bulk-inserts all rows as cards using the Basic model. Returns `{ok, cards, models}`.
- `mode="current"`: Requires `self.session` to exist. Uses the first model in the session. For each row, creates a note + card in the DB (bulk insert, single commit). Returns `{ok, cards, models}` with the full updated card list.

Bulk insert logic (shared by both modes):
- Get the target model and its field names
- For each row: generate note_id, card_id, guid; map columns positionally to fields (pad with empty strings if row has fewer columns than model fields; ignore extra columns); insert into `notes` and `cards` tables
- Single `conn.commit()` at the end
- Return all cards in the session (re-read from DB to get consistent state)

New `DeckSession` method: **`bulk_create_cards(rows)`**
- Takes a list of `[col1, col2, ...]` rows
- Uses the first model in `self.models`
- Inserts notes + cards with sequential due values starting after current max
- Commits once
- Returns the list of newly created card dicts

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
2. Call `pywebview.api.import_text_cards(storedRows, mode)`
3. On success: hide overlay, call existing deck-rendering logic with returned cards/models
4. On error: show toast with error message

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
  → JS calls pywebview.api.import_text_cards(rows, mode)
  → Python bulk-creates cards (new deck or current session)
  → Python returns {ok, cards, models}
  → JS renders deck with standard showDeck logic
```

### 5. Edge cases

- **Empty file:** Parser returns `{ok: false, error: "File is empty"}`
- **Single-column file:** Creates cards with only the first field populated
- **Mismatched column counts:** Pad short rows with empty strings, ignore extra columns beyond model field count
- **Large files:** No special handling needed — SQLite bulk insert is fast. Preview only shows first 5 rows regardless.
- **Binary/non-text files:** UTF-8 decode failure caught, falls back to latin-1; if still garbage, user sees it in preview and can cancel
- **File dialog returns .txt when user expected .apkg:** File dialog now shows both types in separate filters, so intent is clear
