# 04 — Custom Volumetric Recipes, Pour Order & Multi-Stage Brewing

This document details the volumetric rules, rotary dial limits, ingredient ordering, split-temperature orchestration, and multi-phase capsule soak mechanics of the **Nespresso Expert EN 350.G**.

---

## 1. Custom Recipe Volumetric Limits (`0x07` Recipe Mode)

When brewing a custom recipe via `06aa3a42` (`01 10 08 ...` followed by `03 05 07 04 ... 07`), the machine's firmware enforces two independent `Zero-or-Range` volumetric validators:

### 1.1 Coffee Extraction Volume (`Ingredient ID = 0x01`)
- **Minimum**: **`0 ml`** (Pure Hot Water recipe) **OR `15 ml`**
- **Maximum**: **`130 ml`** (Max Lungo extraction)
- **Resolution**: `1 ml` increments (`15..130 ml`)
- **Cup Classification by Volume**:
  - `15–25 ml` → **Ristretto**
  - `26–40 ml` → **Espresso**
  - `41–130 ml` → **Lungo**
  - Any Coffee volume (`15–130 ml`) combined with Hot Water (`25–300 ml`) → **Americano / Long Black**

### 1.2 Hot Water Bypass Volume (`Ingredient ID = 0x02`)
- **Minimum**: **`0 ml`** (Pure Coffee recipe) **OR `25 ml`**
- **Maximum**: **`300 ml`**
- **Resolution**: `1 ml` increments (`25..300 ml`)
- **Hardware Routing**: Hot water (`0x02`) is routed exclusively through the **dedicated clean hot-water bypass spout** into the cup and **never passes through the coffee capsule chamber**.

### 1.3 Maximum Combined Recipe Volume
- Up to **`130 ml` Coffee + `300 ml` Hot Water = `430 ml`** in a single custom recipe.

---

## 2. Physical Rotary Dial Programmable Limits (`Service 06aa1940`)

The physical rotary dial on the front of the Nespresso Expert stores its default cup volumes in non-volatile memory, accessed via `06aa3a14` (target slot selector) and `06aa3a24` (`[volHi, volLo, 0xFF, 0xFF]`):

| Rotary Dial Position | Target ID (`06aa3a14`) | Factory Default | Minimum (`ml`) | Maximum (`ml`) |
| :--- | :---: | :---: | :---: | :---: |
| **Ristretto** | `0x0000` | `25 ml` | `15 ml` | `30 ml` |
| **Espresso** | `0x0001` | `40 ml` | `30 ml` | `70 ml` |
| **Lungo** | `0x0002` | `110 ml` | `70 ml` | `130 ml` |
| **Hot Water** | `0x0003` | `200 ml` | `50 ml` | `300 ml` |
| **Americano — Coffee step** | `0x0004` | `25 ml` | `15 ml` | `110 ml` |
| **Americano — Water step** | `0x0005` | `125 ml` | `25 ml` | `300 ml` |
| *(Americano XL Reference)* | *(Custom / Preset)* | **`40 ml` Coffee + `160 ml` Water** | `15–130 ml` Coffee | `25–300 ml` Water |

---

## 3. Ingredient Pour Order (`Coffee → Water` vs. `Water → Coffee`)

The order of the two 3-byte ingredient descriptors inside the 11-byte recipe definition packet (`01 10 08 00 00 ...`) determines which liquid the machine dispenses first:

1. **Coffee First (`Coffee → Water`, Classic Americano)**:
   ```text
   01 10 08  00 00  01 <COFFEE_HI> <COFFEE_LO>  02 <WATER_HI> <WATER_LO>
   ```
   Extracts espresso through the capsule first, then tops up the cup with hot bypass water.

2. **Water First (`Water → Coffee`, Long Black)**:
   ```text
   01 10 08  00 00  02 <WATER_HI> <WATER_LO>  01 <COFFEE_HI> <COFFEE_LO>
   ```
   Dispenses hot bypass water into the cup first, then extracts espresso on top so the golden crema remains undisturbed.

---

## 4. Split-Temperature Two-Stage Brewing ("Great Americano XL")

### 4.1 Single-Command Hardware Constraint
In a standard 1-command recipe trigger (`03 05 07 04 00 00 00 00 <TEMP> 07`), the machine accepts only a single temperature byte (`0x00` Medium ~85°C, `0x01` Low/Warm ~80°C, `0x02` High/Extra Hot ~90°C) for both ingredients.

### 4.2 Two-Stage Client Orchestration
Because the Nespresso Expert uses an instant thermoblock and **Hot Water (`0x02`) does not touch the capsule or trip the `SLIDER_NOT_BEEN_OPENED` (`0x12`) capsule interlock**, Notpresso can execute **Split-Temperature Recipes** (such as **`40 ml` Coffee at High/Max Temp `0x02` + `160 ml` Hot Water at Low/Warm Temp `0x01`**) automatically in two sequential stages:

