# Notpresso Expert (EN 350.G) — v0.3.0

<div align="center">
  <h3>Standalone Offline BLE Alternative for Nespresso Expert EN 350.G</h3>
  <p><strong>Zero Cloud Accounts • Reorderable Favorites & Library • Split-Temp Custom Recipes • Rotary Dial Calibration • 100% Offline</strong></p>
</div>

---

## 1. Background & Why This Exists

Nespresso officially discontinued Bluetooth onboarding and support for the **Nespresso Expert EN 350.G** in their modern Android mobile app. Furthermore, recent versions of their app force continuous cloud logins (frequently logging users out) and are actively phasing out legacy Bluetooth Original-line machines entirely.

**Notpresso Expert** provides an open-source, local-first alternative designed to run directly on your smartphone (such as the **Samsung Galaxy S24 Ultra / OneUI 9**) via the **Web Bluetooth API** (Progressive Web App) or as a standalone native Android APK (`android-apk` branch).

---

## 2. What's New in v0.3.0 (Favorites, Library Reordering & App Calibration)

`v0.3.0` incorporates the complete personal favorites and rotary dial calibration setup from the official companion app:

1. **⭐ My Favorites & Suggestions (Home Presets Tab)**:
   - Displays your top favorite recipes right on the main home screen below the rotary dial presets.
   - 1-tap brew access and 1-tap edit button without needing to switch tabs.
2. **Curated Nespresso App Favorites Pre-Seeded**:
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
3. **Full Library Organization, Reordering & Renaming**:
   - **Reordering**: Move Up 🔼 and Move Down 🔽 buttons on every saved item to reorder your favorites.
   - **Renaming**: Inline ✏️ Rename modal for changing any recipe name anytime.
   - **Edit / Tweak**: 🎛️ Edit button that loads any existing recipe back into the Custom or Bloom builder for tweaking.
   - **Restore Curated**: 1-tap button to restore the Nespresso app suggestions if desired.
4. **Named Custom Recipes & Cycles**:
   - Direct recipe name input fields in both Custom Recipe (`inputCustomRecipeName`) and Bloom Lab (`inputBloomRecipeName`) builders before saving.
5. **Physical Rotary Dial Cup-Size Calibration Profiles (`Machine` Tab)**:
   - **Factory Defaults (Optimal)**: Ristretto 25ml, Espresso 40ml, Lungo 110ml, Hot Water 200ml, Americano Coffee 25ml, Americano Water 125ml.
   - **My App Calibration**: Replicates the calibrated machine settings (Ristretto 25ml, Espresso 40ml, Lungo 80ml, Hot Water 230ml, Americano Coffee 40ml, Americano Water 140ml = 180ml total).
6. **Hardware Capabilities Preserved from v0.2.0**:
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
├── index.html                # v0.2.0 Mobile-first Web Bluetooth PWA interface (5 tabs)
├── styles.css                # Dark Espresso & Crema Gold theme for Samsung S24 Ultra
├── app.js                    # v0.2.0 BLE GATT engine, Split-Temp & Bloom/Clean orchestrator
├── manifest.json             # PWA configuration for Add-to-Homescreen
├── sw.js                     # Offline caching Service Worker (v0.2.0)
├── server.py                 # Optional local Python server with Wi-Fi IP display
├── scripts/
│   └── extract_auth_key.py   # Extracts 16-char BLE Auth Key from nespresso.ab / SQLite DB
├── documentation/            # Complete reverse-engineered BLE protocol & SDK reference
└── flutter_src/              # Reference Dart / Flutter BLE service implementation
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
