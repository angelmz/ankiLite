"""ankiLite — Lightweight Anki .apkg card viewer with image paste & export."""

import atexit
import base64
import json
import os
import signal
import subprocess
import sys
import tempfile

import webview

from apkg_parser import DeckSession
from settings import load_settings, save_settings, add_recent_file

UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")

MIME_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}


def _convert_tiff_to_png(tiff_bytes):
    """Convert TIFF bytes to PNG using macOS sips command."""
    with tempfile.NamedTemporaryFile(suffix=".tiff", delete=False) as tiff_file:
        tiff_file.write(tiff_bytes)
        tiff_path = tiff_file.name

    png_path = tiff_path.replace(".tiff", ".png")
    try:
        subprocess.run(
            ["sips", "-s", "format", "png", tiff_path, "--out", png_path],
            check=True,
            capture_output=True,
        )
        with open(png_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(tiff_path)
        if os.path.exists(png_path):
            os.unlink(png_path)


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
            add_recent_file(path)  # Track this file
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

            # Convert TIFF to PNG for Anki compatibility (macOS screenshots)
            if mime_type == "image/tiff":
                image_bytes = _convert_tiff_to_png(image_bytes)
                mime_type = "image/png"

            ext = MIME_TO_EXT.get(mime_type, ".png")
            return self.session.add_image(note_id, field_name, image_bytes, ext)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def copy_image(self, data_uri):
        """Copy an image to the macOS system clipboard."""
        try:
            if not data_uri or not data_uri.startswith("data:"):
                return {"ok": False, "error": "Invalid image data"}
            base64_data = data_uri.split(",", 1)[1]
            image_bytes = base64.b64decode(base64_data)

            from AppKit import NSPasteboard, NSImage, NSBitmapImageRep
            from Foundation import NSData

            ns_data = NSData.dataWithBytes_length_(image_bytes, len(image_bytes))
            image = NSImage.alloc().initWithData_(ns_data)
            if image is None:
                return {"ok": False, "error": "Invalid image data"}

            # Write as PNG (not TIFF) to avoid clipboard bloat
            tiff_data = image.TIFFRepresentation()
            bitmap = NSBitmapImageRep.imageRepWithData_(tiff_data)
            png_data = bitmap.representationUsingType_properties_(4, None)

            pb = NSPasteboard.generalPasteboard()
            pb.clearContents()
            pb.setData_forType_(png_data, "public.png")
            return {"ok": True}
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

    def update_field(self, note_id, field_name, new_value):
        """Update a card field's text/HTML content."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        try:
            return self.session.update_field(note_id, field_name, new_value)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_deck(self):
        """Save using the preferred mode from settings."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        settings = load_settings()
        if settings.get("save_mode") == "overwrite":
            result = self.session.export_apkg(self.session.apkg_path)
        else:
            # Default: save-as-copy via dialog
            result = self.export_apkg()

        # Quit after save if setting enabled
        if result.get("ok") and settings.get("quit_on_save"):
            self.quit_app()

        return result

    def quit_app(self):
        """Close session and destroy window."""
        self._close_session()
        window.destroy()
        return {"ok": True}

    def save_deck_as(self):
        """Always open a save dialog (save-as-copy)."""
        return self.export_apkg()

    def save_deck_as_overwrite(self):
        """Overwrite the original file directly."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        return self.session.export_apkg(self.session.apkg_path)

    def get_settings(self):
        """Return current settings dict."""
        return load_settings()

    def update_settings(self, settings):
        """Merge new values into settings and persist."""
        try:
            current = load_settings()
            current.update(settings)
            save_settings(current)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_recent_files(self):
        """Return list of recent files, filtering out any that no longer exist."""
        settings = load_settings()
        recent = settings.get("recent_files", [])
        # Filter to only existing files
        valid = [r for r in recent if os.path.exists(r["path"])]
        # Update settings if any were removed
        if len(valid) != len(recent):
            settings["recent_files"] = valid
            save_settings(settings)
        return valid

    def clear_recent_files(self):
        """Clear the recent files list."""
        settings = load_settings()
        settings["recent_files"] = []
        save_settings(settings)
        return {"ok": True}

    def create_card(self, model_id):
        """Create a new card with empty fields for the given model."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        try:
            return self.session.create_card(model_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_card(self, note_id):
        """Delete a card and its associated note."""
        if not self.session:
            return {"ok": False, "error": "No deck loaded"}
        try:
            return self.session.delete_card(note_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

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


def _on_closing():
    """Clean up and allow window to close."""
    api._close_session()
    return True  # Allow close


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
    window.events.closing += _on_closing

    def _sigint_handler(sig, frame):
        api._close_session()
        window.destroy()
        sys.exit(0)

    signal.signal(signal.SIGINT, _sigint_handler)
    webview.start(debug=False)


if __name__ == "__main__":
    main()
