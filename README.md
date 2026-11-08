# Notpresso Expert (EN 350.G) — v0.2.0

<div align="center">
  <h3>Standalone Offline BLE Alternative for Nespresso Expert EN 350.G</h3>
  <p><strong>Zero Cloud Accounts • Split-Temp Custom Recipes • Cleaning Capsule & Bloom Lab • Rotary Dial Programmer • 100% Offline</strong></p>
</div>

---

## 1. Background & Why This Exists

Nespresso officially discontinued Bluetooth onboarding and support for the **Nespresso Expert EN 350.G** in their modern Android mobile app. Furthermore, recent versions of their app force continuous cloud logins (frequently logging users out) and are actively phasing out legacy Bluetooth Original-line machines entirely.

**Notpresso Expert** provides an open-source, local-first alternative designed to run directly on your smartphone (such as the **Samsung Galaxy S24 Ultra / OneUI 9**) via the **Web Bluetooth API** (Progressive Web App) or as a standalone native Android APK (`android-apk` branch).

---

## 2. What's New in v0.2.0 (Complete Hardware Capability Unlock)

Following a comprehensive protocol investigation of the **Nespresso Expert EN 350.G (D80 / C80)** BLE GATT interface, `my-notpresso` unlocks every hardware capability of the machine — plus multi-stage orchestration that the original companion app never exposed:

1. **Ingredient Pour Sequence (`Coffee → Water` vs. `Water → Coffee`)**:
   - **`Coffee → Water` (Classic Americano)**: Extracts espresso first, then tops up with hot water through the dedicated hot-water bypass spout.
   - **`Water → Coffee` (Long Black)**: Dispenses hot water into the cup first, then extracts espresso on top so the golden crema stays intact.
2. **Full Hardware Volumetric Ranges**:
   - **Coffee Volume (`0x01`)**: `0 ml` (Pure Hot Water mode) **or** `15 ml – 130 ml` (`1 ml` precision — up to Max Lungo `130 ml`).
   - **Hot Water Volume (`0x02`)**: `0 ml` (Pure Coffee mode) **or** `25 ml – 300 ml` (`1 ml` precision).
   - **Maximum Combined Recipe**: Up to **`430 ml`** (`130 ml` Coffee + `300 ml` Hot Water).
3. **Split-Temperature Two-Stage Brewing ("Great Americano XL")**:
   - The Expert's single-command `Recipe` opcode (`0x07`) applies a single temperature byte to the whole drink.
   - When you enable **Split Temp** in the **Custom** tab (or tap the **Great Americano XL** preset), Notpresso automatically orchestrates two sequential hardware recipe brews with independent temperatures — e.g., **`40 ml` Coffee at High/Max (`89°C` / `0x02`)** followed automatically by **`160 ml` Hot Water at Low/Warm (`80°C` / `0x01`)** as soon as the machine signals `READY`.
4. **Cleaning Capsule (`40 ml → 60s Soak → 130 ml`) & Pre-Infusion Bloom (`15 ml → 10s → 35 ml`) Lab**:
   - Unlike older manual-lever Nespresso machines, the Expert EN 350.G has a motorized brew chamber that automatically ejects the capsule when a brew finishes.
   - The machine's firmware includes a **300-second (5-minute) long-brew pause window**: when the water tank is empty or lifted slightly off its valve (`waterTankEmpty` bit `7` of `06aa3a12`), **the machine pauses mid-brew for up to 5 minutes while keeping the chamber clamped closed around the capsule!**
   - The **Bloom/Clean** tab provides both:
     - **Mode 1: In-Chamber Water-Pause Soak** (watches `06aa3a12` bit `7`, automatically starts the `60s` cleaning soak or `10s` bloom timer the instant the machine pauses, and gives you a 1-tap BLE Resume button so the remaining `130 ml` flushes through the exact same capsule).
     - **Mode 2: Automated 2-Stage BLE Macro** (`Stage 1 Brew` → `Countdown Timer` → `Stage 2 Brew`).
5. **Hardware Scheduled / Delayed Brew Timer**:
   - Programs the machine's onboard countdown delay timer (`03 05 07 04 <uint32_delay_seconds> <temp> <brew_id>`) and reads back active schedules from `06aa3a32`.
6. **Physical Rotary Dial Cup-Size Programmer & Machine Settings (`Machine` Tab)**:
   - Reads and writes the 6 factory cup-size registers (`06aa3a14` / `06aa3a24`) so turning the physical dial on the machine brews your exact custom milliliter volumes (`Ristretto 15–30 ml`, `Espresso 30–70 ml`, `Lungo 70–130 ml`, `Hot Water 50–300 ml`, `Americano Coffee 15–110 ml`, `Americano Water 25–300 ml`).
   - Configures **Auto-Off Standby Delay** (`9 min`, `30 min`, `2 hr`, `8 hr`) and **Water Hardness** (`Level 0–4`) via `06aa3a44`.
   - Decodes the full 48-bit `MachineStatus` (`06aa3a12`) bitfield (`Water Tank Empty`, `Slider Open/Closed`, `Capsule Bin Full`, `Descaling Needed`, `Overheat`, `Programmed Brew Active`, and `10-bit Capsule Stock`) and `CommandResponse` (`06aa3a52`) error subcodes (`0x01..0x12`).

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
