#!/usr/bin/env python3
"""
Nespresso Expert EN 350.G — Original BLE Auth Key Extractor
===========================================================
Extracts your existing 8-byte (16-hex-character) Nespresso Expert BLE Auth Key
WITHOUT factory-resetting your coffee machine.

Supported inputs:
  1. An Android `adb backup` file (`nespresso.ab` from `adb backup -f nespresso.ab -noapk com.nespresso.activities`):
     python scripts/extract_auth_key.py ../nespresso-official/nespresso.ab --save-env
  2. A raw `nespresso_app_fusion.db` SQLite database file:
     python scripts/extract_auth_key.py nespresso_app_fusion.db --save-env
  3. An Android `adb bugreport bugreport.zip` archive or `btsnoop_hci.log` capture:
     python scripts/extract_auth_key.py bugreport.zip
  4. A 32-character Nespresso `pairing_key` string (from `MyMachines` DB or account JSON):
     python scripts/extract_auth_key.py --from-pairing-key <32-hex-char-string>
"""

import argparse
import io
import re
import sqlite3
import struct
import sys
import tarfile
import tempfile
import zipfile
import zlib
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

# UUID 06aa3a41-f22a-11e3-9daa-0002a5d5c51b in 128-bit Little-Endian (ATT wire order)
UUID_06AA3A41_LE = bytes.fromhex("1bc5d5a50200aa9de3112af2413aaa06")

# Known non-auth 8-byte payloads to ignore (e.g. MachineStatus or Brew command prefixes)
IGNORED_PREFIXES = (
    bytes.fromhex("03050704"),
    bytes.fromhex("01100800"),
)


def pairing_key_to_wire_hex(pairing_key_str: str) -> str:
    """
    Converts a 32-character stored pairing_key hash into the 16-character (8-byte)
    BLE wire authentication token written to characteristic 06aa3a41.

    Takes the first 8 bytes (16 hex chars) of the 32-char pairing_key,
    shifts nibbles right by 4 bits across those 8 bytes, and sets the highest nibble to 0x8.
    """
    cleaned = re.sub(r"[^0-9a-fA-F]", "", pairing_key_str).lower()
    if len(cleaned) == 16 and cleaned.startswith("8"):
        return cleaned
    if len(cleaned) < 15:
        raise ValueError(f"Pairing key too short ({len(cleaned)} hex chars, need at least 15).")
    return "8" + cleaned[:15]


def extract_machines_from_sqlite_bytes(db_bytes: bytes) -> List[Dict[str, str]]:
    """
    Opens `nespresso_app_fusion.db` bytes using sqlite3 and queries the `MyMachines` table.
    """
    machines: List[Dict[str, str]] = []
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp.write(db_bytes)
        tmp_path = Path(tmp.name)

    try:
        conn = sqlite3.connect(str(tmp_path))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        for table in tables:
            if "machine" not in table.lower():
                continue
            try:
                cur.execute(f"SELECT * FROM {table}")
                rows = cur.fetchall()
                for row in rows:
                    row_dict = {k: str(row[k]) for k in row.keys() if row[k] is not None}
                    pkey = row_dict.get("pairing_key") or row_dict.get("mPairingKey") or ""
                    if pkey and len(pkey) >= 15:
                        row_dict["ble_auth_key"] = pairing_key_to_wire_hex(pkey)
                        machines.append(row_dict)
            except sqlite3.Error:
                continue
        conn.close()
    finally:
        tmp_path.unlink(missing_ok=True)

    return machines


