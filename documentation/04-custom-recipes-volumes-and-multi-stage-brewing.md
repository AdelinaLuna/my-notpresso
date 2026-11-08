# 04 — Custom Recipes, Volume Limits & Multi-Stage Brewing

Extracted from `com.nespresso.connect.model.*`, `com.nespresso.connect.ui.machines.createrecipe.*`, and `com.nestle.connecteddevices.nespresso.*` in [`apk/nespresso-3-28-0.apk`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/apk/nespresso-3-28-0.apk) (see [`raw/dump_zeroorrange.txt`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/raw/dump_zeroorrange.txt), [`raw/dump_recipe_limits.txt`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/raw/dump_recipe_limits.txt), and [`raw/dump_createrecipe.txt`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/raw/dump_createrecipe.txt)).

---

## 1. Custom Recipe Volume Limits (`ZeroOrRangeValue`)

In `com.nespresso.connect.model.ZeroOrRangeValue` (`classes4.dex`, `codeOff=0x39b1d0`), the official application defines two specialized range validators for custom recipes (`RecipeBrew`):

### 1.1 Coffee Extraction Volume (`ZeroOrRangeValue$CoffeeRecipeCupSize`)
- **Minimum**: **`0 ml`** (Water-only recipe) **OR `15 ml`** (`MIN_COFFEE_VOLUME = 15`)
- **Maximum**: **`130 ml`** (`MAX_COFFEE_VOLUME = 130`)
- **Granularity**: `1 ml` increments (`Range.open(15, 130)`)
- **Automatic Classification (`EditableRecipeMapper.getMatchingVolume`, `codeOff=0x39dbec`)**:
  When Hot Water is `0 ml`, the app classifies the recipe icon by coffee volume:
  - `15–25 ml` -> `RISTRETTO`
  - `26–40 ml` -> `ESPRESSO`
  - `41–130 ml` -> `LUNGO`
  - When Hot Water is `>= 25 ml` -> `AMERICANO` (even if Coffee is up to `130 ml`!).

### 1.2 Hot Water Bypass Volume (`ZeroOrRangeValue$HotWaterRecipeVolumeSize`)
- **Minimum**: **`0 ml`** (Coffee-only recipe) **OR `25 ml`** (`MIN_HOT_WATER_VOLUME = 25`)
- **Maximum**: **`300 ml`** (`MAX_HOT_WATER_VOLUME = 300`)
- **Granularity**: `1 ml` increments (`Range.open(25, 300)`)
- **Hardware Routing**: Hot water (`Ingredient.WATER = 0x02`) is dispensed via the dedicated clean-water bypass spout and **never passes through the capsule chamber**.

### 1.3 Maximum Combined Custom Recipe Volume
- Up to **`130 ml` Coffee + `300 ml` Hot Water = `430 ml`** in a single custom recipe!

---

## 2. Physical Rotary Dial Programmable Limits (`CupSizeInterval` & `CupSizeConfiguration`)

In `com.nestle.connecteddevices.nespresso.models.expert.CupSizeInterval` (`classes5.dex`, `codeOff=0x32589c`) and `CupSizeConfiguration` (`codeOff=0x325518`), the physical rotary dial positions programmed via Service `06aa1940` (`06aa3a14` target + `06aa3a24` volume) enforce the following hardware limits:

| Rotary Dial Position | Target ID (`06aa3a14`) | Factory Default (`ml`) | Min (`lowerLimit`) | Max (`upperLimit`) |
| :--- | :---: | :---: | :---: | :---: |
| **Ristretto** | `0x0000` | `25 ml` | `15 ml` | `30 ml` |
| **Espresso** | `0x0001` | `40 ml` | `30 ml` | `70 ml` |
| **Lungo** | `0x0002` | `110 ml` | `70 ml` | `130 ml` |
| **Hot Water** | `0x0003` | `200 ml` | `50 ml` | `300 ml` |
| **Americano — Coffee step** | `0x0004` | `25 ml` | `15 ml` | `110 ml` |
| **Americano — Water step** | `0x0005` | `125 ml` | `25 ml` | `300 ml` |
| *(SDK `AMERICANO_XL` preset)* | `0x0005` / `0x0006` | **`40 ml` Coffee + `160 ml` Water** | `20–110 ml` Coffee | `25–300 ml` Water |

---

## 3. Ingredient Pour Order (`IngredientSequence`)

In `com.nespresso.connect.model.IngredientSequence` (`classes4.dex`, `codeOff=0x39a7d8`) and `EditableRecipeMapper.getIngredients` (`codeOff=0x39db64`), the order of the two 3-byte ingredient descriptors inside the 11-byte `writeRecipe` payload (`01 10 08 00 00 ...`) determines which liquid is dispensed first:

1. **`COFFEE_THEN_WATER` (Classic Americano)**:
   ```text
   01 10 08  00 00  01 <COFFEE_HI> <COFFEE_LO>  02 <WATER_HI> <WATER_LO>
   ```
2. **`WATER_THEN_COFFEE` (Long Black — preserves crema on top)**:
   ```text
   01 10 08  00 00  02 <WATER_HI> <WATER_LO>  01 <COFFEE_HI> <COFFEE_LO>
   ```

---

## 4. Split-Temperature Two-Stage Brewing ("Great Americano")

