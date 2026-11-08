# 01 — BLE GATT Protocol Reference (Nespresso Expert EN 350.G / D80)

Verified directly from the decompiled Dalvik bytecode of `com.nestle.connecteddevices.nespresso.*` in [`apk/dex/classes5.dex`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/apk/dex/classes5.dex) (see [`raw/dump_all_nestle_sdk.txt`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/raw/dump_all_nestle_sdk.txt)).

---

## 1. UUID Generation Formula (`UuidTemplate.evaluate`)

In `com.nestle.connecteddevices.nespresso.internal.UuidTemplate` (`dump_all_nestle_sdk.txt`, line 2115) and `CoffeeMachineModule` (`line 16394`), all coffee machine service and characteristic UUIDs are derived from:

$$\texttt{Base UUID (`COFFEE\_MACHINE\_SERVICE\_UUID`)} = \texttt{06aa1910-f22a-11e3-9daa-0002a5d5c51b}$$

`UuidTemplate.evaluate(long offset)` replaces the 16-bit field at bits `32..47` (`0x1910` in the base UUID) with `(uint16) offset` in hex (`06aa<HEX_OFFSET>-f22a-11e3-9daa-0002a5d5c51b`).

---

## 2. Complete GATT Services & Characteristics Map

### Service 1: Authentication, Device Info & Onboarding (`06aa1910-f22a-11e3-9daa-0002a5d5c51b`, offset `6416` = `0x1910`)
Implemented in `AuthenticationAdapter`, `OnboardingAdapter`, `MachinePropertiesAdapter` (`dump_auth_onboarding.txt`):

| Characteristic UUID | Offset (Dec / Hex) | SDK Field Name | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a21-f22a-11e3-9daa-0002a5d5c51b` | `14881` (`0x3A21`) | `MACHINE_INFO_CHARACTERISTIC_DESCRIPTION` | Read | 10 bytes | Hardware version (`bytes[0..1]`), Main Firmware version (`bytes[4..5]`), BLE Firmware version (`bytes[6..7]`). |
| `06aa3a31-f22a-11e3-9daa-0002a5d5c51b` | `14897` (`0x3A31`) | `SERIAL_NUMBER_CHARACTERISTIC_DESCRIPTION` | Read | 19 bytes | 19-char ASCII machine serial number (e.g. `17008D80E01877820Ln`). |
| `06aa3a41-f22a-11e3-9daa-0002a5d5c51b` | `14913` (`0x3A41`) | `AUTH_CHARACTERISTIC_DESCRIPTION` | Write | 8 bytes | Session Authentication / Pairing Key (`[0x8X, ...]`). Must be written at the start of every session (`authenticate`). |
| `06aa3a51-f22a-11e3-9daa-0002a5d5c51b` | `14929` (`0x3A51`) | `AUTH_TYPE_CHARACTERISTIC_DESCRIPTION` | Read | 1 byte | `PairingKeyState` (`0` or `1` = `ABSENT`, `2` = `PRESENT`). |
| `06aa3a61-f22a-11e3-9daa-0002a5d5c51b` | `14945` (`0x3A61`) | `TX_LEVEL_REQUEST_CHARACTERISTIC_DESCRIPTION` | Write | 1 byte | Onboarding TX Power level (`[0x01]` = `LOW_LEVEL` to start key enrollment, `[0x00]` = `DEFAULT_LEVEL` to commit). |

### Service 2: Brewing, Commands & Live Machine Monitoring (`06aa1920-f22a-11e3-9daa-0002a5d5c51b`, offset `6432` = `0x1920`)
Implemented in `BrewOperations` (`line 10480`), `MachineMonitoringOperations` (`line 18506`), and `FactoryResetAdapter` (`line 12620`):

| Characteristic UUID | Offset (Dec / Hex) | SDK Field Name | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a12-f22a-11e3-9daa-0002a5d5c51b` | `14866` (`0x3A12`) | `MACHINE_STATUS_CHARACTERISTIC_DESCRIPTION` | Read, Notify | 6–8 bytes | 48-bit real-time machine status bitfield (see Section 3.1). |
| `06aa3a22-f22a-11e3-9daa-0002a5d5c51b` | `14882` (`0x3A22`) | `ADDITIONAL_DATA_CHARACTERISTIC_DESCRIPTION` | Read, Notify | 1–14 bytes | Slider status (`0x00` = Open, `0x02` = Closed) and additional telemetry notifications. |
| `06aa3a32-f22a-11e3-9daa-0002a5d5c51b` | `14898` (`0x3A32`) | `COMMAND_SCHEDULE_CHARACTERISTIC_DESCRIPTION` | Read | 6 bytes | Reads active Scheduled/Delayed Brew (`uint32 BE` seconds remaining, `uint8` temp index, `uint8` scheduleType). |
| `06aa3a42-f22a-11e3-9daa-0002a5d5c51b` | `14914` (`0x3A42`) | `COMMAND_KEY_CHARACTERISTIC_DESCRIPTION` | Write | 3–11 bytes | Primary command endpoint: write recipe (`11B`), trigger/schedule brew (`10B`), abort brew (`4B`), or factory reset (`3B`). |
| `06aa3a52-f22a-11e3-9daa-0002a5d5c51b` | `14930` (`0x3A52`) | `COMMAND_RESPONSE_CHARACTERISTIC_DESCRIPTION` | Read, Notify | 20 bytes | Command execution result (`ACK` `0x20`, `CONDITIONS_NOT_FULFILLED` `0x24`, `OUT_OF_RANGE` `0x36`; see Section 3.2). |