def parse_android_backup_ab(data: bytes) -> List[Dict[str, str]]:
    """
    Unpacks an unencrypted Android Backup (`ANDROID BACKUP\\n...`) `.ab` file,
    decompresses the zlib tar stream, extracts `nespresso_app_fusion.db`, and reads `MyMachines`.
    """
    if not data.startswith(b"ANDROID BACKUP\n"):
        return []

    # Header has 4 newline-terminated lines:
    # 1: ANDROID BACKUP
    # 2: version (e.g. 5)
    # 3: compressed (1)
    # 4: encryption (none)
    lines = data.split(b"\n", 4)
    if len(lines) < 5:
        return []
    encryption = lines[3].decode("ascii", errors="ignore").strip()
    if encryption.lower() != "none":
        raise RuntimeError(
            f"Android backup is encrypted ({encryption}). Re-run `adb backup` without a password."
        )

    payload = lines[4]
    tar_bytes = zlib.decompress(payload)
    machines: List[Dict[str, str]] = []

    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:*") as tf:
        for member in tf.getmembers():
            if member.isfile() and member.name.endswith(".db"):
                fobj = tf.extractfile(member)
                if fobj is not None:
                    db_bytes = fobj.read()
                    if db_bytes.startswith(b"SQLite format 3"):
                        machines.extend(extract_machines_from_sqlite_bytes(db_bytes))

    return machines


def scan_btsnoop_bytes(data: bytes) -> Tuple[List[str], List[str]]:
    """
    Scans raw btsnoop_hci.log bytes for:
      1. Exact ATT handle discovery for characteristic 06aa3a41-f22a-11e3-9daa-0002a5d5c51b
      2. ATT Write Request (0x12) or Write Command (0x52) with an 8-byte payload starting with 0x80..0x8F
    """
    exact_matches: List[str] = []
    heuristic_matches: List[str] = []
    auth_handles: Set[int] = set()

    idx = 0
    while True:
        pos = data.find(UUID_06AA3A41_LE, idx)
        if pos == -1:
            break
        if pos >= 2:
            val_handle = struct.unpack_from("<H", data, pos - 2)[0]
            if 0x0001 <= val_handle <= 0x0200:
                auth_handles.add(val_handle)
        idx = pos + 1

    if data.startswith(b"btsnoop\x00") and len(data) >= 16:
        offset = 16
        while offset + 24 <= len(data):
            orig_len, inc_len, flags, drops, ts_hi, ts_lo = struct.unpack_from(">IIIIII", data, offset)
            offset += 24
            pkt = data[offset : offset + inc_len]
            offset += inc_len
            _inspect_packet_for_att_write(pkt, auth_handles, exact_matches, heuristic_matches)
    else:
        pattern = re.compile(rb"\x0b\x00\x04\x00([\x12\x52])(..)(........)", re.DOTALL)
        for m in pattern.finditer(data):
            handle = struct.unpack("<H", m.group(2))[0]
            payload = m.group(3)
            _record_candidate(handle, payload, auth_handles, exact_matches, heuristic_matches)

    return exact_matches, heuristic_matches


def _inspect_packet_for_att_write(
    pkt: bytes,
    auth_handles: Set[int],
    exact_matches: List[str],
    heuristic_matches: List[str],
) -> None:
    idx = 0
    while True:
        pos = pkt.find(b"\x0b\x00\x04\x00", idx)
        if pos == -1 or pos + 4 + 11 > len(pkt):
            break
        att_pdu = pkt[pos + 4 : pos + 4 + 11]
        opcode = att_pdu[0]
        if opcode in (0x12, 0x52):
            handle = struct.unpack_from("<H", att_pdu, 1)[0]
            payload = att_pdu[3:11]
            _record_candidate(handle, payload, auth_handles, exact_matches, heuristic_matches)
        idx = pos + 1


def _record_candidate(
    handle: int,
    payload: bytes,
    auth_handles: Set[int],
    exact_matches: List[str],
    heuristic_matches: List[str],
) -> None:
    if len(payload) != 8 or payload.startswith(IGNORED_PREFIXES):
        return
    hex_key = payload.hex()
    if handle in auth_handles:
        if hex_key not in exact_matches:
            exact_matches.append(hex_key)
    elif (payload[0] & 0xF0) == 0x80 and 0x0001 <= handle <= 0x0100:
        if hex_key not in heuristic_matches:
            heuristic_matches.append(hex_key)


