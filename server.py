#!/usr/bin/env python3
"""
Notpresso Expert Local Development / HTTPS Server
Web Bluetooth requires a Secure Context (HTTPS or localhost).
This script runs a lightweight Python server with optional self-signed SSL certificate
so your phone (e.g. Samsung Galaxy S24 Ultra) can access Web Bluetooth on your local Wi-Fi.
"""

import http.server
import socket
import ssl
import sys
import os

PORT = 8443

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
    def end_headers(self):
        # Enable PWA caching and security headers
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

def main():
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