### Service 3: Error Retrieval (`06aa1930-f22a-11e3-9daa-0002a5d5c51b`, offset `6448` = `0x1930`)
Implemented in `ErrorRetrievalOperations` (`dump_all_nestle_sdk.txt`, line 17398):

| Characteristic UUID | Offset (Dec / Hex) | SDK Field Name | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a13-f22a-11e3-9daa-0002a5d5c51b` | `14867` (`0x3A13`) | `errorSelectionDescription` | Write | 1 byte | Write `[0x00]` to select the most recent error record. |
| `06aa3a23-f22a-11e3-9daa-0002a5d5c51b` | `14883` (`0x3A23`) | `errorInformationDescription` | Read | 19+ bytes | Returns `ErrorInformation`: `byte[0]` = `errorNumber`, `byte[1] >> 4` = `ErrorCategory`, `byte[2]` = `errorSubCode`. |

### Service 4: Rotary Dial Cup Sizes, Standby Delay & Water Hardness (`06aa1940-f22a-11e3-9daa-0002a5d5c51b`, offset `6464` = `0x1940`)
Implemented in `CupSizeOperations` (`line 17543`) and `GeneralUserOperations` (`line 16673`):

| Characteristic UUID | Offset (Dec / Hex) | SDK Field Name | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a14-f22a-11e3-9daa-0002a5d5c51b` | `14868` (`0x3A14`) | `WRITE_CUPE_SIZE_TARGET_CHARACTERISTIC_DESCRIPTION` | Write | 2 bytes | Selects which Rotary Dial cup target (`0x0000`..`0x0005`) to read or write on `06aa3a24`. |
| `06aa3a24-f22a-11e3-9daa-0002a5d5c51b` | `14884` (`0x3A24`) | `VOLUME_CHARACTERISTIC_DESCRIPTION` | Read, Write | 4 bytes | Reads `2B` (`[volHi, volLo]`) or writes `4B` (`[volHi, volLo, 0xFF, 0xFF]`) for the target selected on `06aa3a14`. |
| `06aa3a44-f22a-11e3-9daa-0002a5d5c51b` | `14916` (`0x3A44`) | `GeneralUserOperations.CHARACTERISTIC_DESCRIPTION` | Read, Write | 3–4 bytes | `[standbySecHi, standbySecLo, waterHardnessLevel]` (`0xFF` = `NO_EFFECT` / leave unchanged). |

### Service 5: Capsule Stock Counter (`06aa1950-f22a-11e3-9daa-0002a5d5c51b`, offset `6480` = `0x1950`)
Implemented in `StockOperations` (`dump_all_nestle_sdk.txt`, line 16999):

| Characteristic UUID | Offset (Dec / Hex) | SDK Field Name | Props | Size | Description |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `06aa3a15-f22a-11e3-9daa-0002a5d5c51b` | `14869` (`0x3A15`) | `STOCK_CHARACTERISTIC_DESCRIPTION` | Read, Write | 2 bytes | Remaining capsule stock counter (`uint16 BE`, or `0xFFFF` = `DEACTIVATION_VALUE`). |
| `06aa3a25-f22a-11e3-9daa-0002a5d5c51b` | `14885` (`0x3A25`) | `STOCK_THRESHOLD_CHARACTERISTIC_DESCRIPTION` | Read, Write | 2 bytes | Low-capsule warning threshold (`uint16 BE`). |
| `06aa3a35-f22a-11e3-9daa-0002a5d5c51b` | `14901` (`0x3A35`) | `STOCK_KEY_CHARACTERISTIC_DESCRIPTION` | Read, Write | 4 bytes | 32-bit stock sync transaction ID (`WriteStockKey`). |