def scan_text_for_pairing_keys(raw_bytes: bytes) -> List[Tuple[str, str]]:
    results: List[Tuple[str, str]] = []
    patterns = [
        rb"mPairingKey=['\"]?([0-9a-fA-F]{16,32})['\"]?",
        rb'"pairingKey"\s*:\s*"([0-9a-fA-F]{16,32})"',
        rb"pairing_key[^0-9a-fA-F]{1,16}([0-9a-fA-F]{32})",
    ]
    for pat in patterns:
        for m in re.finditer(pat, raw_bytes):
            raw_key = m.group(1).decode("ascii", errors="ignore")
            wire_key = pairing_key_to_wire_hex(raw_key)
            pair = (raw_key, wire_key)
            if pair not in results:
                results.append(pair)
    return results


def write_env_file(env_path: Path, machine: Dict[str, str]) -> None:
    ble_key = machine["ble_auth_key"]
    ble_bytes = ",".join(ble_key[i : i + 2] for i in range(0, 16, 2))
    content = (
        "# Local Nespresso Expert EN 350.G Machine Credentials\n"
        "# Extracted from nespresso.ab -> apps/com.nespresso.activities/db/nespresso_app_fusion.db (MyMachines table)\n"
        "# DO NOT COMMIT THIS FILE TO VERSION CONTROL\n\n"
        f'NESPRESSO_MACHINE_NAME="{machine.get("user_friendly_name", "")}"\n'
        f'NESPRESSO_MACHINE_DESCRIPTION="{machine.get("description", "")}"\n'
        f'NESPRESSO_MACHINE_SKU="{machine.get("sku", "")}"\n'
        f'NESPRESSO_FAMILY_RANGE_CODE="{machine.get("family_range_code", "")}"\n'
        f'NESPRESSO_MAC_ADDRESS="{machine.get("mac_address", "")}"\n'
        f'NESPRESSO_SERIAL_NUMBER="{machine.get("serial_number", "")}"\n'
        f'NESPRESSO_MACHINE_ID="{machine.get("machine_id", "")}"\n'
        f'NESPRESSO_PAIRING_STATE="{machine.get("pairing_state", "")}"\n\n'
        "# 32-character database hash from MyMachines.pairing_key\n"
        f'NESPRESSO_DB_PAIRING_KEY="{machine.get("pairing_key", "")}"\n\n'
        "# Ready-to-use 16-character (8-byte) BLE Auth Key written to characteristic 06aa3a41-f22a-11e3-9daa-0002a5d5c51b\n"
        f'NESPRESSO_BLE_AUTH_KEY="{ble_key}"\n'
        f'NESPRESSO_BLE_AUTH_BYTES="{ble_bytes}"\n'
    )
    env_path.write_text(content, encoding="utf-8")
    print(f"[+] Saved extracted machine credentials to local git-ignored file: {env_path}")


