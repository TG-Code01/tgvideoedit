from __future__ import annotations

import cgi
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "web"
UPLOADS = ROOT / "uploads"
OUTPUT = ROOT / "output"


def guarded_path(path: Path) -> Path:
    resolved = path.resolve(strict=False)
    # Ensure the path stays within the app root or output/uploads dirs
    root_s = str(ROOT).lower()
    resolved_s = str(resolved).lower()
    # Allow paths inside the app directory only
    if not resolved_s.startswith(root_s):
        raise ValueError(f"Forbidden path: {resolved}")
    return resolved


def safe_name(name: str, fallback: str) -> str:
    stem = Path(name or fallback).stem or fallback
    suffix = Path(name or "").suffix.lower() or ".mp4"
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", stem).strip(" ._") or fallback
    suffix = re.sub(r"[^A-Za-z0-9.]+", "", suffix)[:12] or ".mp4"
    return f"{stem}{suffix}"


def write_upload(field: cgi.FieldStorage, prefix: str) -> Path:
    if not field.filename:
        raise ValueError(f"Missing {prefix} upload")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    filename = safe_name(field.filename, prefix)
    target = guarded_path(UPLOADS / f"{int(time.time())}_{uuid.uuid4().hex[:8]}_{filename}")
    with target.open("wb") as handle:
        while True:
            chunk = field.file.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    return target


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler: BaseHTTPRequestHandler, status: int, body: str, content_type: str) -> None:
    data = body.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class StyleCutHandler(BaseHTTPRequestHandler):
    server_version = "StyleCutWeb/1.0"

    def log_message(self, format: str, *args) -> None:
        print("%s - %s" % (self.address_string(), format % args))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/health":
            json_response(self, 200, {"ok": True})
            return

        if path.startswith("/output/"):
            self.serve_file(guarded_path(ROOT / path.lstrip("/")), download=False)
            return

        if path == "/":
            path = "/index.html"

        public_path = guarded_path(PUBLIC / path.lstrip("/"))
        if not str(public_path).lower().startswith(str(PUBLIC.resolve(strict=False)).lower()):
            text_response(self, 403, "Forbidden", "text/plain; charset=utf-8")
            return
        self.serve_file(public_path, download=False)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/generate":
            json_response(self, 404, {"ok": False, "error": "Not found"})
            return

        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
                },
            )
            reference = write_upload(form["reference"], "reference")
            source = write_upload(form["source"], "source")
            options = {
                "audio": form.getfirst("audio", "reference"),
                "effect_preset": form.getfirst("effectPreset", "auto"),
                "source_mode": form.getfirst("sourceMode", "match"),
                "transition": form.getfirst("transition", ""),
                "copy_reference_outro": form.getfirst("copyReferenceOutro", "false") == "true",
                "no_flashes": form.getfirst("noFlashes", "false") == "true",
            }

            OUTPUT.mkdir(parents=True, exist_ok=True)
            output_name = f"{source.stem}_matched_to_{reference.stem}_{uuid.uuid4().hex[:6]}.mp4"
            output_path = guarded_path(OUTPUT / safe_name(output_name, "matched_output"))

            cmd = [
                sys.executable,
                str(ROOT / "stylecut.py"),
                "--reference",
                str(reference),
                "--source",
                str(source),
                "--output",
                str(output_path),
                "--source-mode",
                options["source_mode"],
                "--audio",
                options["audio"],
                "--effect-preset",
                options["effect_preset"],
            ]
            if options["transition"]:
                cmd += ["--transition", options["transition"]]
            if options["copy_reference_outro"]:
                cmd += ["--copy-reference-outro"]
            else:
                cmd += ["--no-copy-reference-outro"]
            if options["no_flashes"]:
                cmd += ["--no-flashes"]

            started = time.time()
            proc = subprocess.run(
                cmd,
                cwd=str(ROOT),
                text=True,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
            )
            elapsed = round(time.time() - started, 1)
            if proc.returncode != 0:
                json_response(
                    self,
                    500,
                    {
                        "ok": False,
                        "error": "Render failed",
                        "stdout": proc.stdout[-4000:],
                        "stderr": proc.stderr[-4000:],
                    },
                )
                return

            profile_path = output_path.with_suffix(".profile.json")
            profile = {}
            if profile_path.exists():
                profile = json.loads(profile_path.read_text(encoding="utf-8"))

            json_response(
                self,
                200,
                {
                    "ok": True,
                    "outputUrl": f"/output/{output_path.name}",
                    "profileUrl": f"/output/{profile_path.name}" if profile_path.exists() else None,
                    "elapsed": elapsed,
                    "profile": profile,
                    "stdout": proc.stdout[-4000:],
                },
            )
        except Exception as exc:
            json_response(self, 500, {"ok": False, "error": str(exc)})

    def serve_file(self, path: Path, *, download: bool) -> None:
        if not path.exists() or not path.is_file():
            text_response(self, 404, "Not found", "text/plain; charset=utf-8")
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.end_headers()
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("PORT", os.environ.get("STYLECUT_PORT", "8765")))
    host = "0.0.0.0"
    server = ThreadingHTTPServer((host, port), StyleCutHandler)
    print(f"StyleCut web app running at http://{host}:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
