# Notpresso Expert (EN 350.G)

<div align="center">
  <h3>Standalone Offline BLE Alternative for Nespresso Expert EN 350.G</h3>
  <p><strong>Zero Cloud Accounts • Per-Cup Temp Override • Visual Descaling Guide • Live LED Telematics • In-App Manual • Favorites & Library • Split-Temp Recipes • 100% Offline</strong></p>
</div>

---

## 1. Background & Why This Exists

Nespresso officially discontinued Bluetooth onboarding and support for the **Nespresso Expert EN 350.G** in their modern Android mobile app. Furthermore, recent versions of their app force continuous cloud logins (frequently logging users out) and are actively phasing out legacy Bluetooth Original-line machines entirely.

**Notpresso Expert** provides an open-source, local-first alternative designed to run directly on your smartphone (such as the **Samsung Galaxy S24 Ultra / OneUI 9**) via the **Web Bluetooth API** (Progressive Web App) or as a standalone native Android APK (`android-apk` branch).

---

## 2. What's New in v0.5.0 – v0.13.6

- **`v0.13.6` — Offline-First Unified Dial Calibration Sync**: Active calibration profiles (`My App Calibration` by default, or `Factory Defaults`), `#selectCupTarget` option text (`Default <ml>ml`), Custom quick-chips, and Presets subtitles/volume labels now stay 100% synced everywhere without requiring a BLE connection first; saved `localStorage` values are no longer overwritten on boot.
- **`v0.13.5` — Personalized Dial & Preset Volume Labels**: Connect telemetry now reads all 6 rotary dial targets `[0..5]`, persists them in `localStorage` (`notpresso_machine_dial_v1`), updates Presets subtitles/defaults, and derives slider volume labels solely from your synced machine settings instead of hardcoded OEM values.

- **`v0.13.4` — Desktop 2nd-Stage Slider Drag Fix**: Stage reordering now only touches the DOM when the order actually changes, so dragging the 2nd stage volume slider with a mouse no longer stops after one step.

- **`v0.13.3` — Stage-Order Emoji Sync & Prefix Volume Badges**:
  - Synchronized two-stage preset card emoji icons (`☕💧` for `Coffee → Water`, `💧☕` for `Water → Coffee`) and subtitles with the selected stage order.
  - Displayed known drink/limit tags **in front of** the `ml` badge on Presets sliders (e.g., `(Lungo) 110 ml`, `(Espresso) 40 ml`, `(Americano) 125 ml`, `(Hot Water) 250 ml`) so right-edge alignment stays fixed.

- **`v0.13.2` — Unified Two-Phase Cards, Dial-Synced Americano & Water-First XL**:
  - Unified **Great Americano XL** styling with `Americano` (removed `highlight-card` and `Split-Temp` badge, standardized on `Brew` actions) since both now support per-stage 3x temperatures and stage swapping.
  - Configured **Americano** to automatically adopt the machine's rotary dial targets `4` & `5` (or factory `25ml Coffee → 125ml Water @ Hot 85°C` fallback), and **Great Americano XL** to default to the reverse **`160ml Water (Warm 80°C) → 40ml Coffee (Max 90°C)`** order.
  - Updated **Hot Water** preset defaults to **`250 ml` @ `Max ~90°C`**.

- **`v0.13.1` — Consistent Stage Brew Temperature UI & One-Tap Stage Swap**:
  - Unified the two-phase stage `"Brew Temperature"` label and active chip styling (`Americano`, `Great Americano XL`, and Custom Builder) to match single-stage preset cards (`Lungo`).
  - Replaced long-press stage drag-and-drop with a dedicated **`⇅ Swap Stage Order (1st ↔ 2nd)`** button between Coffee and Water stages so volume sliders never accidentally trigger reordering.

- **`v0.13.0` — Two-Phase Per-Stage 3x Temperatures & Stage Reordering (`#18`)**:
  - Removed the separate `"Split"` temperature button from two-phase preset cards (`Americano`, `Great Americano XL`) and the Custom Recipe builder in favour of **3x individual temperature selectors (`Warm ~80°C`, `Hot ~85°C`, `Max ~90°C`) on both Coffee and Water stages**, automatically choosing single-stage vs two-stage split brewing when stage temperatures differ.