---

## 3. Exact Telemetry & Response Byte Layouts

### 3.1 `MachineStatus` (`06aa3a12`) — 48-Bit Bitfield (`MachineMonitoringOperations.fromByteToBuilder`)

In `ByteConversion.selectBit(byte[] data, int startBit, int endBit)` (`line 2746`), **bit `0` is the MSB (`0x80`) of `Byte 0`**, and bit `7` is the LSB (`0x01`) of `Byte 0`:

| Byte | Bit Range (MSB=0) | Bitmask in Byte | SDK Builder Method | Meaning |
| :---: | :---: | :---: | :--- | :--- |
| **Byte 0** | `Bit 0` | `b[0] & 0x80` | `withBootloaderActive` | `1` = Bootloader active |
| **Byte 0** | `Bits 1..2` | `(b[0] >> 5) & 0x03` | `withPairingKeyState` | `0` or `1` = `ABSENT`, `2` = `PRESENT` |
| **Byte 0** | `Bit 3` | `b[0] & 0x10` | `withErrorPresent` | `1` = Hardware error present |
| **Byte 0** | `Bit 5` | `b[0] & 0x04` | `withDescalingNeeded` | `1` = Descaling required |
| **Byte 0** | `Bit 7` | `b[0] & 0x01` | `withWaterTankEmpty` | `1` = **Water Tank Empty** (also set when tank is lifted/empty mid-brew!) |
| **Byte 1** | `Bit 9` | `b[1] & 0x40` | `withCapsuleContainerFull` | `1` = **Used Capsule Container Full** |
| **Byte 1** | `Bits 12..15` | `b[1] & 0x0F` | `withMachineState` | `MachineState` enum (`0..15`, see table below) |
| **Byte 2** | `Bit 16` | `b[2] & 0x80` | `withCapsuleStockLow` | `1` = Capsule stock below warning threshold |
| **Bytes 2–3** | `Bits 17..26` | `((b[2] & 0x7F) << 3) \| (b[3] >> 5)` | `withCapsuleStockCounter` | 10-bit remaining capsule stock counter (`0..1023`) |
| **Byte 3** | `Bit 27` | `b[3] & 0x10` | `withProgrammedBrewingActive` | `1` = **Scheduled / Delayed Brew timer is currently active** |
| **Byte 3** | `Bits 28..29` | `(b[3] >> 2) & 0x03` | `withProgrammedBrewEventCounter` | 2-bit rolling counter for scheduled brew changes |
| **Byte 3** | `Bits 30..31` | `b[3] & 0x03` | `withCapsuleStockEventCounter` | 2-bit rolling counter for capsule stock changes |
| **Byte 4** | `Bits 32..33` | `(b[4] >> 6) & 0x03` | `withBlockedMachineEventCounter` | 2-bit rolling counter for blocked machine events |
| **Byte 5** | `Bit 46` | `!(b[5] & 0x02)` | `withSliderOpen` | Inverted bit 46: `bit == 0` -> **Slider OPEN**, `bit == 1` -> **Slider CLOSED** |
| **Byte 5** | `Bit 47` | `b[5] & 0x01` | `withObstacleDetected` | `1` = Obstacle / jam detected in slider/brew unit |

#### `MachineState` Enum (`Byte 1 & 0x0F`, `MachineStateBuilder.defaultMachineStateFrom`, `line 2566`):
| Value | Hex | SDK Constant | Meaning |
| :---: | :---: | :--- | :--- |
| `0` | `0x00` | `RESET` | Machine resetting / initializing |
| `1` | `0x01` | `HEAT_UP` | Heating up thermoblock |
| `2` | `0x02` | `READY` | Ready to brew |
| `3` | `0x03` | `DESCALING_READY` | Ready to start descaling |
| `4` | `0x04` | `BREWING` | Actively brewing / pumping |
| `5` | `0x05` | `ADVANCED_SELECTION_MENU` | Rotary dial in advanced selection menu |
| `6` | `0x06` | `DESCALING` | Descaling cycle in progress |
| `7` | `0x07` | `STEAM_OUT` | Purging / steaming out water circuit |
| `8` | `0x08` | `ERROR` | Error state |
| `9` | `0x09` | `POWER_SAVE` | Sleeping / Standby power-save mode |
| `10` | `0x0A` | `OVER_HEAT` | Overheated cooldown |
| `11` | `0x0B` | `DIAGNOSTIC_MODE` | Factory diagnostic mode |
| `12` | `0x0C` | `BLE_SETTINGS` | Bluetooth settings mode |
| `13` | `0x0D` | `FACTORY_RESET` | Performing factory reset |
| `14` | `0x0E` | `WATER_HARDNESS_SETTINGS` | Water hardness configuration mode |
| `15` | `0x0F` | `STAND_BY_DELAY_SETTINGS` | Auto-off standby delay configuration mode |

