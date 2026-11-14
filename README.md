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

## 2. Features & Capabilities

Notpresso Expert puts complete local control of your **EN 350.G** inside five streamlined tabs:

- **Presets & Two-Stage Brewing (`Presets` Tab)**:
  - Instant 1-tap cards for **Hot Water** (`250 ml @ Max ~90°C` default), **Ristretto**, **Espresso**, **Lungo**, **Americano** (synced to rotary dial settings), and **Great Americano XL** (`160 ml Warm 80°C Water → 40 ml Max 90°C Coffee` default).
  - Expand any card for live volume sliders (`15–130 ml` coffee, `25–300 ml` hot water), dial/limit tags prefixed inline (`(Lungo) 80 ml`, `(Hot Water) 230 ml`), per-stage `3x` temperature toggles (`Warm ~80°C`, `Hot ~85°C`, `Max ~90°C`), and a one-tap **`⇅ Swap Stage Order`** button (`Coffee → Water` vs. `Water → Coffee`). Distinct stage temperatures automatically run sequential 2-stage split brewing.
  - **Post-Brew Window**: 10-second live countdown before auto-eject with 1-tap **`+15 ml Coffee`** and **`+25 ml Hot Water`** top-ups locked to your brew's temperature.

- **Custom Recipe Builder & Scheduler (`Custom` Tab)**:
  - Configure independent milliliter volumes (`0` or `15–130 ml` coffee + `0` or `25–300 ml` hot water, up to `430 ml` total), `±5 ml` fine-tune steppers, dynamic rotary-dial quick chips, custom stage ordering, and per-stage temperatures.
  - Schedule **delayed hardware brews** via the machine's onboard timer (`06aa3a32`).

- **Bloom & Cleaning Capsule Lab (`Bloom/Clean` Tab)**:
  - **Water-Pause In-Chamber Soak**: Leverages the hardware `300s` tank-empty clamp window to hold pre-infusion blooms (`15 ml → 10s`) or cleaning capsules (`40 ml → 60s`), auto-starting a countdown when paused with 1-tap resume for the remaining flush.
  - **2-Stage BLE Macro**: Automates sequential `Phase 1 → Timed Wait → Phase 2` brews hands-free.

- **Favorites & Recipe Library (`Library & Favorites` Tab)**:
  - Pre-seeded with all **9 curated Nespresso app recipes** (plus `Restore Curated`), pinned **My Favorites** on the home screen, **per-cup temperature override pills (`80°` / `85°` / `90°` / `Split`)** without duplicating saved recipes, **long-press drag reordering**, **inline renaming**, and **edit-back-in-builder**.

- **Machine Calibration, Maintenance & Offline Diagnostics (`Machine` Tab & Header)**:
  - **Rotary Dial Sync (`06aa3a14` / `06aa3a24`)**: Reads all 6 dial targets on connect, persists them in `localStorage` (`notpresso_machine_dial_v1`), and switches between **Factory Defaults** and **My App Calibration** profiles consistently across every tab even offline.
  - **Live LED Telematics & Fault History**: Decodes the full 48-bit `MachineStatus` (`06aa3a12`) and `CommandResponse` (`06aa3a52`) bitfields (`Slider Open`, `Tank Empty`, `Bin Full`, `Descale`, `Obstacle`, `Low Stock`), plus 10-slot **Fault History** (`06aa1930`).
  - **Capsule Stock, Standby & Hardness**: Read/write or disable **Capsule Stock Counter** (`06aa3a15`) and **Low-Stock Threshold** (`06aa3a25`), configure **Auto-Off Delay** (`9m` / `30m` / `2h` / `8h`) and **Water Hardness** (`Levels 0–4`, default `Level 3 Hard`) via `06aa3a44`, or send **BLE Factory Reset** (`03 07 00`) from Settings.
  - **Interactive Maintenance**: **8-step Visual Descaling Guide** with simulated front panel & BLE prep, plus an automated **5-shot System Rinse** (`3x Lungo + 2x Hot Water`).
  - **Offline PWA & Built-In Manual**: Cache-First Service Worker ([`sw.js`](sw.js)), configurable logo long-press (`3s`) cache reset, and built-in searchable Official Manual + embedded PDF viewer (`📖` header button).

> 📋 Looking for version history? See **[RELEASE_NOTES.md](RELEASE_NOTES.md)** for *"What's in it for me?"* upgrade summaries and the detailed per-version technical changelog.

---

## 3. Recovering Your Enrolled Auth Key Without Factory Resetting the Machine

> [!TIP]
> **Zero-Reset Auth Key Recovery (`adb backup` + [`scripts/extract_auth_key.py`](scripts/extract_auth_key.py)):**
> You can extract your machine's existing pairing key directly from an unencrypted Android backup on a non-rooted phone in 10 seconds:
> ```bash
> adb backup -f nespresso.ab -noapk com.nespresso.activities
> python scripts/extract_auth_key.py nespresso.ab --save-env
> ```
> See [`documentation/03-recovering-original-auth-key-without-reset.md`](documentation/03-recovering-original-auth-key-without-reset.md) for the complete walkthrough and the 4-bit nibble-shift derivation (`32-char DB hash` → `16-char 0x8... BLE Auth Key`).

---

## 4. Technical Documentation (`documentation/`)

All BLE GATT protocol details, bitfield specifications, and hardware state machines are documented in [`documentation/`](documentation/README.md):

- **[`documentation/README.md`](documentation/README.md)** — Master overview & architecture summary.
- **[`documentation/01-ble-gatt-protocol-reference.md`](documentation/01-ble-gatt-protocol-reference.md)** — Complete GATT UUID table, 48-bit `MachineStatus` (`06aa3a12`) bitfield, `CommandResponse` (`06aa3a52`) error subcodes, and command frames.
- **[`documentation/02-pairing-and-authentication-internals.md`](documentation/02-pairing-and-authentication-internals.md)** — BLE pairing, `TxPowerLevel` OS bond trigger, 4-bit nibble-shift Auth Key derivation, and factory-reset procedures.
- **[`documentation/03-recovering-original-auth-key-without-reset.md`](documentation/03-recovering-original-auth-key-without-reset.md)** — Step-by-step guide to extracting an existing pairing key from `.ab` backups or HCI snoop logs.
- **[`documentation/04-custom-recipes-volumes-and-multi-stage-brewing.md`](documentation/04-custom-recipes-volumes-and-multi-stage-brewing.md)** — Volumetric limits, ingredient ordering, split-temperature Americano orchestration, and cleaning capsule / bloom soaking.
- **[`documentation/05-hardware-capabilities-and-feature-roadmap.md`](documentation/05-hardware-capabilities-and-feature-roadmap.md)** — Complete hardware subsystem inventory, cross-appliance compatibility, and future feature roadmap.

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
├── app.js                    # BLE GATT engine (`APP_VERSION` single source of truth), dial calibration sync, split-temp brews, rinse, stock/faults
├── manifest.json             # PWA configuration for Add-to-Homescreen
├── sw.js                     # Offline caching Service Worker (versioned via `sw.js?v=APP_VERSION`)
├── server.py                 # Optional local Python server with Wi-Fi IP display
├── RELEASE_NOTES.md          # User-facing upgrade highlights ("What's in it for me?") & per-version technical changelog
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