- **`v0.12.0` — 5-Second Logo Long-Press Cache Reset & Offline Cache-First SW**:
  - Kept [sw.js](sw.js) **Cache-First** for instant offline launches while registering with `{ updateViaCache: 'none' }`.
  - Added a **5-second hold** on the header logo icon with a live `5s → 1s` countdown overlay and version-badge indicator (`↻ 5s`) that unregisters Service Workers, clears Cache Storage (keeping `localStorage` keys/recipes intact), and reloads with `?refresh=`.

- **`v0.11.0` — Automated Unit, DOM & Python Regression Test Suite**: Zero-dependency Node and Python suites (`tests/test_app.js`, `tests/test_python.py`) covering BLE codecs, payload framing, multi-stage/rinse/top-up workflows, Service Worker offline caching, `server.py` security, `extract_auth_key.py`, and historical bug fixes, plus single-source `APP_VERSION` propagation.

- **`v0.10.0` — 10-Second Post-Brew Auto-Eject Countdown & 1-Tap Top-Up (Manual p. 11)**:
  - Keeps the brew modal open for 10s after normal brew completion with a live countdown to automatic capsule ejection, dismissible anytime (`Done / Close`), plus `+15 ml Coffee` and `+25 ml Hot Water` top-up buttons locked to the completed brew's temperature.

- **`v0.9.0` — 1-Tap System Rinse & Streamlined Machine/Settings Layout**:
  - **Machine Diagnostics & Maintenance Promoted to Top of `Machine` Tab**: Quick access to Serial, Firmware, Capsule Stock, Descale Alert, Low-Stock Threshold, Fault History, and System Rinse without scrolling past cup-size calibration.
  - **First-Use / Post-Weekend System Rinse (`3x Lungo + 2x Hot Water`, Manual pp. 7, 10)**: Automated 5-shot sequential rinse workflow with empty-chamber/slider safety check, Manual checklist (`>= 650 ml` container), live `06aa3a12` step auto-advancement (`Shots 1–3 Lungo` via coffee outlet -> `Shots 4–5 Hot Water` via dedicated water spout), and 1-tap `Stop`.
  - **Settings Modal Factory Reset & Header Access**: Removed the duplicate onboarding button from the Machine tab (header ⚙️ icon already opens Settings & Pairing Key) and moved **⚠️ Send BLE Factory Reset (`03 07 00`)** to the bottom of the Settings modal.

- **`v0.8.0` — Hardware Fault History (`06aa1930`) & Low-Stock Threshold (`06aa3a25`)**:
  - Inspect stored error slots `0–9` via `06aa3a13` + `06aa3a23` (`errorNumber`, category `NONE/INFO/WARN/ERROR/FATAL`, `subCode`) and configure the `06aa3a25` low-capsule warning threshold.

- **`v0.7.0` — BLE Capsule Stock Counter (`06aa3a15`) & Maintenance Fixes (`v0.7.1–v0.7.3`)**:
  - Read/write hardware capsule stock (`0–1000`) or disable with `0xFFFF`, plus aligned Water Hardness defaults (`Level 3 — Hard`) and Manual p. 15 physical Factory Reset docs.

- **`v0.5.0 – v0.6.0` — Per-Cup Temp Override, Drag Reorder & Expandable Home Presets**:
  - Tappable expandable home preset cards (Hot Water first) with ad-hoc sliders, per-cup temperature override pills on saved recipes, and long-press drag reordering.

### Core Platform Capabilities (v0.4.0 Foundation)

`v0.4.0` adds interactive machine maintenance, real-time LED telematics, and built-in official documentation while preserving all `v0.3.0` and `v0.2.0` features:

1. **8-Step Interactive Visual Descaling Guide & BLE Prep (`Machine` Tab)**:
   - Live simulated front panel (`visSlider`, `visBrewBtn`, `visMaintLed`, `visBevDial`, `visTempDial`, `visOutlet`, `visTank`), "What to Do" / "What to Expect" cards, automatic step tracking from `06aa3a12` notifications, and 1-tap BLE prep (`prepareDescaleViaBle()`).
2. **Live BLE LED Telematics Banner**:
   - Real-time plain-text interpretation of the front panel LEDs from `06aa3a12` (`Descaling Needed`, `Water Tank Empty`, `Capsule Bin Full`, `Slider Open`, `Low Capsule Stock`, `Heating Up`, `Overheated`, `Settings Mode`) per Manual p. 21.
3. **Built-In Official User Manual (`📖` Header Button)**:
   - Embedded [`NespressoExpertEN350G.pdf`](documentation/NespressoExpertEN350G.pdf) viewer plus instant offline structured reader with search and section jump chips.
4. **⭐ My Favorites & Suggestions (Home Presets Tab, v0.3.0)**:
   - Displays your top favorite recipes right on the main home screen below the expandable quick-brew presets (`Hot Water` first, followed by coffee presets with per-drink ad-hoc volume/temp sliders in `v0.6.0`).
   - 1-tap brew access, **per-cup temperature override (`80°` Warm / `85°` Hot / `90°` Max / `Split`)** without duplicating saved recipes (`v0.5.0`), and 1-tap edit button without needing to switch tabs.
5. **Curated Nespresso App Favorites Pre-Seeded (v0.3.0)**:
   - Includes all 9 custom recipes from the official Nespresso app:
     - **Water Lungo Extra Hot** (`0 ml` Coffee + `270 ml` Water, Extra Hot ~90°C)
     - **Water Lazy Hot Pots** (`0 ml` Coffee + `200 ml` Water, Extra Hot ~90°C)
     - **Espresso Long Americano** (`40 ml` Coffee + `160 ml` Water, Extra Hot ~90°C, Coffee first)
     - **Espresso Medium Americano** (`40 ml` Coffee + `120 ml` Water, Hot ~85°C, Coffee first)
     - **Espresso Short Americano** (`40 ml` Coffee + `70 ml` Water, Warm ~80°C, Coffee first)
     - **Ristretto Lungo Americano** (`25 ml` Coffee + `115 ml` Water, Hot ~85°C, Coffee first)
     - **Ristretto Medium American** (`25 ml` Coffee + `85 ml` Water, Hot ~85°C, Coffee first)
     - **Ristretto Short Americano** (`25 ml` Coffee + `55 ml` Water, Warm ~80°C, Coffee first)
     - **Cleaning Capsules** (`130 ml` Coffee + `0 ml` Water, Extra Hot ~90°C)
     - Plus **Great Americano XL (Split-Temp)** and multi-stage **Cleaning Capsule / Pre-Infusion Bloom** cycles.
6. **Full Library Organization, Reordering & Renaming (v0.3.0)**:
   - **Reordering**: Long-press and hold (`⋮⋮` handle or card) to drag items directly to any position in Favorites or Library (`v0.5.1`).
   - **Renaming**: Inline ✏️ Rename modal for changing any recipe name anytime.
   - **Edit / Tweak**: 🎛️ Edit button that loads any existing recipe back into the Custom or Bloom builder for tweaking.
   - **Restore Curated**: 1-tap button to restore the Nespresso app suggestions if desired.
7. **Named Custom Recipes & Cycles (v0.3.0)**:
   - Direct recipe name input fields in both Custom Recipe (`inputCustomRecipeName`) and Bloom Lab (`inputBloomRecipeName`) builders before saving.
8. **Physical Rotary Dial Cup-Size Calibration Profiles (`Machine` Tab, v0.3.0)**:
   - **Factory Defaults (Optimal)**: Ristretto 25ml, Espresso 40ml, Lungo 110ml, Hot Water 200ml, Americano Coffee 25ml, Americano Water 125ml.
   - **My App Calibration**: Replicates the calibrated machine settings (Ristretto 25ml, Espresso 40ml, Lungo 80ml, Hot Water 230ml, Americano Coffee 40ml, Americano Water 140ml = 180ml total).
