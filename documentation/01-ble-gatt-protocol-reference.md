# 01 — BLE GATT Protocol Reference (Nespresso Expert EN 350.G)

Extracted from `com.nespresso.ble.expert.*` and `com.nespresso.ble.base.*` in `nespresso-3-28-0.apk`.

---

## 1. BLE GATT Services & Characteristics

The Nespresso Expert exposes four primary vendor GATT services under the base UUID `06aaXXXX-f22a-11e3-9daa-0002a5d5c51b`:

### Service 1: Authentication & Onboarding (`06aa1910-f22a-11e3-9daa-0002a5d5c51b`)

| Characteristic UUID | Official APK Name | Props | Length | Description |
|---|---|---|---|---|
| `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` | `CharacWriteAuth` | Write | 8 bytes | Session Authentication / Pairing Key (`0x8X...`). Must be written at the start of every BLE connection (and during initial onboarding). |
| `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` | `CharacReadPairingKeyState` | Read | 1 byte | Returns whether the machine already holds a pairing key (`0` or `1` = `ABSENT`, `2` = `PRESENT`). |
| `06aa3a61-f22a-11e3-9daa-0002a5d5c51b` | `CharacWriteTXPowerLevel` | Write | 1 byte | Onboarding mode toggle: `[0x01]` lowers TX power and opens the key-enrollment window; `[0x00]` restores normal TX power and commits onboarding. |

### Service 2: Machine Control & Telemetry (`06aa1920-f22a-11e3-9daa-0002a5d5c51b`)

| Characteristic UUID | Official APK Name | Props | Length | Description |
|---|---|---|---|---|
| `06aa3a12-f22a-11e3-9daa-0002a5d5c51b` | `MachineStatus` | Read, Notify | 8 bytes | Real-time machine state, error flags, descaling counter, and slider status. |
| `06aa3a22-f22a-11e3-9daa-0002a5d5c51b` | `SliderState` | Read, Notify | 1 byte | Capsule slider position (`0x00` = Open, `0x02` = Closed). |
| `06aa3a32-f22a-11e3-9daa-0002a5d5c51b` | `CapsuleCounter` | Read, Write | 2 bytes | Remaining capsule count in the app's virtual dispenser counter (unsigned 16-bit big-endian, max `1000`). |
| `06aa3a42-f22a-11e3-9daa-0002a5d5c51b` | `CommandKey` | Write | 6–10 bytes | Command input endpoint for brewing, aborting, cup programming, and factory reset. |
| `06aa3a52-f22a-11e3-9daa-0002a5d5c51b` | `CommandResponse` | Read, Notify | 3–4 bytes | Asynchronous response/ACK/NACK for the last command written to `06aa3a42`. |
| `06aa3a62-f22a-11e3-9daa-0002a5d5c51b` | `WaterHardness` | Read, Write | 3 bytes | Water hardness level (`Byte 2` = `0x00`..`0x04`, where `0` is softest and `4` is hardest). |

### Service 3: Machine Serial & Diagnostics (`06aa1930-f22a-11e3-9daa-0002a5d5c51b`)

| Characteristic UUID | Official APK Name | Props | Description |
|---|---|---|---|
| `06aa3a13-f22a-11e3-9daa-0002a5d5c51b` | `SerialNumber` | Read | 19-character ASCII serial number of the machine. |
| `06aa3a23` .. `06aa3a73` | `FaultLog` / `Lifecounter` | Read | Internal diagnostic counters and error history registers. |

---

## 2. Telemetry Byte Formats

### 2.1 `MachineStatus` (`06aa3a12-f22a-11e3-9daa-0002a5d5c51b`) — 8 Bytes

Decoded by `com.nespresso.ble.expert.builders.MachineStateBuilder`:

