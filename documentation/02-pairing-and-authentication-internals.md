# 02 — BLE Pairing, Link Bonding & Authentication Internals

This document explains how the Nespresso Expert EN 350.G manages pairing keys, why every valid wire authentication token begins with `0x8`, and how first-time onboarding differs from normal session authentication.

---

## 1. Why the BLE Auth Key Always Starts with `0x8` (Nibble-Shift Derivation)

In cloud profiles and local mobile databases, a machine's pairing credential is generated and stored as a **32-character hexadecimal string** (a 128-bit MD5/UUID hash, such as `0c9a3f8b12e45d67a1b2c3d4e5f60123`).

However, the Nespresso Expert authentication characteristic `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` accepts an **8-byte (`16-hex-character`) payload**.

To convert the 32-character stored hash into the 8-byte wire token written to `06aa3a41`:

1. Take the **first 16 ASCII hex characters** of the 32-character pairing hash (`n[0] .. n[15]`).
2. Shift the 64-bit nibble stream right by **4 bits (1 nibble)**, discarding the 16th nibble (`n[15]`).
3. Set the leading high nibble of Byte 0 to **`0x8`** (`0x80 | n[0]`):

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

### Example Derivation

- **32-character stored pairing hash**:
  `0c9a3f8b12e45d67a1b2c3d4e5f60123`
- **First 15 hex characters**:
  `0c9a3f8b12e45d6` *(the 16th character `7` and trailing 16 characters are discarded)*
- **Prepend `8`**:
  `80c9a3f8b12e45d6` (`[0x80, 0xC9, 0xA3, 0xF8, 0xB1, 0x2E, 0x45, 0xD6]`)

### Key Takeaways
1. Every valid Nespresso Expert 8-byte wire Auth Key **always begins with `8` (`0x80..0x8F`)** when formatted as a 16-character hex string.
2. Both the Notpresso Web App (`main` branch) and the Native Android APK (`android-apk` branch) accept **either** the 16-character `8...` BLE Auth Key **or** the raw 32-character database hash and automatically apply this derivation when needed.

---

## 2. How `PairingKeyState` (`06aa3a51`) Gates Onboarding vs. Session Login

When a client connects to the Nespresso Expert, reading the 1-byte characteristic `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` reports the machine's current key-enrollment state:

| `06aa3a51` Byte Value | State | Hardware Behavior |
| :---: | :--- | :--- |
| `0x00` or `0x01` | `ABSENT` | The machine has **no pairing key stored** (fresh from factory or recently factory-reset). It will accept and store a brand-new 8-byte key during onboarding. |
| `0x02` | `PRESENT` | The machine **already holds an enrolled pairing key**. It will reject any attempt to enroll a new key and will only unlock Service `06aa1920` when its existing 8-byte key is written to `06aa3a41`. |

### Why Re-Pairing From a Browser Fails on an Already-Paired Machine

1. **Key Lockout When `State == 0x02` (`PRESENT`)**:
   If the coffee machine is already paired (`06aa3a51 == 0x02`), it ignores new onboarding keys until a factory reset clears `06aa3a51` back to `0x00`/`0x01`.
2. **OS-Level Bluetooth Bonding During First-Time Onboarding**:
   Even on a factory-reset machine (`06aa3a51 == 0x00`/`0x01`), enrolling a new key requires writing `[0x01]` to `06aa3a61` (`TxPowerLevel`) and completing an OS-level Bluetooth bond (`createBond()`). Because Chrome's Web Bluetooth sandbox does not expose `createBond()`, first-time key enrollment on a factory-reset machine requires a native BLE stack (provided in the `android-apk` branch) or nRF Connect.
3. **Normal Session Authentication Works Everywhere**:
   Once a machine has a key enrolled (`06aa3a51 == 0x02`) and you have that 16-character `8...` Auth Key, **Web Bluetooth works 100% reliably** because normal sessions only require writing the 8-byte key to `06aa3a41`.

---

## 3. Complete Onboarding vs. Session Authentication Sequences

### 3.1 First-Time Onboarding Sequence (Only When `06aa3a51` is `0x00` or `0x01`)

1. **Connect GATT** to the machine.
2. **Enter Low-Power Enrollment Mode**: Write `1` byte `[0x01]` to `06aa3a61-f22a-11e3-9daa-0002a5d5c51b` (`TxPowerLevel`).
3. **Establish OS Bluetooth Bond**:
   - On Android, ensure the device is bonded (`BluetoothDevice.createBond()` and wait for `BOND_BONDED`).
4. **Enroll the 8-Byte Key**: Write the newly generated 8-byte key (`0x8X...`) to `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` (`AuthKey`) using Write With Response.
5. **Verify Key Enrollment**: Read `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` (`PairingKeyState`) and confirm it now returns `[0x02]` (`PRESENT`).
6. **Exit Low-Power Enrollment Mode**: Write `1` byte `[0x00]` to `06aa3a61-f22a-11e3-9daa-0002a5d5c51b` (`TxPowerLevel`).

### 3.2 Normal Session Authentication Sequence (When `06aa3a51` is `0x02`)

1. **Connect GATT** to the machine.
2. **Write the 8-Byte Auth Key**: Write the 8-byte key (`0x8X...`) to `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` (`AuthKey`).
3. **Subscribe to Telemetry & Responses**: Enable notifications on `06aa3a12` (`MachineStatus`), `06aa3a22` (`SliderState`), and `06aa3a52` (`CommandResponse`).
4. **Ready for Commands**: Write brew or configuration payloads to `06aa3a42` (`CommandKey`).

---

## 4. How to Factory-Reset the Machine (If Needed)

If you ever lose the original key or wish to enroll a fresh key:
- **Via BLE (while authenticated)**: Write `03 07 00` (`3 bytes`) to `06aa3a42`.
- **Via Physical Machine Controls**:
  1. Turn the machine on and ensure the capsule slider is **closed** (with no capsule inside).
  2. Turn the front rotary dial to **Lungo**.
  3. Press and hold the **Temperature** button for **6–10 seconds** until the indicators blink rapidly.
  4. The machine resets `06aa3a51` to `ABSENT` (`0x00`/`0x01`) and restores default cup volumes.