9. **Hardware Capabilities Preserved from v0.2.0**:
   - Ingredient pour sequence (`Coffee → Water` vs. `Water → Coffee` Long Black).
   - Full volumetric ranges: Coffee `0` or `15–130 ml` + Hot Water `0` or `25–300 ml` (up to `430 ml` combined).
   - Split-Temperature two-stage brewing ("Great Americano XL": `40 ml` Max Temp Coffee + `160 ml` Warm Water).
   - In-chamber water-pause soak lab (`BrewOperations.LONG_BREW_TIMEOUT = 300s` 5-minute pause window).
   - Hardware countdown delayed brew scheduler (`06aa3a32`).
   - Auto-off standby delay (`9m`, `30m`, `2h`, `8h`) & water hardness (`0–4`) via `06aa3a44`.
   - Real-time 48-bit `MachineStatus` (`06aa3a12`) and `CommandResponse` (`06aa3a52`) telemetry decoding.

---

## 3. Recovering Your Enrolled Auth Key Without Factory Resetting the Machine

> [!TIP]
> **Zero-Reset Auth Key Recovery (`adb backup` + [`scripts/extract_auth_key.py`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/scripts/extract_auth_key.py)):**
> You can extract your machine's existing pairing key directly from an unencrypted Android backup on a non-rooted phone in 10 seconds:
> ```bash
> adb backup -f nespresso.ab -noapk com.nespresso.activities
> python scripts/extract_auth_key.py nespresso.ab --save-env
> ```
> See [`documentation/03-recovering-original-auth-key-without-reset.md`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/03-recovering-original-auth-key-without-reset.md) for the complete walkthrough and the 4-bit nibble-shift derivation (`32-char DB hash` → `16-char 0x8... BLE Auth Key`).

---

## 4. Technical Documentation (`documentation/`)

All BLE GATT protocol details, bitfield specifications, and hardware state machines are documented in [`documentation/`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/README.md):