1. **Stage 1**:
   - Write a single-ingredient recipe for Step 1 (`01 10 08 00 00 01 00 28 00 00 00` for `40 ml` Coffee, or `02 00 A0 00 00 00` if `Water → Coffee`).
   - Trigger brew (`0x07`) with **Stage 1 Temperature** (`03 05 07 04 00 00 00 00 <TEMP_1> 07`).
2. **Stage Handoff Detection**:
   - Monitor `06aa3a12` (`MachineStatus`) notifications until `Byte 1 & 0x0F` transitions from `0x01 (HEAT_UP)` / `0x04 (BREWING)` back to `0x02 (READY)` (with a volumetric duration fallback if BLE notifications are delayed).
3. **Stage 2**:
   - Automatically write the single-ingredient recipe for Step 2 (`01 10 08 00 00 02 00 A0 00 00 00` for `160 ml` Water) and trigger brew (`0x07`) with **Stage 2 Temperature** (`03 05 07 04 00 00 00 00 <TEMP_2> 07`).

---

## 5. Cleaning Capsules & Pre-Infusion ("Bloom Phase") Mechanics

### 5.1 Motorized Brew Chamber & Capsule Auto-Ejection
Unlike manual-lever Nespresso machines (where the capsule remains inside the closed breech until the user lifts the lever), the Nespresso Expert has a **motorized brewing unit**:
- Whenever a coffee extraction command (`0x01`) finishes its target milliliters or is cancelled via `03 06 01 02`, the microcontroller automatically drives the motor to open the brew chamber, dropping the capsule into the waste bin and setting the `SLIDER_NOT_BEEN_OPENED` (`0x12`) interlock flag.

### 5.2 The 5-Minute Firmware Pause Window (`300 Seconds`)
The machine firmware includes a **300-second (5-minute) long-brew pause timeout** (`LONG_BREW_TIMEOUT = 300s`, alongside a `90s` heat-up timeout):
- Whenever the water tank runs dry or is lifted ~1 cm off its base valve mid-extraction (`06aa3a12` `Byte 0 & 0x01 == Water Tank Empty`), **the pump stops immediately while the motorized brew chamber remains clamped closed around the capsule for up to 5 minutes (`300 seconds`)** waiting for water to return and a resume command.

### 5.3 Supported Multi-Phase Soak & Bloom Workflows

1. **Mode 1 — In-Chamber Water-Pause Soak (Keeps Capsule Clamped Inside Chamber)**:
   - Ideal for **Cleaning Capsules** (`30–40 ml` initial detergent dissolve → `60s` soak inside the hot brewing chamber → `130 ml` Max Lungo flush through the *same* capsule without ejecting it) and **Pre-Infusion Coffee Bloom** (`15 ml` wetting → `10–15s` bloom → remaining coffee extraction):
   - **Step 1**: Notpresso starts a single `130 ml` Custom Coffee extraction at `HIGH` temp (`0x02`).
   - **Step 2 (Pause Trigger)**: Once the initial Phase 1 volume (`~15 ml` for Bloom or `~35–40 ml` for Cleaning Capsule) has pumped (either by pre-measuring that water or by lifting the water tank ~1 cm off its base valve), `06aa3a12` sets `Water Tank Empty` (`Byte 0 & 0x01`).
   - **Step 3 (Automatic Soak Countdown)**: Notpresso automatically detects the `Water Tank Empty` bit, starts the `60s` (Cleaning) or `10s` (Bloom) countdown timer (well within the 5-minute hardware timeout), and keeps the capsule clamped inside the chamber.
   - **Step 4 (1-Tap BLE Resume)**: When the countdown completes, seat/refill the water tank and tap **Resume Brew Now (BLE)** in the app to flush the remaining `130 ml` through the exact same capsule.

2. **Mode 2 — Automated Two-Stage BLE Macro (`Stage 1 Brew` → `Countdown Timer` → `Stage 2 Brew`)**:
   - Notpresso sends Stage 1 (`40 ml` Espresso at `HIGH` temp `0x02`, or `15 ml` Bloom), waits for Stage 1 to finish, runs the configurable countdown timer (`60s` or `10s`), and then automatically dispatches Stage 2 (`130 ml` Max Lungo at `HIGH` temp `0x02`, or `200–300 ml` Hot Water flush).
   - If Stage 2 is a second `Coffee (0x01)` pass through a reusable/cleaning capsule, re-dropping the cleaning capsule and flicking the slider open/closed during the `60s` timer (`06aa3a22` confirms slider state live) clears the `0x12` interlock so Stage 2 starts automatically at `00:00`.
