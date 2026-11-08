# 01 — BLE GATT Protocol Reference (Nespresso Expert EN 350.G / D80)

This document specifies the complete Bluetooth Low Energy (BLE) Generic Attribute Profile (GATT) services, characteristics, telemetry bitfields, response codes, and command payloads supported by the **Nespresso Expert (EN 350.G / D80 & C80)** hardware.

---

## 1. 128-Bit UUID Template & Offset Formula

All custom vendor services and characteristics on the Nespresso Expert share a single 128-bit base UUID template:

$$\texttt{Base UUID} = \texttt{06aa1910-f22a-11e3-9daa-0002a5d5c51b}$$

Every service and characteristic UUID is derived by replacing the 16-bit big-endian integer at bits `32..47` (`0x1910` in the base UUID) with a 16-bit offset value:

$$\texttt{06aa}\langle\texttt{OFFSET\_HEX}\rangle\texttt{-f22a-11e3-9daa-0002a5d5c51b}$$

---

## 2. Complete GATT Services & Characteristics Map

### Service 1: Authentication, Device Info & Onboarding (`06aa1910-f22a-11e3-9daa-0002a5d5c51b`, offset `0x1910`)

| Characteristic UUID | Offset (`Dec` / `Hex`) | Role | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a21-f22a-11e3-9daa-0002a5d5c51b` | `14881` (`0x3A21`) | `MachineInfo` | Read | 10 bytes | Hardware revision (`bytes[0..1]`), Main Microcontroller Firmware version (`bytes[4..5]`), and BLE Module Firmware version (`bytes[6..7]`). |
| `06aa3a31-f22a-11e3-9daa-0002a5d5c51b` | `14897` (`0x3A31`) | `SerialNumber` | Read | 19 bytes | 19-character ASCII machine serial number (e.g. `00000D80XXXXXXXXXXn`). |
| `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` | `14913` (`0x3A41`) | `AuthKey` | Write | 8 bytes | Session Authentication / Pairing Key (`[0x8X, ...]`). Must be written at the start of every GATT session to unlock Services 2–5. |
| `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` | `14929` (`0x3A51`) | `PairingKeyState` | Read | 1 byte | Enrollment state: `0x00` or `0x01` = `ABSENT` (unpaired / factory-reset), `0x02` = `PRESENT` (key enrolled). |
| `06aa3a61-f22a-11e3-9daa-0002a5d5c51b` | `14945` (`0x3A61`) | `TxPowerLevel` | Write | 1 byte | Onboarding radio power control: `[0x01]` = Low TX power (enter key-enrollment window), `[0x00]` = Default TX power (commit and exit enrollment). |

### Service 2: Brewing, Commands & Live Machine Monitoring (`06aa1920-f22a-11e3-9daa-0002a5d5c51b`, offset `0x1920`)

| Characteristic UUID | Offset (`Dec` / `Hex`) | Role | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a12-f22a-11e3-9daa-0002a5d5c51b` | `14866` (`0x3A12`) | `MachineStatus` | Read, Notify | 6–8 bytes | 48-bit real-time machine status bitfield (see Section 3.1). |
| `06aa3a22-f22a-11e3-9daa-0002a5d5c51b` | `14882` (`0x3A22`) | `AdditionalData` / `SliderState` | Read, Notify | 1–14 bytes | Capsule slider state (`0x00` = Open, `0x02` = Closed) and auxiliary event telemetry. |
| `06aa3a32-f22a-11e3-9daa-0002a5d5c51b` | `14898` (`0x3A32`) | `CommandSchedule` | Read | 6 bytes | Active Scheduled/Delayed Brew status: `bytes[0..3]` (`uint32 BE`) remaining delay in seconds, `byte[4]` temperature code, `byte[5]` drink/schedule ID. |
| `06aa3a42-f22a-11e3-9daa-0002a5d5c51b` | `14914` (`0x3A42`) | `CommandKey` | Write | 3–11 bytes | Primary command endpoint: load custom recipe (`11B`), trigger/schedule brew (`10B`), abort active brew (`4B`), or factory reset (`3B`). |
| `06aa3a52-f22a-11e3-9daa-0002a5d5c51b` | `14930` (`0x3A52`) | `CommandResponse` | Read, Notify | 4–20 bytes | Command execution result (`ACK` `0x20`, `CONDITIONS_NOT_FULFILLED` `0x24`, `OUT_OF_RANGE` `0x36`; see Section 3.2). |

