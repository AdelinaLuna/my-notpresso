# ☕ Notpresso Expert — Standalone Android APK & BLE Controller for Nespresso Expert EN 350.G

An offline, zero-cloud, zero-login **Standalone Android APK** (and Web Bluetooth PWA) for controlling the **Nespresso Expert (EN 350.G / C80)** over Bluetooth Low Energy (BLE) on **Samsung Galaxy S24 Ultra (OneUI 9 / Android 14–16)**.

---

## 📱 Sideloading the Standalone Android APK (`android-apk` branch)

No web server, no HTTPS tunnel, and no Nespresso account required:

1. Download **[`releases/notpresso-expert-en350g.apk`](releases/notpresso-expert-en350g.apk)** onto your **Samsung Galaxy S24 Ultra**.
2. Tap the `.apk` file to install it (allow *Install unknown apps* if prompted).
3. Open **Notpresso Expert** and grant the **Nearby devices** (`BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`) permission.
4. Tap **Connect** to scan using Android's native `BluetoothLeScanner` and connect directly via `BluetoothGatt`.

---

## 🔬 Reverse-Engineering Findings from Official `nespresso-3-28-0.apk`

By decompiling the last official Nespresso Android release that supported BLE onboarding (`v3.28.0`, `classes3.dex`, `classes5.dex`, and `resources.arsc`), we uncovered the exact reasons why third-party pairing attempts fail and how to pair without ever needing to extract the key from the official app:

### 1. Why Random 8-Byte Pairing Keys Were Rejected (`PairingKey.getBufferFromByteArray`)
In `com.nespresso.mobile.core.bean.machine.PairingKey` (`classes3.dex`, `codeOff=0x37bd98`), the 8-byte `Credentials` written to `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` are **not** 8 arbitrary bytes. The app generates a 32-char UUID/MD5 hex string (`16 bytes`), shifts nibbles right by 4 bits across the first 8 bytes, and **hard-codes the high nibble of byte 0 to `0x8` (`0x80..0x8F`)**:

```java
public static byte[] getBufferFromByteArray(byte[] raw) {
    byte[] out = new byte[8];
    out[0] = (byte) (((raw[0] & 0xF0) >>> 4) | 0x80); // High nibble MUST be 0x8!
    for (int i = 1; i < 8; i++) {
        out[i] = (byte) (((raw[i - 1] & 0x0F) << 4) | ((raw[i] & 0xF0) >>> 4));
    }
    return out;
}
```
- **Why every real Nespresso Auth Key starts with `8`** (e.g., `8215c8d89a6a51a0`, `86177092a55264f9`): the machine firmware validates `(key[0] & 0xF0) == 0x80`. Any key not starting with `8` is rejected!
- **32-Char SQLite DB Key Auto-Conversion**: In the official app's SQLite database (`MyMachine.mPairingKey`, column `FIELD_PAIRING_KEY`), Nespresso stores the 32-character hex string *before* `getBufferFromByteArray()` transforms it into the 8-byte wire key. Notpresso Expert accepts **either** the 16-char wire key **or** the 32-char database string and converts it automatically.

### 2. Why Re-Pairing Fails on an Already-Paired Machine (`06aa3a51` `PairingKeyState`)
In `com.nestle.connecteddevices.nespresso.adapters.common.AuthenticationAdapter` (`classes5.dex`, `codeOff=0x31c178`) and `PairingKeyStateBuilder` (`codeOff=0x321ffc`), characteristic `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` (`ReadPairingKeyState`) returns 1 byte:
- **`0x00` or `0x01` (`PairingKeyState.ABSENT`)**: The machine has **no pairing key stored** (factory reset / unpaired state) and will accept a brand-new `0x8X...` key via `OnboardingAdapter.pair()`.
- **`0x02` (`PairingKeyState.PRESENT`)**: The machine **already holds a pairing key**. While in `PRESENT` state, the machine firmware **refuses to overwrite its key** (`ScanOperation` throws `ALL_MACHINES_FOUND_PAIRED`: *"We have found a Nespresso machine in your environment, but it is already paired with another device and/or account. Please do a factory reset on your machine and try again."*).

### 3. How to Pair a Fresh Key WITHOUT Snatching the Old Key (10-Second Physical Reset)
From `nespresso-3-28-0.apk` (`resources.arsc` `0x7f1102bc`), you can clear the old pairing key (`PRESENT -> ABSENT`) directly on the physical **Nespresso Expert EN 350.G** in 10 seconds:
1. Make sure the machine is ON (or in Standby) and the capsule slider is **closed**.
2. Turn the front rotary cup-size dial to **Americano** (or enter Advanced Mode and turn the dial to **Lungo**), then press & hold the **Temperature button for 6 seconds** until the LEDs blink rapidly, and press the **Brew button** on top to confirm.
3. Once reset completes, characteristic `06aa3a51` reads `0`/`1` (`ABSENT`).
4. Open **Notpresso Expert** and tap **Connect**! When `06aa3a51` reads `ABSENT`, the app automatically runs the exact `OnboardingAdapter.pair` flow:
   - Writes `[0x01]` (`TxLevel.LOW_LEVEL`) to `06aa3a61-f22a-11e3-9daa-0002a5d5c51b`
   - Generates a valid `0x8X...` key via `PairingKeyCodec.generateValidKeyHex()` and writes it to `06aa3a41-f22a-11e3-9daa-0002a5d5c51b`
   - Saves your new key permanently on your phone!

