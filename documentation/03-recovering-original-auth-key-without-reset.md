# 03 — Recovering Your Original Auth Key Without Factory Reset

If your Nespresso Expert EN 350.G is already paired with the official Nespresso app on your phone, you **do not** need to factory-reset the coffee machine. Once you recover the 8-byte (`16-hex-character`, starting with `8`) Auth Key, both the **Web Bluetooth app (`main` branch)** and the **Standalone Android APK (`android-apk` branch)** can connect and brew immediately without resetting the machine.

Below are the methods to recover your existing key without resetting the machine, starting with the **proven `adb backup` method (`nespresso.ab`)** that succeeded directly against the installed official app.

---

## Method 1 (Proven & Succeeded): `adb backup` of `com.nespresso.activities` (`nespresso.ab`)

### Why This Works (Zero Root Required)
Because `com.nespresso.activities` (`nespresso-3-28-0.apk`) was compiled with `android:allowBackup="true"` in its `AndroidManifest.xml`, Android allows exporting the app's private SQLite database over USB via `adb backup` without root access!

Inside the resulting `nespresso.ab` archive (`ANDROID BACKUP v5`, 24-byte header followed by a `zlib`-compressed POSIX tar stream) is the full SQLite database:

```text
apps/com.nespresso.activities/db/nespresso_app_fusion.db
```

Within `nespresso_app_fusion.db`, the **`MyMachines`** table stores the paired machine record, including:
- `user_friendly_name` (e.g., `The Anthracite Expert`)
- `description` (e.g., `Expert Anthracite Grey Coffee Machine`)
- `sku` (e.g., `erp.se.b2c/prod/D80-EU-GR-NE`)
- `family_range_code` (`EXPERT`)
- `mac_address` (`XX:XX:XX:XX:XX:XX`)
- `serial_number` (19-character serial number)
- `machine_id` (UUID)
- `pairing_state` (`PRESENT`)
- **`pairing_key`** (32-character lowercase hex hash, e.g., `365d910d...`)

### Step-by-Step Instructions

1. **Connect your phone via USB** (with USB Debugging enabled in Developer Options) and run:
   ```powershell
   adb backup -f nespresso.ab -noapk com.nespresso.activities
   ```
2. **Confirm the backup on your phone screen**:
   - Tap **"Back up my data"** on the phone (leave the backup encryption password blank so the `.ab` stream is unencrypted `none`).
3. **Run the repository's extractor script on `nespresso.ab`** (and optionally save to `.env`):
   ```powershell
   python scripts/extract_auth_key.py nespresso.ab --save-env
   ```

### How the 32-Character `pairing_key` from `nespresso.ab` Becomes the 16-Character BLE Auth Key

As revealed by decompiling `com.nespresso.connect.communication.operation.pair.PairingKey` (`prepareHashForPairing()` + `getBufferFromByteArray()`, mirrored in [`PairingKeyCodec.java`](../android/app/src/main/java/io/github/adelinaluna/notpresso/PairingKeyCodec.java)):

1. **Read the 32-character `pairing_key`** from `MyMachines`:
   ```text
   <c0><c1><c2><c3><c4><c5><c6><c7><c8><c9><c10><c11><c12><c13><c14><c15>... (32 hex chars)
   ```
2. **Take the first 15 hex characters (`c0..c14`) and prepend `8`** (which shifts the first 8 bytes right by 4 bits and sets the leading nibble to `0x8` via `0x80 | (byte0 >>> 4)`):
   ```text
   BLE Auth Key (16 hex chars) = "8" + pairing_key[0:15]
   ```
3. **Paste that 16-character `8...` key into Notpresso**:
   - Open **Settings → Auth Key** in either the Web App (`main` branch) or the Standalone APK (`android-apk` branch).
   - Paste the 16-character `8...` key and tap **Connect** (normal connect, *not* Pair/Setup).
   - The machine authenticates immediately over characteristic `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` without resetting!

*(Note: In the Standalone APK, [`PairingKeyCodec.normalizeKeyHex()`](../android/app/src/main/java/io/github/adelinaluna/notpresso/PairingKeyCodec.java) accepts **either** the converted 16-character `8...` BLE key **or** the raw 32-character `pairing_key` database hash and converts it automatically.)*

---

## Method 2: Zero-Root `adb bugreport` Extraction (If the App Cannot Be Backed Up)

If `adb backup` is unavailable, Android's `adb bugreport` packages `/data/misc/bluetooth/logs/btsnoop_hci.log` (and system `logcat`) into a `.zip` file without root:

1. Enable **Settings → Developer options → Enable Bluetooth HCI snoop log** on your phone.
2. Turn on your Nespresso Expert and open the official Nespresso app for 5–10 seconds so it connects once and writes the 8-byte key to `06aa3a41-f22a-11e3-9daa-0002a5d5c51b`.
3. Run:
   ```powershell
   adb bugreport bugreport.zip
   python scripts/extract_auth_key.py bugreport.zip --save-env
   ```

---

## Method 3: Snatching the Live Key with nRF Connect (GATT Server "Mirror" Trick)

Because the official Nespresso app does not authenticate the peripheral before writing the key to `06aa3a41`:
1. Unplug your physical Nespresso Expert machine so it stops advertising.
2. In **nRF Connect for Mobile**, create a **GATT Server** with Service `06aa1910-f22a-11e3-9daa-0002a5d5c51b`, Read characteristic `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` (value `02`), and Write characteristic `06aa3a41-f22a-11e3-9daa-0002a5d5c51b`.
3. When the official Nespresso app connects, it writes the 8-byte (`16-hex-char`) Auth Key (`8...`) directly to `06aa3a41` in the nRF Connect server log.

---

## Fallback: If You Ever Decide to Factory-Reset the Machine

If you ever prefer to start fresh with a brand-new key via the **Standalone Android APK (`android-apk` branch)**:
1. Turn the machine on, open and close the slider with no capsule inside.
2. Turn the rotary dial to **Lungo**, then press and hold the **Hot Water / Temperature** button for **6 seconds** until the lights blink.
3. Once reset, characteristic `06aa3a51` returns `0x00`/`0x01` (`ABSENT`), and the **Pair New / Factory-Reset Machine** button in the Standalone Android APK will enroll a new `8...` key automatically.
