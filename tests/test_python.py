#!/usr/bin/env python3
"""
Notpresso Expert — Python Regression Test Suite

Covers:
  - server.py dotfile blocking and header security (Issue #6 / 1c41918)
  - scripts/extract_auth_key.py 4-bit nibble-shift key derivation, SQLite
    MyMachines extraction, Android .ab backup parsing, btsnoop ATT scan,
    and text/log key scanning.

Run: python tests/test_python.py
"""

import io
import os
import sqlite3
import struct
import sys
import tarfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))
sys.path.insert(0, str(ROOT_DIR / "scripts"))

import server  # noqa: E402
import extract_auth_key as eak  # noqa: E402


class FakeHTTPHandler(server.Handler):
    """Minimal subclass of server.Handler without opening a socket."""

    def __init__(self, req_path: str, body: bytes = b""):
        self.path = req_path
        self.errors = []
        self.responses = []
        self.headers_sent = []
        self.headers = {"Content-Length": str(len(body))}
        self.rfile = io.BytesIO(body)

    def send_response(self, code, msg=None):
        self.responses.append(code)

    def send_error(self, code, msg=None):
        self.errors.append((code, msg))

    def send_header(self, name, value):
        self.headers_sent.append((name, value))

    def end_headers(self):
        with patch.object(server.http.server.SimpleHTTPRequestHandler, "end_headers", return_value=None):
            super().end_headers()


class TestServerSecurityRegression(unittest.TestCase):
    """Regression [#6 / 1c41918]: block dotfiles and omit wildcard CORS."""

    def test_blocks_dotfiles_and_encoded_dot_segments(self):
        for bad_path in ["/.env", "/.git/config", "/%2eenv", "/nested/.secret", "/\\..\\.env"]:
            h = FakeHTTPHandler(bad_path)
            result = h.send_head()
            self.assertIsNone(result, f"Expected None for {bad_path}")
            self.assertEqual(h.errors, [(403, "Forbidden")], f"Expected 403 for {bad_path}")

    def test_allows_normal_file_and_sets_no_cache_without_wildcard_cors(self):
        h = FakeHTTPHandler("/index.html")
        with patch.object(server.http.server.SimpleHTTPRequestHandler, "send_head", return_value="OK"):
            self.assertEqual(h.send_head(), "OK")
        self.assertEqual(h.errors, [])

        h.end_headers()
        header_map = dict(h.headers_sent)
        self.assertEqual(header_map.get("Cache-Control"), "no-cache")
        self.assertNotIn("Access-Control-Allow-Origin", header_map)

    def test_debug_log_endpoint_records_and_rejects_other_posts(self):
        import tempfile

        bad = FakeHTTPHandler("/other", b'{"line":"x"}')
        bad.do_POST()
        self.assertEqual(bad.errors, [(404, "Not Found")])

        with tempfile.NamedTemporaryFile(suffix=".log", delete=False) as tf:
            log_path = Path(tf.name)
        try:
            with patch.dict(os.environ, {"NOTPRESSO_LOG_FILE": str(log_path)}):
                ok = FakeHTTPHandler("/__debug_log", b'{"line":"RX [06aa3a12 Status] lid=OPEN"}')
                with patch("builtins.print") as mock_print:
                    ok.do_POST()
                mock_print.assert_called_once()
            self.assertEqual(ok.responses, [204])
            self.assertIn("[LIVE-BLE] RX [06aa3a12 Status] lid=OPEN", log_path.read_text(encoding="utf-8"))
        finally:
            log_path.unlink(missing_ok=True)