---

## 📡 Complete Verified GATT Profile (`com.nestle.connecteddevices.nespresso`)

| Service / Characteristic UUID | Official Class / Method (`classes5.dex`) | Payload / Description |
| :--- | :--- | :--- |
| **Service `06aa1910-...`** | `MachineProperties` / `Authentication` / `Onboarding` | Device info, serial, auth, and onboarding |
| `06aa3a21-...` | `ReadMachineInformation` (`14881`) | 14 bytes: HW ver `[0..1]`, Bootloader `[2..3]`, Main FW `[4..5]`, BLE FW `[6..7]`, MAC `[8..13]` |
| `06aa3a31-...` | `ReadSerial` (`14897`) | 19 bytes US-ASCII machine serial number |
| `06aa3a41-...` | `writeKey` (`14913`) | Write 8-byte `Credentials` (`(byte[0] & 0xF0) == 0x80`) |
| `06aa3a51-...` | `ReadPairingKeyState` (`14929`) | Read 1 byte: `0`/`1` = `ABSENT` (Unpaired), `2` = `PRESENT` (Paired) |
| `06aa3a61-...` | `lowerTxLevel` (`14945`) | Write 1 byte `[0x01]` (`TxLevel.LOW_LEVEL`) before writing new key during onboarding |
| **Service `06aa1920-...`** | `BrewOperations` / `MachineMonitoring` / `FactoryReset` | Brewing, custom recipes, status, slider, factory reset |
| `06aa3a12-...` | `MachineStatus` (`14866`) | Read / Notify 8 bytes (Status, temperature, descaling/water/capsule alerts) |
| `06aa3a22-...` | `SliderState` (`14882`) | Read / Notify 1 byte (`0x00` = Closed, `0x02` = Open) |
| `06aa3a32-...` | `CommandSchedule` (`14898`) | Read 6 bytes programmed/scheduled brew |
| `06aa3a42-...` | `CommandKey` (`14914`) | **Brew Preset**: `03 05 07 04 00 00 00 00 <temp> <drink>`<br>**Write Custom Recipe**: `01 10 08 00 00 <ing1> <hi1> <lo1> <ing2> <hi2> <lo2>` (`01`=Coffee, `02`=Water) followed by Brew `0x07`<br>**Cancel Brew (`ABORT_ACTION_PAYLOAD`)**: `03 06 01 02`<br>**BLE Factory Reset (`FactoryResetAdapter`)**: `03 07 00` |
| `06aa3a52-...` | `CommandResponse` (`14930`) | Read / Notify up to 20 bytes (`0x8X` = OK/DONE, `0xCX` = Rejected with reason code in bytes `[2..3]`) |
| **Service `06aa1940-...`** | `CupSizeOperations` | Physical rotary dial default volume programming |
| `06aa3a14-...` | `writeCupSizeTarget` (`14868`) | Write 2-byte big-endian target (`0`=Ristretto, `1`=Espresso, `2`=Lungo, `3`=Americano Coffee, `4`=Americano Water, `5`=Hot Water) |
| `06aa3a24-...` | `CupSizeVolume` (`14884`) | Read / Write 4 bytes `[volHi, volLo, 0xFF, 0xFF]` |

**Temperature Byte (`TemperatureConversion`, `classes5.dex`, `codeOff=0x320560`)**:
- `0x00` = **Medium** (~85°C)
- `0x01` = **Low / Warm** (~80°C)
- `0x02` = **High / Very Hot** (~90°C)

---

## 🙏 Credits & Acknowledgments

This project stands on the shoulders of the open-source hardware reverse-engineering community:

1. **[Rosselman / barista-studio](https://github.com/Rosselman/barista-studio)** — Inspiration for the modern dark espresso UI/UX aesthetic, multi-step custom recipe workflow, and initial CMID handshake implementation.
2. **[Farmin Farzin (`@farminf`)](https://gist.github.com/farminf/94f681eaca2760212f457ac59da99f23)** — Foundational BLE packet reverse engineering and Android Bluetooth HCI snoop log (`btsnoop_hci.log`) analysis for Nespresso machines.
3. **[Florian Salomon (`@fsalomon/nespresso-expert-ble`)](https://github.com/fsalomon/nespresso-expert-ble)** — GATT service and characteristic UUID mapping and Node.js / Noble command dispatches for the Nespresso Expert.
4. **[Peter Gullberg (`@petergullberg/brewbutton`)](https://github.com/petergullberg/brewbutton)** — Discovery of the two-step `01 10 08` custom volumetric recipe programming packet for custom milliliter extraction.
5. **[Uri Shaked (`@urish`)](https://urish.medium.com/reverse-engineering-a-bluetooth-lightbulb-56580fcb7546)** — Guide on reverse engineering Bluetooth Low Energy peripherals and building Web Bluetooth controllers.
6. **[`@bulldog5046` / ha-nespresso-ble-custom](https://github.com/bulldog5046/ha-nespresso-ble-custom)** — Home Assistant BLE integration insights and hardware pairing slot documentation.

---

## 📄 License

Released under the [MIT License](LICENSE).
*Disclaimer: This project is an independent open-source interoperability tool and is not affiliated with, endorsed by, or supported by Nestlé Nespresso S.A.*