---

### 3.2 `CommandResponse` (`06aa3a52`) — Exact Rejection & ACK Decoding

Decoded in `CommandResponseBuilder.from(ByteBuffer)` (`dump_all_nestle_sdk.txt`, lines 3289–3374):
- The SDK slices `Arrays.copyOfRange(bytes, 3, 19)`, so **`bytes[3]` is the `ResponseCode`** and **`bytes[4]` is the `ConditionNotFulfilled` subcode**:
  - `bytes[3] == 0x20` (`32`): **`ACK` (`CommandResponse.DONE`)** — Command accepted!
  - `bytes[3] == 0x36` (`54`): **`OUT_OF_RANGE` (`CommandResponse.OUT_OF_RANGE`)** — Requested volume or parameter is out of hardware bounds.
  - `bytes[3] == 0x24` (`36`): **`CONDITIONS_NOT_FULFILLED`** — Inspect **`bytes[4]`**:

| `bytes[4]` (Dec / Hex) | SDK `CommandResponse` Constant | Human-Readable Cause |
| :---: | :--- | :--- |
| `1` (`0x01`) | `INVALID_STATE` | Machine is in an invalid state for this command |
| `2` (`0x02`) | `INVALID_STATE` | Machine is in an invalid state for this command |
| `3` (`0x03`) | `CAPSULE_CONTAINER_FULL` | Spent capsule container is full |
| `4` (`0x04`) | `OBSTACLE_DETECTED` | Obstacle detected in brew chamber / slider |
| `5` (`0x05`) | `DESCALE_ON` | Machine is in descaling mode |
| `6` (`0x06`) | `LAST_ACTION_NOT_FINISHED` | Previous action is still running |
| `7` (`0x07`) | `NOT_ABORTABLE_ACTION` | Current action cannot be aborted |
| `8` (`0x08`) | `SLIDER_OPEN` | **Capsule slider is open** — close the slider to brew |
| `9` (`0x09`) | `NO_PROGRAMMED_BREW_ACTIVE` | No scheduled brew is currently active to cancel |
| `16` (`0x10`) | `PUMP_RUNNING` | Pump is already running |
| `17` (`0x11`) | `MOTOR_RUNNING` | Brew-unit motor is currently moving |
| `18` (`0x12`) | `SLIDER_NOT_BEEN_OPENED` | **Capsule not changed** — open and close the slider to load a fresh capsule |

*(Note: Some firmware revisions also report a 4-byte response where `bytes[0]` has high bits `0xC0` and `bytes[2] == 0x24`, `bytes[3] == subcode`. Both layouts should be checked by client parsers.)*

---

## 4. Command Payloads Written to `06aa3a42` (`CommandKey`)

### 4.1 Brew Now OR Schedule Delayed Brew (`10 Bytes`, `BrewByteConversion.getProgrammedBrewPayload`)

```text
03 05 07 04  <DELAY_SEC_B3> <DELAY_SEC_B2> <DELAY_SEC_B1> <DELAY_SEC_B0>  <TEMP_BYTE>  <COFFEE_TYPE_ID>
```

- **Prefix (`Bytes 0..3`)**: `03 05 07 04` (`PROGRAMMED_BREW_PREFIX`)
- **Delay Timer (`Bytes 4..7`)**: 32-bit unsigned big-endian integer (`uint32 BE`) in **seconds**:
  - `00 00 00 00` (`0 seconds`) = **Brew Immediately (`BREW_NOW_TIME = 0`)**
  - `> 0` (e.g. `00 00 03 84` = `900 seconds` = 15 minutes) = **Schedule Hardware Countdown Brew** (`writeScheduleBrewWithTemperature`). Read back via `06aa3a32` (`6 bytes`).
- **Temperature (`Byte 8`, `TemperatureConversion.fromTemperature`)**:
  - `0x00` = **`MEDIUM`** (Standard Hot ~85°C — default)
  - `0x01` = **`LOW`** (Warm ~80°C)
  - `0x02` = **`HIGH`** (Extra Hot / Max ~90°C)