class TestExtractAuthKey(unittest.TestCase):
    """Unit & integration tests for scripts/extract_auth_key.py."""

    def test_pairing_key_to_wire_hex_derivation_and_validation(self):
        self.assertEqual(
            eak.pairing_key_to_wire_hex("02c15f832a8644375a264bd1fb3fb1e8"),
            "802c15f832a86443",
        )
        self.assertEqual(eak.pairing_key_to_wire_hex("82c15f832a864437"), "82c15f832a864437")
        with self.assertRaises(ValueError):
            eak.pairing_key_to_wire_hex("deadbeef")

    def _build_mock_sqlite_bytes(self, pairing_key: str) -> bytes:
        conn = sqlite3.connect(":memory:")
        conn.execute(
            "CREATE TABLE MyMachines (machine_id TEXT, user_friendly_name TEXT, pairing_key TEXT)"
        )
        conn.execute(
            "INSERT INTO MyMachines VALUES (?, ?, ?)",
            ("1", "Expert EN350", pairing_key),
        )
        conn.commit()
        dump = "\n".join(conn.iterdump())
        conn.close()

        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf:
            tmp_path = Path(tf.name)
        try:
            file_conn = sqlite3.connect(str(tmp_path))
            file_conn.executescript(dump)
            file_conn.close()
            return tmp_path.read_bytes()
        finally:
            tmp_path.unlink(missing_ok=True)

    def test_extract_machines_from_sqlite_and_android_backup(self):
        db_bytes = self._build_mock_sqlite_bytes("a1b2c3d4e5f6071899aabbccddeeff00")
        machines = eak.extract_machines_from_sqlite_bytes(db_bytes)
        self.assertEqual(len(machines), 1)
        self.assertEqual(machines[0]["ble_auth_key"], "8a1b2c3d4e5f6071")

        # Pack into unencrypted ANDROID BACKUP (.ab)
        tar_buf = io.BytesIO()
        with tarfile.open(fileobj=tar_buf, mode="w") as tf:
            ti = tarfile.TarInfo("apps/com.nespresso.activities/db/nespresso_app_fusion.db")
            ti.size = len(db_bytes)
            tf.addfile(ti, io.BytesIO(db_bytes))
        ab_data = b"ANDROID BACKUP\n5\n1\nnone\n" + zlib.compress(tar_buf.getvalue())

        ab_machines = eak.parse_android_backup_ab(ab_data)
        self.assertEqual(len(ab_machines), 1)
        self.assertEqual(ab_machines[0]["ble_auth_key"], "8a1b2c3d4e5f6071")

        # Encrypted backups raise RuntimeError clearly
        with self.assertRaises(RuntimeError):
            eak.parse_android_backup_ab(b"ANDROID BACKUP\n5\n1\nAES-256\npayload")

    def test_scan_btsnoop_and_text_ignores_brew_frames(self):
        # Construct GATT discovery handle 0x002A immediately before UUID_06AA3A41_LE
        # plus valid ATT Write Request (0x12) on handle 0x002A and an ignored brew command
        handle_le = struct.pack("<H", 0x002A)
        auth_key = bytes.fromhex("8a1b2c3d4e5f6071")
        brew_cmd = bytes.fromhex("0305070400000000")
        heuristic_key = bytes.fromhex("89abcdef01234567")

        att_exact = b"\x0b\x00\x04\x00\x12" + handle_le + auth_key
        att_ignored = b"\x0b\x00\x04\x00\x12" + struct.pack("<H", 0x0030) + brew_cmd
        att_heur = b"\x0b\x00\x04\x00\x52" + struct.pack("<H", 0x0031) + heuristic_key
        raw = handle_le + eak.UUID_06AA3A41_LE + att_exact + att_ignored + att_heur

        exact, heuristic = eak.scan_btsnoop_bytes(raw)
        self.assertEqual(exact, ["8a1b2c3d4e5f6071"])
        self.assertEqual(heuristic, ["89abcdef01234567"])

        pairs = eak.scan_text_for_pairing_keys(
            b'{"pairingKey": "02c15f832a8644375a264bd1fb3fb1e8"}'
        )
        self.assertEqual(pairs, [("02c15f832a8644375a264bd1fb3fb1e8", "802c15f832a86443")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