| Byte | Bit / Value | Meaning |
|---|---|---|
| **Byte 0** | Status Flags | Bitfield of active warnings/conditions:<br>• `0x01`: Water Tank Empty (`WATER_ENGAGED`)<br>• `0x02`: Descaling Needed (`DESCALING_NEEDED`)<br>• `0x04`: Capsule Mechanism Jammed (`CAPSULE_MECHANISM_JAMMED`)<br>• `0x08`: Tray Full / Capsule Container Full (`TRAY_FULL_COUNTER`)<br>• `0x20`: Machine Hot / Overheated (`OVERHEATED`)<br>• `0x40`: Sleeping (`SLEEPING`) |
| **Byte 1** | State Enum | Primary operational state:<br>• `0x00`: `SLEEPING` / Deep Standby<br>• `0x01`: `PREHEATING`<br>• `0x02`: `READY` (Ready to brew)<br>• `0x03`: `BREWING`<br>• `0x04`: `ERROR`<br>• `0x06`: `DESCALING`<br>• `0x09`: `RINSING` |
| **Byte 2** | Hardware Flags | Bit `0x40`: `NEED_DESCALE` urgent flag. |
| **Byte 3** | Error Code | Non-zero hardware fault code when `Byte 1 == 0x04`. |
| **Bytes 4–5** | Timer (uint16 BE) | Remaining time in seconds for scheduled/delayed brew or descaling. |
| **Byte 6** | Slider Position | Capsule slider state (`0x00` = Slider Open, `0x02` = Slider Closed). |
| **Byte 7** | Descale Counter | Remaining brews before descaling alert triggers. |

### 2.2 `SliderState` (`06aa3a22-f22a-11e3-9daa-0002a5d5c51b`) — 1 Byte

Decoded by `com.nespresso.ble.expert.builders.SliderStateBuilder`:
- `0x00`: **Slider Open** (`OPEN`) — user can insert a capsule; brewing commands will be rejected with `LID_STILL_OPEN` (`0x2103`).
- `0x02`: **Slider Closed** (`CLOSED`) — ready to brew (provided a fresh capsule was loaded).

---

## 3. Command Payloads (`06aa3a42-f22a-11e3-9daa-0002a5d5c51b`)

All commands are written to `06aa3a42` (`CommandKey`) after authenticating on `06aa3a41`.

### 3.1 Standard Single-Rotary Brew (10 Bytes)

Built by `com.nespresso.ble.expert.operations.brew.BrewByteConversion`:

```text
03 05 07 04 00 00 00 00 <TEMP_BYTE> <RECIPE_BYTE>
```

- **Header (`Bytes 0..7`)**: `03 05 07 04 00 00 00 00`
- **Byte 8 (`<TEMP_BYTE>`)** — `TemperatureConversion`:
  - `0x01` = **Warm / Medium** (`LOW` in APK enum)
  - `0x02` = **Hot / High** (`MEDIUM` in APK enum)
  - `0x03` = **Extra Hot / Very High** (`HIGH` in APK enum)
- **Byte 9 (`<RECIPE_BYTE>`)** — Rotary dial position (`BrewingType`):
  - `0x01` = **Ristretto**
  - `0x02` = **Espresso**
  - `0x04` = **Lungo**
  - `0x05` = **Hot Water**
  - `0x07` = **Americano**

### 3.2 Custom Two-Step Volume Recipe Brew (10 Bytes)

Built by `BrewByteConversion.fromCustomRecipe(CustomRecipe)` — allows exact milliliter control for coffee and hot water independently (between `15 ml` and `300 ml` total):

```text
01 10 08 00 <ING0_TYPE> <ING0_ML_HI> <ING0_ML_LO> <ING1_TYPE> <ING1_ML_HI> <ING1_ML_LO>
```

- **Header (`Bytes 0..3`)**: `01 10 08 00`
- **Step 1 (`Bytes 4..6`)**:
  - `Byte 4`: Ingredient type (`0x01` = Coffee extraction, `0x02` = Hot water bypass)
  - `Bytes 5..6`: Volume in milliliters as 16-bit unsigned big-endian integer (e.g., `25 ml` = `00 19`, `40 ml` = `00 28`, `110 ml` = `00 6e`).
- **Step 2 (`Bytes 7..9`)**:
  - Single-step recipe (Coffee only or Water only): `07 00 00` (`Ingredient.NONE = 0x07`, volume `0`).
  - Two-step recipe (e.g., custom Americano): `02 <WATER_ML_HI> <WATER_ML_LO>` (e.g., `125 ml` water = `02 00 7d`).

### 3.3 Stop / Abort Active Brew (6 Bytes)

Found in `com.nespresso.ble.base.adapters.BaseBrewAdapter.ABORT_ACTION_PAYLOAD`:

```text
03 06 01 02 00 00
```

Writing these 6 bytes to `06aa3a42` while the machine is brewing (`MachineStatus Byte 1 == 0x03`) immediately stops the pump.

### 3.4 Program Hardware Default Volume for a Rotary Position (9 Bytes)

Found in `com.nespresso.ble.expert.adapters.CupSizeOperationsAdapter`:

```text
03 05 07 03 00 00 <ML_HI> <ML_LO> <CUP_BIT>
```

- `Bytes 6..7`: Target default volume in milliliters (`uint16 BE`).
- `Byte 8 (`<CUP_BIT>`)`:
  - `0x01` = Ristretto (`15–40 ml`)
  - `0x02` = Espresso (`30–70 ml`)
  - `0x04` = Lungo (`70–130 ml`)
  - `0x08` = Hot Water (`50–300 ml`)
  - *(Note: Americano is programmed via a custom two-step command).*

### 3.5 Reset All Cup Sizes to Factory Default (6 Bytes)

Found in `CupSizeOperationsAdapter.resetCupSizes()`:

```text
03 06 05 02 00 00
```

### 3.6 Factory Reset Machine (6 Bytes — **Clears Pairing Key!**)

Found in `com.nespresso.ble.expert.adapters.FactoryResetAdapter`:

```text
03 06 03 02 00 00
```

> **Warning**: Writing `03 06 03 02 00 00` to `06aa3a42` erases the machine's stored BLE `pairingKey` (`06aa3a51` reverts from `0x02` to `0x00`/`0x01`) and resets all custom cup volumes.

---

## 4. `CommandResponse` (`06aa3a52-f22a-11e3-9daa-0002a5d5c51b`) Decoding

Decoded by `com.nespresso.ble.expert.builders.CommandResponseBuilder`:

- **Byte 0** indicates whether the command succeeded or failed:
  - **Success**: `(Byte 0 & 0x60) == 0x20` (typically `0x20` or `0x23`, e.g., `23 05 07` or `21 10 08`).
  - **Failure / NACK**: `(Byte 0 & 0x60) == 0x40` (typically `0x40` or `0x43`).
- When **Failure** occurs, **Bytes 2–3** contain a 16-bit error code:

| Bytes 2–3 (Hex) | Official APK Error Constant | Meaning / User Fix |
|---|---|---|
| `0x2101` | `TRAY_FULL` | Drip tray / capsule container is full. Empty it. |
| `0x2102` | `WATER_EMPTY` | Water tank is empty. Refill tank. |
| `0x2103` | `LID_STILL_OPEN` | Capsule slider is open. Close the slider. |
| `0x2104` | `CAPSULE_NOT_CHANGED` | Slider was not opened/closed since last brew. Insert a fresh capsule. |
| `0x2105` | `SECURITY_ERROR` | Machine safety interlock triggered. |
| `0x2107` | `WRONG_SETTING_SELECTION` | Physical rotary dial on the machine is still on `OFF` (`0`) or incompatible with command. |
| `0x2403` | `CLEAN_NEEDED` | Machine requires rinsing/cleaning cycle. |

---

## 5. How These Findings Can Improve the `main` (Web Bluetooth) Branch

Even when using Web Bluetooth in Chrome on the `main` branch, the protocol findings above allow several high-value upgrades:
1. **Emergency Stop / Abort Brew Button**: Sending `03 06 01 02 00 00` to `06aa3a42` stops an active brew immediately.
2. **Real-Time Command Error Explanations**: Subscribing to `06aa3a52` (`CommandResponse`) notifications tells the user *why* a brew didn't start (e.g., `0x2104` *"Please open and close the slider to load a new capsule"* or `0x2103` *"Capsule slider is open"*).
3. **Live Capsule Slider Indicator**: Reading `Byte 6` of `06aa3a12` (or subscribing to `06aa3a22`) shows whether the capsule slider is open (`0x00`) or closed (`0x02`).
4. **Hardware Cup Volume Programming**: Sending `03 05 07 03 00 00 <HI> <LO> <CUP>` programs the physical machine's default volumes for Ristretto, Espresso, Lungo, and Hot Water so even physical button presses use the user's preferred milliliters.