- **[`documentation/README.md`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/README.md)** — Master overview & architecture summary.
- **[`documentation/01-ble-gatt-protocol-reference.md`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/01-ble-gatt-protocol-reference.md)** — Complete GATT UUID table, 48-bit `MachineStatus` (`06aa3a12`) bitfield, `CommandResponse` (`06aa3a52`) error subcodes, and command frames.
- **[`documentation/02-pairing-and-authentication-internals.md`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/02-pairing-and-authentication-internals.md)** — BLE pairing, `TxPowerLevel` OS bond trigger, 4-bit nibble-shift Auth Key derivation, and factory-reset procedures.
- **[`documentation/03-recovering-original-auth-key-without-reset.md`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/03-recovering-original-auth-key-without-reset.md)** — Step-by-step guide to extracting an existing pairing key from `.ab` backups or HCI snoop logs.
- **[`documentation/04-custom-recipes-volumes-and-multi-stage-brewing.md`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/04-custom-recipes-volumes-and-multi-stage-brewing.md)** — Volumetric limits, ingredient ordering, split-temperature Americano orchestration, and cleaning capsule / bloom soaking.
- **[`documentation/05-hardware-capabilities-and-feature-roadmap.md`](file:///c:/Users/mbord/wa/notpresso-alternative/my-notpresso/documentation/05-hardware-capabilities-and-feature-roadmap.md)** — Complete hardware subsystem inventory, cross-appliance compatibility, and future feature roadmap.

---

## 5. How to Install & Run on Samsung Galaxy S24 Ultra (OneUI 9)

### Method A: Hosted on GitHub Pages (Instant PWA)
1. Open your GitHub Pages HTTPS URL (`https://<username>.github.io/notpresso-alternative/`) in **Chrome** on your Samsung S24 Ultra.
2. Tap the **⚙️ Settings** icon, paste your 16-char Auth Key (or 32-char DB hash), and tap **Save Auth Key**.
3. Tap **Connect**, select your Nespresso Expert, and brew!
4. Optional: Tap Chrome's three-dot menu → **"Install app"** to add Notpresso Expert to your home screen for 100% offline use.

### Method B: Sideload the Native Android APK (`android-apk` branch)
If you want native Android BLE bonding (`createBond()`), background service resilience, and zero browser prompts, check out the `android-apk` branch and install `notpresso-expert-debug.apk`.

---

## 6. Project Structure

```text
my-notpresso/
├── index.html                # Mobile-first Web Bluetooth PWA interface (5 tabs + System Rinse + Post-Brew Top-Up + Manual/Descale UI)
├── styles.css                # Dark Espresso & Crema Gold theme for Samsung S24 Ultra
├── app.js                    # BLE GATT engine (`APP_VERSION` single source of truth), Post-Brew Top-Up, 5-Shot System Rinse, Fault History & Low-Stock Threshold, Expandable Presets, Per-Cup Temp Override, Drag Reorder, Capsule Stock Counter
├── manifest.json             # PWA configuration for Add-to-Homescreen
├── sw.js                     # Offline caching Service Worker (versioned via `sw.js?v=APP_VERSION`)
├── server.py                 # Optional local Python server with Wi-Fi IP display
├── scripts/
│   └── extract_auth_key.py   # Extracts 16-char BLE Auth Key from nespresso.ab / SQLite DB
├── tests/
│   ├── test_app.js           # Zero-dependency Node unit, DOM & bug-fix regression suite
│   └── test_python.py        # Python unittest suite for server.py and extract_auth_key.py
└── documentation/            # Complete reverse-engineered BLE protocol docs & NespressoExpertEN350G.pdf manual
```

### Running Regression Tests

Run from the `my-notpresso/` directory (zero external packages required):

```bash
node tests/test_app.js
python tests/test_python.py
```

---

## 7. Credits & Acknowledgments

This project stands on the shoulders of several excellent open-source projects and reverse-engineering pioneers in the smart coffee and Bluetooth communities:

* **[Barista Studio](https://github.com/Rosselman/barista-studio)** by [Rosselman](https://github.com/Rosselman):
  Inspiration for the sleek mobile UI design, dark theme styling, GATT operation queue & polling architecture, and the CMID derivation algorithm used across Eugster/Frismag OEM Bluetooth hardware.
* **[Farmin Farzin (`farminf`)](https://gist.github.com/farminf/94f681eaca2760212f457ac59da99f23)**:
  Author of the foundational Gist *"Hacking Nespresso Expert Machine to brew coffee using custom applications via bluetooth"*, which pioneered Android HCI packet sniffing and mapped out initial Nespresso Expert BLE communications.
* **[Florian Salomon (`fsalomon/nespresso-expert-ble`)](https://github.com/fsalomon/nespresso-expert-ble)**:
  Early reverse-engineering and documentation of the Nespresso Expert BLE GATT profile and JavaScript Cordova/Node interaction patterns.
* **[Peter Gullberg (`petergullberg/brewbutton`)](https://github.com/petergullberg/brewbutton)**:
  Crucial protocol analysis uncovering the custom **Recipe Brew (`07`)** command payloads, the `01 10` volumetric recipe configuration packet structure (for independent milliliter-level coffee & water calibration), and pioneering browser control via `brewbutton.html` (Web Bluetooth).
* **[Uri Shaked (`urish`)](https://urish.medium.com/reverse-engineering-a-bluetooth-lightbulb-56580fcb7546)**:
  Educational guide on reverse-engineering BLE devices with Wireshark and controlling them through the browser using the Web Bluetooth API (`navigator.bluetooth`).
* **[bulldog5046 / tikismoke (`bulldog5046/ha_nespresso_integration`)](https://github.com/bulldog5046/ha_nespresso_integration)**:
  Home Assistant Bluetooth integration for connected Nespresso machines, and documenting the critical hardware caveat regarding the 25-pairing EEPROM memory limit on Nespresso Bluetooth modules.

---

## 8. License

Distributed under the MIT License. See `LICENSE` for details.