- **Drink / Coffee Type (`Byte 9`, `BrewOperations`)**:
  - `0x00` = **`RISTRETTO`** (`RISTRETTO_ID = 0`)
  - `0x01` = **`ESPRESSO`** (`ESPRESSO_ID = 1`)
  - `0x02` = **`LUNGO`** (`LUNGO_ID = 2`)
  - `0x04` = **`HOT_WATER`** (`HOT_WATER_ID = 4`)
  - `0x05` = **`AMERICANO`** (`AMERICANO_ID = 5`)
  - `0x07` = **`RECIPE`** (`RECIPE_ID = 7` — executes the custom recipe loaded via `01 10 08 ...`)

### 4.2 Load Custom Recipe Volumes & Order (`11 Bytes`, `BrewByteConversion.getSetRecipePayload`)

Before triggering drink ID `0x07`, write this 11-byte recipe definition to `06aa3a42`:

```text
01 10 08  00 00  <STEP1_TYPE> <STEP1_ML_HI> <STEP1_ML_LO>  <STEP2_TYPE> <STEP2_ML_HI> <STEP2_ML_LO>
```

- **Prefix (`Bytes 0..2`)**: `01 10 08` (`RECIPE_PREFIX`, where `0x08` is the 8-byte payload length that follows)
- **Recipe Slot (`Bytes 3..4`)**: `00 00` (`RECIPE_ID`)
- **Step 1 (`Bytes 5..7`) & Step 2 (`Bytes 8..10`)**:
  - `TYPE`: `0x01` = **Coffee** (`15–130 ml`), `0x02` = **Hot Water** (`25–300 ml`), `0x00` = **Unused/Padding** (when the second ingredient is `0 ml`).
  - `ML_HI, ML_LO`: 16-bit big-endian volume in milliliters.
  - **Order**:
    - `COFFEE_THEN_WATER`: Step 1 is `01 <coffee_hi> <coffee_lo>`, Step 2 is `02 <water_hi> <water_lo>`.
    - `WATER_THEN_COFFEE` (Long Black): Step 1 is `02 <water_hi> <water_lo>`, Step 2 is `01 <coffee_hi> <coffee_lo>`.
    - Single-ingredient recipe (e.g. `40 ml` Coffee + `0 ml` Water): Step 1 is `01 00 28`, Step 2 is `00 00 00`.

### 4.3 Cancel / Abort Active Brew or Scheduled Timer (`4 Bytes`, `BrewOperations.ABORT_ACTION_PAYLOAD`)

```text
03 06 01 02
```

Writing `03 06 01 02` to `06aa3a42` immediately aborts an active extraction or clears a scheduled countdown brew.

### 4.4 Factory Reset Machine (`3 Bytes`, `FactoryResetAdapter.PAYLOAD`)

```text
03 07 00
```

Writing `03 07 00` to `06aa3a42` triggers a full machine factory reset (clears the stored pairing key so `06aa3a51` returns to `ABSENT`, and restores factory cup volumes).

---

## 5. Machine Configuration Characteristics (`Service 06aa1940`)

### 5.1 Auto-Off Standby Delay & Water Hardness (`06aa3a44`, `GeneralUserOperations`)

Characteristic `06aa3a44` uses a 3-byte format `[standbySecHi, standbySecLo, waterHardness]` (reads allocate a 4-byte buffer):
- **Read (`06aa3a44`)**:
  - `Bytes 0..1` (`uint16 BE`): Standby delay in **seconds**:
    - `540` (`0x021C`) = **`NINE_MINUTES` (9 min)**
    - `1800` (`0x0708`) = **`THIRTY_MINUTES` (30 min)**
    - `7200` (`0x1C20`) = **`TWO_HOURS` (2 hours)**
    - `28800` (`0x7080`) = **`EIGHT_HOURS` (8 hours)**
  - `Byte 2` (`uint8`): Water hardness level (`0` = `LEVEL_0` softest / fH < 5, `1` = `LEVEL_1`, `2` = `LEVEL_2`, `3` = `LEVEL_3`, `4` = `LEVEL_4` hardest / fH > 38).
- **Write Standby Delay Only**: `[secHi, secLo, 0xFF]` (`0xFF` = `NO_EFFECT` for water hardness).
- **Write Water Hardness Only**: `[0xFF, 0xFF, level]` (`0xFFFF` = `NO_EFFECT` for standby delay).
