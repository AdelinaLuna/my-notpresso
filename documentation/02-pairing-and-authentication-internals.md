# 02 — Pairing Key & Onboarding Internals

Extracted from `com.nespresso.ble.base.model.PairingKey`, `com.nespresso.ble.expert.adapters.AuthenticationAdapter`, `com.nespresso.ble.expert.adapters.OnboardingAdapter`, and `com.nespresso.ble.base.operations.PairOperation` in `nespresso-3-28-0.apk`.

---

## 1. Why the BLE Auth Key Always Starts with `0x8` (`PairingKey.getBufferFromByteArray`)

In the official Nespresso database (`nespresso_app_fusion.db`, table `MyMachine`, column `mPairingKey`) and account profile JSON (`EcapiMachineResponse.pairingKey`), a machine's pairing key is stored as a **32-character hexadecimal string** (for example, `0c9a3f8b12e45d67a1b2c3d4e5f60123`, originally generated via MD5/UUID).

However, the Nespresso Expert BLE characteristic `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` (`CharacWriteAuth`) only accepts an **8-byte (`16-hex-character`) payload**.

Decompiling `com.nespresso.ble.base.model.PairingKey.getBufferFromByteArray(byte[] asciiHexBytes)` (`classes.dex`, `codeOff=0x26925c`) revealed the exact conversion algorithm used by the official app:

1. Take the **first 16 ASCII hex characters** of the 32-character `pairingKey` string (`asciiHexBytes[0..15]`).
2. Parse those 16 ASCII hex characters into **16 4-bit nibbles** (`n[0] .. n[15]`), where each character `'0'..'9'`, `'a'..'f'` becomes its numeric value `0x0..0xF`.
3. Shift the entire nibble stream right by 1 nibble (dropping the 16th nibble `n[15]`) and prepend `0x8` (`0x80` high nibble) as the very first nibble:

```text
Wire Byte 0 = 0x80         | n[0]
Wire Byte 1 = (n[1] << 4)  | n[2]
Wire Byte 2 = (n[3] << 4)  | n[4]
Wire Byte 3 = (n[5] << 4)  | n[6]
Wire Byte 4 = (n[7] << 4)  | n[8]
Wire Byte 5 = (n[9] << 4)  | n[10]
Wire Byte 6 = (n[11] << 4) | n[12]
Wire Byte 7 = (n[13] << 4) | n[14]
```

### Example Conversion

- **Stored 32-char `pairingKey`** (in `MyMachine.mPairingKey` or Nespresso account profile):
  `0c9a3f8b12e45d67a1b2c3d4e5f60123`
- **First 15 hex characters**:
  `0c9a3f8b12e45d6` (16th char `7` and remaining chars `a1b2...` are discarded)
- **Prepend `8`**:
  `80c9a3f8b12e45d6` (8 bytes: `80 c9 a3 f8 b1 2e 45 d6`)

This explains two critical facts:
1. Every valid Nespresso Expert 8-byte wire Auth Key **always begins with `8` (`0x80..0x8F`)** when represented as a 16-character hex string.
2. If you only find the 32-character `pairingKey` string in an app log, SQLite database, or profile response, pasting its first 16 characters directly into `06aa3a41` will **fail** unless you prepend `8` and take the first 15 characters!

---

## 2. How `ReadPairingKeyState` (`06aa3a51`) Gates Onboarding vs. Authentication

When the official app connects to the Nespresso Expert, it reads the 1-byte characteristic `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` (`CharacReadPairingKeyState`), decoded by `com.nespresso.ble.expert.builders.PairingKeyStateBuilder`:

| `06aa3a51` Byte Value | `PairingKeyState` Enum | Meaning |
|---|---|---|
| `0x00` or `0x01` | `ABSENT` | The machine has **no pairing key stored** (fresh from factory or recently factory-reset). It will accept a brand-new 8-byte key during onboarding. |
| `0x02` | `PRESENT` | The machine **already holds an enrolled pairing key**. It will **ignore/reject** any new onboarding key and will only unlock Service `06aa1920` when its existing 8-byte key is written to `06aa3a41`. |

### Why Re-Pairing from the Web Page Settings Didn't Work on an Already-Paired Machine

If your Nespresso Expert was previously paired with the official Nespresso app (and has not been factory-reset), its `06aa3a51` characteristic returns `0x02` (`PRESENT`).
- In state `0x02`, the machine refuses to overwrite its internal key via BLE unless it has been factory-reset first.
- Furthermore, even on a factory-reset machine (`06aa3a51 == 0x00` or `0x01`), Chrome's Web Bluetooth API cannot complete onboarding because of the bonding requirement below.

---

## 3. Complete Onboarding vs. Session Authentication Sequences

### 3.1 First-Time Onboarding Sequence (`OnboardingAdapter` + `AuthenticationAdapter`)

Only valid when `06aa3a51` returns `0x00` or `0x01` (`ABSENT`, i.e., after a factory reset):

1. **Connect GATT** to the machine.
2. **Enter Low-Power Onboarding Mode**: Write `1` byte `[0x01]` to `06aa3a61-f22a-11e3-9daa-0002a5d5c51b` (`CharacWriteTXPowerLevel`).
3. **Trigger OS-Level Bluetooth Bonding (`PairOperation`)**:
   - On Android, if `bluetoothDevice.getBondState() != BOND_BONDED`, call `bluetoothDevice.createBond()` and wait for `ACTION_BOND_STATE_CHANGED -> BOND_BONDED` (or perform a GATT read on an encrypted characteristic that triggers the Android OS pairing dialog).
   - *Why Web Bluetooth fails here*: Chrome's `navigator.bluetooth` sandbox does not expose `createBond()` and often drops the GATT transaction when the peripheral requests link encryption mid-onboarding.
4. **Enroll the 8-Byte Key**: Write the 8-byte key (`0x8X...`) to `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` (`CharacWriteAuth`) using `WRITE_TYPE_DEFAULT` (Write With Response).
5. **Verify Key Enrollment**: Read `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` (`CharacReadPairingKeyState`) and verify it now returns `[0x02]` (`PRESENT`).
6. **Exit Low-Power Onboarding Mode**: Write `1` byte `[0x00]` to `06aa3a61-f22a-11e3-9daa-0002a5d5c51b` (`CharacWriteTXPowerLevel`).

### 3.2 Normal Session Authentication Sequence (`AuthenticationAdapter`)

Used on every subsequent connection when `06aa3a51` is already `0x02` (`PRESENT`):

1. **Connect GATT** to the machine.
2. **Write the 8-Byte Auth Key**: Write the 8-byte key (`0x8X...`) to `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` (`CharacWriteAuth`).
3. **Subscribe to Telemetry & Responses**: Enable notifications on `06aa3a12` (`MachineStatus`), `06aa3a22` (`SliderState`), and `06aa3a52` (`CommandResponse`).
4. **Send Commands**: Write brew or configuration payloads to `06aa3a42` (`CommandKey`).