### 4.1 Protocol Constraint in Native Single-Command Recipes
In `RecipeBrewAdapter$1.brew(RecipeBrewParameters)` (`dump_expert_adapters.txt`, lines 329–376), the machine accepts one temperature byte (`0x00` Medium ~85°C, `0x01` Low ~80°C, `0x02` High ~90°C) in the 10-byte execution command (`03 05 07 04 00 00 00 00 <TEMP> 07`).

### 4.2 Two-Stage BLE Orchestration
Because the Nespresso Expert uses an instant thermoblock and **Hot Water (`0x02`) does not touch the capsule or trip the `SLIDER_NOT_BEEN_OPENED` (`0x12`) capsule interlock**, any recipe with different temperatures for Coffee and Water (e.g. **`40 ml` Coffee at `HIGH` temp (`0x02`) + `160 ml` Water at `LOW` temp (`0x01`)**) can be executed automatically by the client in two sequential stages:

1. **Stage 1**:
   - Write single-ingredient recipe for Step 1 (`01 10 08 00 00 01 00 28 00 00 00` for `40 ml` Coffee, or `02 00 A0 00 00 00` if `Water → Coffee`).
   - Trigger brew (`0x07`) with **Stage 1 Temperature** (`03 05 07 04 00 00 00 00 <TEMP_1> 07`).
2. **Stage Transition Detection**:
   - Monitor `06aa3a12` (`MachineStatus`) notifications until `Byte 1 & 0x0F` transitions from `0x01 (HEAT_UP)` / `0x04 (BREWING)` back to `0x02 (READY)` (with a calculated duration fallback if notifications are delayed).
3. **Stage 2**:
   - Immediately write the single-ingredient recipe for Step 2 (`01 10 08 00 00 02 00 A0 00 00 00` for `160 ml` Water) and trigger brew (`0x07`) with **Stage 2 Temperature** (`03 05 07 04 00 00 00 00 <TEMP_2> 07`).

---

## 5. Cleaning Capsules & Pre-Infusion ("Bloom Phase") Mechanics

### 5.1 Why the Expert Automatically Ejects Capsules After Coffee Extraction
Unlike manual lever Nespresso machines (where the brew chamber stays closed until you lift the lever), the Nespresso Expert has a **motorized brewing unit**.
- When a coffee extraction command (`0x01`) completes its target milliliters (or is cancelled via `03 06 01 02`), the machine's microcontroller automatically drives the motor to open the brew chamber, dropping the capsule into the waste bin and setting the `SLIDER_NOT_BEEN_OPENED` (`0x12`) interlock flag.

### 5.2 Firmware Pause Window (`BrewOperations.LONG_BREW_TIMEOUT = 300 Seconds`)
In `BrewOperations.monitorLongBrew()` (`dump_all_nestle_sdk.txt`, lines 10901–10907), Nespresso's SDK defines:
- `LONG_HEAT_UP_TIMEOUT = 90` seconds (`0x5A`)
- **`LONG_BREW_TIMEOUT = 300` seconds (`0x012C` = 5 minutes!)**

When the water tank becomes empty or is lifted slightly off its base valve mid-extraction (`06aa3a12` `Byte 0 & 0x01 == Water Tank Empty`), **the pump stops immediately while the motorized brew chamber remains clamped closed around the capsule** for up to **5 minutes (`300 seconds`)** waiting for water to return and a resume command!

### 5.3 Supported Multi-Phase Soak / Bloom Workflows

1. **Mode 1 — In-Chamber "Water-Tank Lift Pause" Soak (Keeps Capsule Clamped Inside Chamber)**:
   - Ideal for **Cleaning Capsules** (e.g. `30–40 ml` initial run -> `60s` detergent soak -> `130 ml` full Lungo flush on the *same* capsule without dropping it) or **Pre-Infusion Bloom** (`15 ml` wet -> `10–15s` bloom -> remaining coffee extraction):
   - **Step 1**: App starts a single `130 ml` Custom Coffee extraction at `HIGH` temp (`0x02`).
   - **Step 2 (Pause Point)**: After the Phase 1 volume (`~15 ml` for Bloom or `~35 ml` for Cleaning Capsule) has pumped (or when the pre-measured water runs out), the user slightly lifts the water tank (`~1 cm`) off its valve (or lets it run dry).
   - **Step 3 (Automatic Soak Timer)**: The app detects `Water Tank Empty` (`Byte 0 & 0x01` on `06aa3a12`) or user tap, starts the exact countdown timer (`60s` for Cleaning Capsule, `10s` for Bloom — well within the firmware's `300s` timeout), and keeps the capsule clamped inside the hot chamber.
   - **Step 4 (1-Tap BLE Resume)**: When the timer finishes, the user seats the water tank back down and taps **Resume Extraction** in the app (which re-sends the brew trigger over BLE to finish pumping the remaining `130 ml` through the capsule!).

2. **Mode 2 — Automated Two-Stage Macro (`Phase 1 Brew` -> `Countdown Timer` -> `Phase 2 Brew`)**:
   - App sends Phase 1 (`40 ml` Espresso at `HIGH` temp `0x02`, or `15 ml` Bloom), runs the configurable countdown timer (`60s` or `10s`), and then automatically sends Phase 2 (`130 ml` Max Lungo at `HIGH` temp `0x02`, or `200–300 ml` Hot Water spout flush).
   - If Phase 2 is a second `Coffee (0x01)` pass through a reusable/cleaning capsule, the user simply drops the cleaning capsule back into the top slot (or catches it before the bin) and flicks the slider open/closed during the `60s` timer (`06aa3a22` confirms slider state live), and Phase 2 fires automatically when the countdown reaches `00:00`.