def process_file(path: Path, save_env_path: Optional[Path] = None) -> int:
    if not path.exists():
        print(f"[!] File not found: {path}", file=sys.stderr)
        return 1

    exact_ble_keys: List[str] = []
    heuristic_ble_keys: List[str] = []
    log_pairing_keys: List[Tuple[str, str]] = []
    db_machines: List[Dict[str, str]] = []

    if zipfile.is_zipfile(path):
        print(f"[*] Scanning Android bugreport archive: {path.name} ...")
        with zipfile.ZipFile(path, "r") as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                lower_name = info.filename.lower()
                if "btsnoop" in lower_name or lower_name.endswith(".cfa") or lower_name.endswith(".log"):
                    data = zf.read(info.filename)
                    ex, he = scan_btsnoop_bytes(data)
                    for k in ex:
                        if k not in exact_ble_keys:
                            exact_ble_keys.append(k)
                    for k in he:
                        if k not in heuristic_ble_keys:
                            heuristic_ble_keys.append(k)
                    for pair in scan_text_for_pairing_keys(data):
                        if pair not in log_pairing_keys:
                            log_pairing_keys.append(pair)
                elif "bugreport" in lower_name or "nespresso" in lower_name or lower_name.endswith(".txt"):
                    data = zf.read(info.filename)
                    for pair in scan_text_for_pairing_keys(data):
                        if pair not in log_pairing_keys:
                            log_pairing_keys.append(pair)
    else:
        print(f"[*] Scanning file: {path.name} ...")
        data = path.read_bytes()
        if data.startswith(b"ANDROID BACKUP\n"):
            db_machines = parse_android_backup_ab(data)
        elif data.startswith(b"SQLite format 3"):
            db_machines = extract_machines_from_sqlite_bytes(data)
        else:
            exact_ble_keys, heuristic_ble_keys = scan_btsnoop_bytes(data)
            log_pairing_keys = scan_text_for_pairing_keys(data)

    found_any = False
    print("\n" + "=" * 72)
    if db_machines:
        found_any = True
        print("[+] EXTRACTED MACHINE RECORD(S) FROM MyMachines SQLITE DATABASE:")
        for m in db_machines:
            print(f"    Name                 : {m.get('user_friendly_name', 'N/A')}")
            print(f"    Description          : {m.get('description', 'N/A')}")
            print(f"    SKU                  : {m.get('sku', 'N/A')}")
            print(f"    MAC Address          : {m.get('mac_address', 'N/A')}")
            print(f"    Serial Number        : {m.get('serial_number', 'N/A')}")
            print(f"    Pairing State        : {m.get('pairing_state', 'N/A')}")
            print(f"    32-char pairing_key  : {m.get('pairing_key', 'N/A')}")
            print(f"    16-char BLE Auth Key : >>>  {m['ble_auth_key']}  <<<\n")
        if save_env_path is not None:
            write_env_file(save_env_path, db_machines[0])

    if exact_ble_keys:
        found_any = True
        print("[+] FOUND EXACT BLE AUTH KEY WRITTEN TO CHARACTERISTIC 06aa3a41:")
        for k in exact_ble_keys:
            print(f"\n    >>>  {k}  <<<\n")
    if log_pairing_keys:
        found_any = True
        print("[+] FOUND NESPRESSO PAIRING KEY IN LOGS / DB:")
        for raw_k, wire_k in log_pairing_keys:
            print(f"    Raw 32-char pairingKey : {raw_k}")
            print(f"    16-char BLE Auth Key   : >>>  {wire_k}  <<<\n")
    if heuristic_ble_keys and not exact_ble_keys:
        found_any = True
        print("[+] FOUND CANDIDATE 8-BYTE BLE AUTH WRITES (0x8X prefix):")
        for k in heuristic_ble_keys:
            print(f"    >>>  {k}  <<<")

    if not found_any:
        print("[-] No Nespresso Auth Key found in this file.")
        print("=" * 72)
        return 2

    print("=" * 72)
    print("Paste the 16-character BLE Auth Key above into Notpresso ('Auth Key') to connect!")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract or convert Nespresso Expert EN 350.G 16-character BLE Auth Key."
    )
    parser.add_argument(
        "file",
        nargs="?",
        help="Path to nespresso.ab, nespresso_app_fusion.db, bugreport.zip, or btsnoop_hci.log.",
    )
    parser.add_argument(
        "--from-pairing-key",
        dest="pairing_key",
        help="Convert a 32-character Nespresso pairingKey string into the 16-char BLE Auth Key.",
    )
    parser.add_argument(
        "--save-env",
        nargs="?",
        const=".env",
        dest="save_env",
        help="Save extracted machine credentials to a local git-ignored .env file (default: .env).",
    )
    args = parser.parse_args()

    if args.pairing_key:
        try:
            wire_key = pairing_key_to_wire_hex(args.pairing_key)
            print(f"Input pairingKey : {args.pairing_key}")
            print(f"BLE Auth Key     : {wire_key}")
            return 0
        except ValueError as exc:
            print(f"[!] Error: {exc}", file=sys.stderr)
            return 1

    if not args.file:
        parser.print_help()
        return 1

    env_path = Path(args.save_env) if args.save_env else None
    return process_file(Path(args.file), env_path)


if __name__ == "__main__":
    sys.exit(main())
