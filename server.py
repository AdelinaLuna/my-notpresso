#!/usr/bin/env python3
"""
Notpresso Expert Local Development / HTTPS Server
Web Bluetooth requires a Secure Context (HTTPS or localhost).
This script runs a lightweight Python server with optional self-signed SSL certificate
so your phone (e.g. Samsung Galaxy S24 Ultra) can access Web Bluetooth on your local Wi-Fi.
"""

import http.server
import json
import socket
import ssl
import sys
import os
import urllib.parse

PORT = 8443
DEBUG_LOG_FILE = os.environ.get("NOTPRESSO_LOG_FILE", "")

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        decoded_path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        segments = [seg for seg in decoded_path.replace("\\", "/").split("/") if seg]
        if any(seg.startswith(".") for seg in segments):
            self.send_error(403, "Forbidden")
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):
        if args and isinstance(args[0], str) and "/__debug_log" in args[0]:
            return
        super().log_message(format, *args)

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path != "/__debug_log":
            self.send_error(404, "Not Found")
            return
        length = min(max(int(self.headers.get("Content-Length", "0") or 0), 0), 8192)
        raw = self.rfile.read(length) if length > 0 else b""
        text = raw.decode("utf-8", errors="replace").strip()
        try:
            payload = json.loads(text) if text else {}
            line = str(payload.get("line", text)) if isinstance(payload, dict) else text
        except Exception:
            line = text
        clean = line.replace("\r", " ").replace("\n", " ").strip()
        if clean:
            entry = f"[LIVE-BLE] {clean}"
            print(entry, flush=True)
            log_path = os.environ.get("NOTPRESSO_LOG_FILE", "") or DEBUG_LOG_FILE
            if log_path:
                with open(log_path, "a", encoding="utf-8") as fp:
                    fp.write(entry + "\n")
        self.send_response(204)
        self.end_headers()

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(line_buffering=True)
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    local_ip = get_local_ip()

    cert_file = "cert.pem"
    key_file = "key.pem"

    # Check if SSL cert exists, if not generate one via python if possible
    has_ssl = os.path.exists(cert_file) and os.path.exists(key_file)

    server_address = ("0.0.0.0", PORT)
    httpd = http.server.HTTPServer(server_address, Handler)

    if has_ssl:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        proto = "https"
    else:
        proto = "http"

    print("\n" + "=" * 60)
    print(" ☕  NOTPRESSO EXPERT - LOCAL SERVER RUNNING")
    print("=" * 60)
    print(f" Local URL (on PC):       {proto}://localhost:{PORT}")
    print(f" Phone URL (on Wi-Fi):    {proto}://{local_ip}:{PORT}")
    print("-" * 60)
    if proto == "http":
        print(" [NOTE] For Web Bluetooth on Android over local IP:")
        print(" 1. In Chrome on your phone, go to: chrome://flags")
        print(" 2. Search for: 'Insecure origins treated as secure'")
        print(f" 3. Add: http://{local_ip}:{PORT} and enable it, then relaunch.")
        print(" OR host this folder directly on GitHub Pages for instant free HTTPS!")
    print("=" * 60 + "\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")

if __name__ == "__main__":
    main()