### Service 3: Error Log Retrieval (`06aa1930-f22a-11e3-9daa-0002a5d5c51b`, offset `0x1930`)

| Characteristic UUID | Offset (`Dec` / `Hex`) | Role | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a13-f22a-11e3-9daa-0002a5d5c51b` | `14867` (`0x3A13`) | `ErrorSelection` | Write | 1 byte | Write `[0x00]` to select the most recent hardware fault record (`0x00..0x09` index history). |
| `06aa3a23-f22a-11e3-9daa-0002a5d5c51b` | `14883` (`0x3A23`) | `ErrorInformation` | Read | 19+ bytes | Fault record: `byte[0]` = `errorNumber`, `byte[1] >> 4` = `errorCategory` (`0=NONE, 1=INFO, 2=WARNING, 3=ERROR, 4=FATAL`), `byte[2]` = `errorSubCode`. |

### Service 4: Rotary Dial Cup Sizes, Standby Delay & Water Hardness (`06aa1940-f22a-11e3-9daa-0002a5d5c51b`, offset `0x1940`)

| Characteristic UUID | Offset (`Dec` / `Hex`) | Role | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a14-f22a-11e3-9daa-0002a5d5c51b` | `14868` (`0x3A14`) | `CupSizeTarget` | Write | 2 bytes | Selects which Rotary Dial cup slot (`0x0000`..`0x0005`) to read or write on `06aa3a24`. |
| `06aa3a24-f22a-11e3-9daa-0002a5d5c51b` | `14884` (`0x3A24`) | `CupSizeVolume` | Read, Write | 2–4 bytes | Reads `2B` (`[volHi, volLo]`) or writes `4B` (`[volHi, volLo, 0xFF, 0xFF]`) in milliliters for the slot selected on `06aa3a14`. |
| `06aa3a44-f22a-11e3-9daa-0002a5d5c51b` | `14916` (`0x3A44`) | `GeneralUserConfig` | Read, Write | 3–4 bytes | `[standbySecHi, standbySecLo, waterHardnessLevel]` (`0xFF` = leave field unchanged). |

### Service 5: Capsule Stock Counter (`06aa1950-f22a-11e3-9daa-0002a5d5c51b`, offset `0x1950`)

| Characteristic UUID | Offset (`Dec` / `Hex`) | Role | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a15-f22a-11e3-9daa-0002a5d5c51b` | `14869` (`0x3A15`) | `StockCount` | Read, Write | 2 bytes | Remaining capsule stock counter (`uint16 BE`, or `0xFFFF` = stock tracking deactivated). |
| `06aa3a25-f22a-11e3-9daa-0002a5d5c51b` | `14885` (`0x3A25`) | `StockThreshold` | Read, Write | 2 bytes | Low-capsule warning threshold (`uint16 BE`). |
| `06aa3a35-f22a-11e3-9daa-0002a5d5c51b` | `14901` (`0x3A35`) | `StockKey` | Read, Write | 4 bytes | 32-bit stock synchronization transaction identifier. |

---

## 3. Exact Telemetry & Response Byte Layouts

### 3.1 `MachineStatus` (`06aa3a12`) — 48-Bit Bitfield Specification

The 6-byte (`48-bit`) status frame uses big-endian bit numbering where **Bit `0` is the Most Significant Bit (`0x80`) of `Byte 0`**, and **Bit `7` is the Least Significant Bit (`0x01`) of `Byte 0`**:

```text
Bit Index (b = 0..47):
  byteIndex = b >> 3
  bitMask   = 1 << (7 - (b & 7))
