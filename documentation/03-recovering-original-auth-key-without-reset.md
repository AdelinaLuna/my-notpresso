# 03 — Recovering Your Enrolled Auth Key Without Factory Reset

If your Nespresso Expert EN 350.G is already paired with an existing mobile installation on your phone, you **do not** need to factory-reset the coffee machine. Once you recover the 8-byte (`16-hex-character`, starting with `8`) Auth Key, both the **Web Bluetooth PWA (`main` branch)** and the **Standalone Android APK (`android-apk` branch)** can authenticate and brew immediately.

Below are three zero-reset methods supported by [`scripts/extract_auth_key.py`](../scripts/extract_auth_key.py).

---

## Method 1 (Recommended): Unencrypted Android App Backup (`.ab` Archive)

### How It Works (Zero Root Required)
Legacy versions of the Android companion app that supported Nespresso Expert onboarding allow standard USB `adb backup` exports without root access.

The resulting `.ab` archive (`ANDROID BACKUP v5`, a 24-byte header followed by a `zlib`-compressed POSIX `tar` stream) contains the local SQLite database where paired machine records are stored (`MyMachines` table), including:
- `user_friendly_name` (e.g., `My Expert Machine`)
- `description` (e.g., `Expert Anthracite Grey Coffee Machine`)
- `sku` (e.g., `D80-EU-GR-NE`)
- `family_range_code` (`EXPERT`)
- `mac_address` (`AA:BB:CC:DD:EE:FF`)
- `serial_number` (19-character machine serial)
- `pairing_state` (`PRESENT`)
- **`pairing_key`** (32-character lowercase hexadecimal hash, e.g., `0c9a3f8b12e45d67a1b2c3d4e5f60123`)

### Step-by-Step Instructions

1. **Connect your phone via USB** (with **USB Debugging** enabled in Developer Options) and create a data-only backup:
   ```powershell
   adb backup -f nespresso.ab -noapk com.nespresso.activities
   ```
2. **Confirm the backup on your phone screen**:
   - Tap **"Back up my data"** on the phone (leave the backup encryption password blank so the `.ab` archive is unencrypted).
3. **Run the extractor script on `nespresso.ab`** (and optionally write the result to a local git-ignored `.env` file):
   ```powershell
   python scripts/extract_auth_key.py nespresso.ab --save-env
   ```

### How the 32-Character `pairing_key` Becomes the 16-Character BLE Auth Key

As detailed in [Document 02](./02-pairing-and-authentication-internals.md):
1. Take the **first 15 hex characters** of the 32-character `pairing_key` (`pairing_key[0:15]`).
2. Prepend **`8`** (`"8" + pairing_key[0:15]`), producing a 16-character hexadecimal string (`8 bytes`).
3. Paste that 16-character `8...` key (or the full 32-character hash, which Notpresso converts automatically) into **Settings → Auth Key** and tap **Connect**.

---

## Method 2: Zero-Root Bluetooth HCI Snoop Log / `adb bugreport`

If you cannot run `adb backup`, Android's `adb bugreport` packages the Bluetooth HCI snoop log (`btsnoop_hci.log`) into a `.zip` archive without root access:

1. On your Android phone, enable **Settings → Developer options → Enable Bluetooth HCI snoop log**.
2. Turn on your Nespresso Expert and let the existing app connect once so it writes the 8-byte key to characteristic `06aa3a41-f22a-11e3-9daa-0002a5d5c51b`.
3. Export the bugreport over USB and scan it with [`scripts/extract_auth_key.py`](../scripts/extract_auth_key.py):
   ```powershell
   adb bugreport bugreport.zip
   python scripts/extract_auth_key.py bugreport.zip --save-env
   ```

---

## Method 3: GATT Server "Mirror" Capture in nRF Connect

Because the client writes the 8-byte Auth Key to `06aa3a41` immediately upon connecting:
1. Unplug your physical Nespresso Expert machine so it stops advertising.
2. In **nRF Connect for Mobile**, configure a **GATT Server** containing Service `06aa1910-f22a-11e3-9daa-0002a5d5c51b`, Read characteristic `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` (value `02`), and Write characteristic `06aa3a41-f22a-11e3-9daa-0002a5d5c51b`.
3. Advertise with your machine's name (`Expert...`). When the existing app connects, the 8-byte (`16-hex-char`) Auth Key (`8...`) will appear directly in the nRF Connect server log as a write to `06aa3a41`.
