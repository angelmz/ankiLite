"""ankiLite — Lightweight Anki .apkg card viewer with image paste & export."""

import atexit
import base64
import json
import os

import webview

from apkg_parser import DeckSession

UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")

MIME_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}


class Api:
    """JavaScript-callable API exposed to the frontend via pywebview js_api."""

    def __init__(self):
        self.session = None

    def _close_session(self):
        if self.session:
            self.session.close()
            self.session = None

    def load_apkg(self, path):
        """Open an .apkg file as a persistent session and return cards."""
        try:
            self._close_session()
            self.session = DeckSession(path)
            cards = self.session.open()
            return {"ok": True, "cards": cards}
        except Exception as e:
            self._close_session()
            return {"ok": False, "error": str(e)}

    def open_file_dialog(self):
        """Open a native file dialog to select an .apkg file. Returns the path or None."""
        result = window.create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=("Anki Package (*.apkg)",),
        )
        if result and len(result) > 0:
            return result[0]
        return None

    def paste_image(self, note_id, field_name, base64_data, mime_type):
        """Add a pasted image to a note field. Returns {ok, data_uri}."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        try:
            image_bytes = base64.b64decode(base64_data)
            ext = MIME_TO_EXT.get(mime_type, ".png")
            return self.session.add_image(note_id, field_name, image_bytes, ext)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def upload_image(self, note_id, field_name):
        """Open a file dialog to pick an image, then add it to a note field."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        result = window.create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=("Images (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp)",),
        )
        if not result or len(result) == 0:
            return {"ok": False, "error": "cancelled"}
        filepath = result[0]
        try:
            with open(filepath, "rb") as f:
                image_bytes = f.read()
            _, ext = os.path.splitext(filepath)
            if not ext:
                ext = ".png"
            return self.session.add_image(note_id, field_name, image_bytes, ext)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def remove_image(self, note_id, field_name, image_index):
        """Remove an image from a note field by index. Saves immediately."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        try:
            return self.session.remove_image(note_id, field_name, image_index)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def export_apkg(self):
        """Open a save dialog and export the modified deck."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        basename = os.path.splitext(os.path.basename(self.session.apkg_path))[0]
        default_name = f"{basename}_modified.apkg"
        result = window.create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=default_name,
            file_types=("Anki Package (*.apkg)",),
        )
        if not result:
            return {"ok": False, "error": "cancelled"}
        save_path = result if isinstance(result, str) else result[0]
        return self.session.export_apkg(save_path)

    def close_session(self):
        """Close the current deck session."""
        self._close_session()
        return {"ok": True}


api = Api()
window = None

atexit.register(api._close_session)


def _on_drop(e):
    """Handle file drops via pywebview's DOM API (provides full file paths)."""
    try:
        files = e.get("dataTransfer", {}).get("files", [])
        for f in files:
            path = f.get("pywebviewFullPath", "")
            if path and path.endswith(".apkg"):
                window.evaluate_js(
                    f"window._loadDeckFromPath({json.dumps(path)})"
                )
                return
    except Exception:
        pass


def _on_loaded():
    """Register drag-and-drop handler after window loads."""
    window.dom.body.on("drop", _on_drop)


def main():
    global window
    window = webview.create_window(
        "ankiLite",
        url=os.path.join(UI_DIR, "index.html"),
        js_api=api,
        width=1000,
        height=700,
        min_size=(600, 400),
    )
    window.events.loaded += _on_loaded
    webview.start(debug=False)


if __name__ == "__main__":
    main()