```

| Byte | Bit Range (`MSB=0`) | Bitwise Expression | Field Name | Meaning |
| :---: | :---: | :--- | :--- | :--- |
| **Byte 0** | `Bit 0` | `(b[0] & 0x80) != 0` | `bootloaderActive` | `1` = Bootloader / firmware update mode active |
| **Byte 0** | `Bits 1..2` | `(b[0] >> 5) & 0x03` | `pairingKeyState` | `0` or `1` = `ABSENT`, `2` = `PRESENT` |
| **Byte 0** | `Bit 3` | `(b[0] & 0x10) != 0` | `errorPresent` | `1` = Hardware error present (inspect via `06aa1930`) |
| **Byte 0** | `Bit 5` | `(b[0] & 0x04) != 0` | `descalingNeeded` | `1` = Descaling cycle required |
| **Byte 0** | `Bit 7` | `(b[0] & 0x01) != 0` | `waterTankEmpty` | `1` = **Water Tank Empty** (also triggers immediately if the water tank is lifted mid-brew) |
| **Byte 1** | `Bit 9` | `(b[1] & 0x40) != 0` | `capsuleContainerFull` | `1` = **Spent Capsule Container Full** |
| **Byte 1** | `Bits 12..15` | `b[1] & 0x0F` | `machineState` | 4-bit operational state (`0..15`, see table below) |
| **Byte 2** | `Bit 16` | `(b[2] & 0x80) != 0` | `capsuleStockLow` | `1` = Remaining capsule count is below `06aa3a25` threshold |
| **Bytes 2–3** | `Bits 17..26` | `((b[2] & 0x7F) << 3) \| (b[3] >> 5)` | `capsuleStockCounter` | 10-bit remaining capsule counter (`0..1023`) |
| **Byte 3** | `Bit 27` | `(b[3] & 0x10) != 0` | `programmedBrewActive` | `1` = **Hardware Scheduled / Delayed Brew timer is active** |
| **Byte 3** | `Bits 28..29` | `(b[3] >> 2) & 0x03` | `programmedBrewEventCtr` | 2-bit rolling counter incremented when scheduled brew changes |
| **Byte 3** | `Bits 30..31` | `b[3] & 0x03` | `capsuleStockEventCtr` | 2-bit rolling counter incremented when capsule stock changes |
| **Byte 4** | `Bits 32..33` | `(b[4] >> 6) & 0x03` | `blockedMachineEventCtr` | 2-bit rolling counter incremented on blocked machine events |
| **Byte 5** | `Bit 46` | `(b[5] & 0x02) == 0` | `sliderOpen` | **Inverted logic**: `bit == 0` → **Slider OPEN**, `bit == 1` → **Slider CLOSED** |
| **Byte 5** | `Bit 47` | `(b[5] & 0x01) != 0` | `obstacleDetected` | `1` = Physical obstacle / jam detected in slider or brew chamber |

#### `MachineState` Values (`Byte 1 & 0x0F`):
| Value | Hex | State Name | Description |
| :---: | :---: | :--- | :--- |
| `0` | `0x00` | `RESET` | Machine resetting / initializing |
| `1` | `0x01` | `HEAT_UP` | Heating thermoblock |
| `2` | `0x02` | `READY` | Ready to brew |
| `3` | `0x03` | `DESCALING_READY` | Ready to start descaling cycle |
| `4` | `0x04` | `BREWING` | Actively brewing / pumping water |
| `5` | `0x05` | `ADVANCED_SELECTION_MENU` | Physical rotary dial is in advanced menu position |
| `6` | `0x06` | `DESCALING` | Descaling cycle in progress |
| `7` | `0x07` | `STEAM_OUT` | Purging / steaming out internal water circuit |
| `8` | `0x08` | `ERROR` | Fault / error lockout state |
| `9` | `0x09` | `POWER_SAVE` | Sleeping / Standby power-save mode |
| `10` | `0x0A` | `OVER_HEAT` | Overheated cooldown protection |
| `11` | `0x0B` | `DIAGNOSTIC_MODE` | Factory diagnostic mode |
| `12` | `0x0C` | `BLE_SETTINGS` | Bluetooth configuration mode |
| `13` | `0x0D` | `FACTORY_RESET` | Performing factory reset |
| `14` | `0x0E` | `WATER_HARDNESS_SETTINGS` | Water hardness configuration mode |
| `15` | `0x0F` | `STAND_BY_DELAY_SETTINGS` | Auto-off standby delay configuration mode |

---

### 3.2 `CommandResponse` (`06aa3a52`) — ACK & Rejection Subcodes

After writing a command to `06aa3a42`, the machine notifies `06aa3a52` (up to 20 bytes, where the response payload begins at `bytes[3]`):
- **`bytes[3] == 0x20` (`32`)**: **`ACK` (`DONE`)** — Command accepted and executing.
- **`bytes[3] == 0x36` (`54`)**: **`OUT_OF_RANGE`** — Requested volume or parameter is outside hardware limits.
- **`bytes[3] == 0x24` (`36`)**: **`CONDITIONS_NOT_FULFILLED`** — Command rejected; inspect **`bytes[4]`** for the exact precondition failure:

| `bytes[4]` (`Dec` / `Hex`) | Rejection Code | Human-Readable Cause |
| :---: | :--- | :--- |
| `1` (`0x01`) | `INVALID_STATE` | Machine is in an invalid state for this command |
| `2` (`0x02`) | `INVALID_STATE` | Machine is in an invalid state for this command |
| `3` (`0x03`) | `CAPSULE_CONTAINER_FULL` | Spent capsule container is full |
| `4` (`0x04`) | `OBSTACLE_DETECTED` | Obstacle detected in brew chamber or slider |
| `5` (`0x05`) | `DESCALE_ON` | Machine is locked in descaling mode |
| `6` (`0x06`) | `LAST_ACTION_NOT_FINISHED` | Previous operation is still running |
| `7` (`0x07`) | `NOT_ABORTABLE_ACTION` | Current operation cannot be aborted |
| `8` (`0x08`) | `SLIDER_OPEN` | **Capsule slider is open** — slide it closed to brew |
| `9` (`0x09`) | `NO_PROGRAMMED_BREW_ACTIVE` | No scheduled brew timer is currently active to cancel |
| `16` (`0x10`) | `PUMP_RUNNING` | Water pump is already running |
| `17` (`0x11`) | `MOTOR_RUNNING` | Brew-chamber motor is currently moving |
| `18` (`0x12`) | `SLIDER_NOT_BEEN_OPENED` | **Capsule not changed** — open and close the slider to load a fresh capsule |

*(Note: Shorter 4-byte response frames on some firmware revisions place `0x24` at `bytes[2]` and the subcode at `bytes[3]`; parsers should check both offsets.)*

---

## 4. Command Payloads Written to `06aa3a42` (`CommandKey`)

### 4.1 Brew Immediately OR Schedule Delayed Brew (`10 Bytes`)

```text
03 05 07 04  <DELAY_SEC_B3> <DELAY_SEC_B2> <DELAY_SEC_B1> <DELAY_SEC_B0>  <TEMP_BYTE>  <DRINK_ID>
```

- **Header (`Bytes 0..3`)**: `03 05 07 04`
- **Countdown Delay (`Bytes 4..7`)**: 32-bit unsigned big-endian integer (`uint32 BE`) in **seconds**:
  - `00 00 00 00` (`0 seconds`) = **Brew Immediately**
  - `> 0` (e.g. `00 00 03 84` = `900 seconds` = 15 minutes) = **Schedule Hardware Countdown Brew**. The machine counts down autonomously and can be queried via `06aa3a32` (`6 bytes`).
- **Temperature (`Byte 8`)**:
  - `0x00` = **`MEDIUM`** (Standard Hot ~85°C — default)
  - `0x01` = **`LOW`** (Warm ~80°C)
  - `0x02` = **`HIGH`** (Extra Hot / Max ~90°C)
- **Drink Identifier (`Byte 9`)**:
  - `0x00` = **`RISTRETTO`**
  - `0x01` = **`ESPRESSO`**
  - `0x02` = **`LUNGO`**
  - `0x04` = **`HOT_WATER`**
  - `0x05` = **`AMERICANO`**
  - `0x07` = **`CUSTOM_RECIPE`** (executes the custom volumetric recipe loaded into slot `00 00` via `01 10 08 ...`)

### 4.2 Load Custom Volumetric Recipe & Pour Order (`11 Bytes`)

Before triggering drink ID `0x07`, write this 11-byte recipe formulation frame to `06aa3a42`:

```text
01 10 08  00 00  <STEP1_TYPE> <STEP1_ML_HI> <STEP1_ML_LO>  <STEP2_TYPE> <STEP2_ML_HI> <STEP2_ML_LO>
```

- **Header (`Bytes 0..2`)**: `01 10 08` (`0x08` indicates the 8-byte recipe body that follows)
- **Recipe Slot (`Bytes 3..4`)**: `00 00`
- **Step 1 (`Bytes 5..7`) & Step 2 (`Bytes 8..10`)**:
  - `TYPE`: `0x01` = **Coffee** (`15–130 ml`), `0x02` = **Hot Water** (`25–300 ml`), `0x00` = **Unused / Single-Ingredient Padding** (when the second ingredient volume is `0 ml`).
  - `ML_HI, ML_LO`: 16-bit big-endian volume in milliliters.
  - **Pour Sequence**:
    - **Coffee First (`Coffee → Water`)**: Step 1 = `01 <coffee_hi> <coffee_lo>`, Step 2 = `02 <water_hi> <water_lo>`.
    - **Water First (`Water → Coffee` Long Black)**: Step 1 = `02 <water_hi> <water_lo>`, Step 2 = `01 <coffee_hi> <coffee_lo>`.
    - **Single-Ingredient Recipe** (e.g. `40 ml` Coffee + `0 ml` Water): Step 1 = `01 00 28`, Step 2 = `00 00 00`.

### 4.3 Cancel / Abort Active Brew or Scheduled Timer (`4 Bytes`)

```text
03 06 01 02
```

Writing `03 06 01 02` to `06aa3a42` immediately stops an active extraction or cancels an active scheduled countdown timer. *(Note: `01 00` also halts the pump on older firmware revisions; sending `03 06 01 02` is the primary abort command.)*

### 4.4 Factory Reset Machine (`3 Bytes`)

```text
03 07 00
```

Writing `03 07 00` to `06aa3a42` performs a complete machine factory reset (clears the enrolled pairing key so `06aa3a51` returns to `ABSENT`, and restores factory rotary dial cup volumes).

---

## 5. Machine Configuration Characteristics (`Service 06aa1940`)

### 5.1 Auto-Off Standby Delay & Water Hardness (`06aa3a44`)

Characteristic `06aa3a44` reads and writes a 3-byte configuration structure `[standbySecHi, standbySecLo, waterHardness]`:
- **Standby Delay (`Bytes 0..1`, `uint16 BE` in seconds)**:
  - `540` (`0x021C`) = **9 minutes**
  - `1800` (`0x0708`) = **30 minutes**
  - `7200` (`0x1C20`) = **2 hours**
  - `28800` (`0x7080`) = **8 hours**
- **Water Hardness (`Byte 2`, `uint8`)**:
  - `0` = **Level 0** (Softest, `< 5 fH`)
  - `1` = **Level 1** (`> 7 fH`)
  - `2` = **Level 2** (`> 13 fH`)
  - `3` = **Level 3** (`> 25 fH`)
  - `4` = **Level 4** (Hardest, `> 38 fH`)
- **Partial Updates (`0xFF` Wildcard Mask)**:
  - **Update Standby Delay Only**: Write `[secHi, secLo, 0xFF]`.
  - **Update Water Hardness Only**: Write `[0xFF, 0xFF, level]`.
