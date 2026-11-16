# Notpresso Expert — Release Notes

Version history for **Notpresso Expert (`EN 350.G`)**, tracking `APP_VERSION` in `app.js` across every major, minor, and patch release.

---

## 1. What's in it for me? Why update?

High-level user benefits across meaningful releases (newest first):

- **`v0.13.8 – v0.13.9`** — Preserves newlines when copying BLE Packet Inspector logs, adds a one-tap **Copy Logs** button, and caps log entries at 500 lines.
- **`v0.13.7`** — Long-pressing the header logo to force a cache refresh now takes **3 seconds instead of 5** (`LOGO_HOLD_REFRESH_SEC`).
- **`v0.13.5 – v0.13.6`** — Your active rotary-dial profile (`My App Calibration` / `Factory Defaults`) and machine-synced cup sizes now stay consistent across Machine, Presets, and Custom views automatically—offline or connected.
- **`v0.13.0 – v0.13.4`** — Pick separate temperatures (`Warm 80°C`, `Hot 85°C`, `Max 90°C`) per coffee/water stage, swap pour order safely with a one-tap Swap button, and see known cup tags like `(Lungo) 80 ml` right beside sliders.
- **`v0.12.0`** — Fix stuck phone PWA caches cleanly by holding the header logo icon to wipe Service Worker caches without losing saved recipes or Auth Key.
- **`v0.11.0 – v0.11.1`** — Automated JS/Python test gating prevents broken releases from deploying, and the app version badge sits right next to the **Notpresso** title.
- **`v0.10.0`** — Get a **10-second window after every brew** to fire a 1-tap top-up (`+15 ml Coffee` or `+25 ml Hot Water`) before the machine auto-ejects the capsule.
- **`v0.9.0`** — Run a guided 1-tap **5-shot System Rinse** (`3x Lungo + 2x Hot Water`) for first use or post-weekend flushes, with diagnostics promoted to the top of the `Machine` tab.
- **`v0.8.0`** — Read stored machine error history (slots `0–9`) and customize the low-capsule warning threshold without opening the discontinued Nespresso app.
- **`v0.7.0 – v0.7.3`** — View, set, or disable the machine's internal capsule stock counter, plus corrected manual Factory Reset instructions and Water Hardness defaults (`Hard / Level 3`).
- **`v0.6.0 – v0.6.2`** — Tap any home preset card (`Hot Water` listed first) to tweak volume/temperature on the fly, backed by serialized BLE commands that never drop or collide.
- **`v0.5.0 – v0.5.1`** — Switch temperatures per cup (`80°` / `85°` / `90°` / `Split`) right on saved recipe cards without duplicating recipes, and drag-and-drop to reorder Favorites and Library items.
- **`v0.4.1 – v0.4.7`** — Fixes heat-up delays on two-stage brews, accurate bloom resume volumes, modal recovery on command rejections, dial profile sync, and local server dotfile security.
- **`v0.4.0`** — Adds an **8-step interactive Visual Descaling Guide**, **live front-panel LED telematics banner**, and the built-in searchable **Official EN 350.G User Manual**.
- **`v0.3.0`** — Adds **My Favorites** on the home screen, custom recipe naming/renaming, all **9 curated Nespresso app recipes**, and **My App Calibration** presets.
- **`v0.2.0`** — Unlocks milliliter-precision Custom recipes (`0–130 ml` coffee + `0–300 ml` water), `Coffee ↔ Water` pour sequence, split-temp brewing, Bloom/Cleaning soak lab, delayed timer, and dial programming.
- **`v0.1.0 – v0.1.1`** — Standalone, 100% offline Web Bluetooth PWA controller with zero cloud accounts and zero-reset Auth Key reuse.

---

## 2. Detailed Technical Changelog (Per-Version)

> **Maintenance rule:** Every patch, minor, or major increment of `APP_VERSION` in `app.js` receives an entry below detailing commits, protocol/UI changes, and verification coverage.

### `v0.13.9` — `2026-11-16`
- **`app.js`**: Added `MAX_LOG_ENTRIES = 500` cap inside `log()`, pruning oldest `#logConsole` child nodes and syncing `#logCounter` (Fixes `#29`).
- **`tests/test_app.js`**: Added `Fix [#29]` verifying oldest-entry trimming beyond `MAX_LOG_ENTRIES`.

### `v0.13.8` — `2026-11-16`
- **`index.html`, `styles.css`, `app.js`**: Switched `.log-console` from flex-column to block layout so multi-line selection preserves `\n` line breaks; added `#btnCopyLogs` and `copyLogsToClipboard()` via `navigator.clipboard.writeText()` (Fixes `#24`).
- **`tests/test_app.js`**: Added `Fix [#24]` verifying newline-delimited `#logConsole` export.

### `v0.13.7` — `2026-11-14` (`52346b8`)
- **`app.js`**: Introduced single configuration constant `LOGO_HOLD_REFRESH_SEC = 3` (replacing hardcoded `5` / `'5s'` / `'↻ 5s'` literals in `startLogoHoldRefresh`); updated `initLogoHoldRefresh()` to derive `#btnLogoRefresh.title` and initial `#logoHoldCountdown.textContent` from `LOGO_HOLD_REFRESH_SEC`.
- **`index.html`**: Updated initial fallback markup (`title` and `#logoHoldCountdown`) to `3s`.
- **`tests/test_app.js`**: Updated `Feature [v0.12.0 / v0.13.7]` to validate positive integer `LOGO_HOLD_REFRESH_SEC`, per-second interval ticks (`1000 ms`), non-reload prior to final tick, and purge behavior dynamically without hardcoded constants.

### `v0.13.6` — `2026-11-14` (`be62467`)
- **`app.js`**: Fixed offline split-brain state between Quick Calibration profiles (`DIAL_PROFILE_APP` / `DIAL_PROFILE_FACTORY`), `#selectCupTarget`, Custom chips, and Presets:
  - Added `syncCupTargetOptionUI()` to update `<option>` `dataset.def` and `Default <ml>ml` label text in `#selectCupTarget`.
  - Added `dialMatchesProfile()` and `syncDialProfileChipUI()` to sync `active-chip` state cleanly against live `state.machineDialVolumes`.
  - Updated `applyDialProfile()` to route all targets `0..5` through `applyMachineCupTargetVolume()`, optionally persist (`persist = true` on manual click, `false` on default fallback), and refresh hints/chips/presets together.
  - Updated `loadMachineDialVolumes()` to return a boolean so `DOMContentLoaded` initializes from `DIAL_PROFILE_APP` only when `notpresso_machine_dial_v1` is absent, preserving user/machine values across reloads.
  - Synced Custom tab dial quick-chips (`[data-dial-target="0|1|2"]`) on target updates.
- **`index.html`**: Tagged Ristretto, Espresso, and Lungo quick-chips with `data-dial-target="0|1|2"`.
- **`tests/test_app.js`**: Added `Feature [v0.13.6]` verifying offline boot consistency and `applyFactoryDefaultsProfile()` reload persistence; aligned `Feature [#18]` label assertions with default `DIAL_PROFILE_APP`.

### `v0.13.5` — `2026-11-14` (`984117c`)
- **`app.js`**:
  - Expanded `readInitialTelemetry()` rotary dial loop from `[4, 5]` to all 6 targets `[0, 1, 2, 3, 4, 5]`, resetting `state.lastCupTargetIdx = null` afterwards.
  - Added `MACHINE_DIAL_STORAGE_KEY` (`notpresso_machine_dial_v1`), `DIAL_COFFEE_DRINK_MAP`, and `loadMachineDialVolumes()` (invoked before `initListeners()`).
  - Updated `applyMachineCupTargetVolume()` to persist `state.machineDialVolumes` in `localStorage`, update `PRESET_DRINK_DEFAULTS` & `state.presetTweaks` for `ristretto`/`espresso`/`lungo`/`americano` (while keeping `Hot Water` card default at `250 ml`), and refresh all preset cards + subtitles.
  - Updated `syncPresetCardUI()` to refresh `.drink-vol` subtitles for `ristretto`, `espresso`, and `lungo`.
  - Removed hardcoded OEM volume fallbacks (`25`, `40`, `110`, `125`, `200`, `250`) from `getPresetVolumeTag()` so volume badges reflect live `state.machineDialVolumes`, slider limits (`15`/`130` coffee, `25`/`300` water), and `160 -> 'XL'` exclusively.
- **`tests/test_app.js`**: Added `Feature [v0.13.5]` testing 6-target BLE readout, `notpresso_machine_dial_v1` persistence, dynamic tag updates (`80`/`70 ml` Lungo, `230 ml` Hot Water), and offline boot restoration.

### `v0.13.4` — `2026-11-14` (`c898b3d`)
- **`app.js`**: Fixed desktop mouse-drag interruption on the 2nd-stage volume slider by updating `orderTwoStageElements()` to short-circuit when stage DOM children are already in target order instead of re-inserting active elements on every `input` event.
- **`tests/test_app.js`**: Added regression check verifying zero DOM `appendChild`/`insertBefore` mutations during in-order `syncPresetCardUI()` updates.

### `v0.13.3` — `2026-11-14` (`686b426`)
- **`app.js`**: Synced `.drink-icon` emoji ordering (`☕💧` for `coffee-first`, `💧☕` for `water-first`) and subtitles on two-stage preset cards; updated `formatPresetVolumeLabel()` to place recognized dial/limit tags before `ml` (`(Lungo) 110 ml`) to preserve right-edge badge alignment.
- **`tests/test_app.js`**: Added assertions for `.drink-icon` ordering and prefix label formatting.

### `v0.13.2` — `2026-11-14` (`0b68447`)
- **`app.js` & `index.html`**: Unified `Great Americano XL` styling with `Americano` (removed `highlight-card` class and `Split-Temp` pill badge; standardized action text to `Brew`); synced `Americano` defaults to rotary dial targets `4` & `5`; set `Great Americano XL` default to `160ml Water (Warm 80°C) → 40ml Coffee (Max 90°C)`; updated `Hot Water` preset default to `250 ml @ Max ~90°C`.
- **`tests/test_app.js`**: Verified preset defaults, `250 ml` Max `Hot Water` payload (`01100800000200FA000000` + `03050704000000000207`), and Americano dial target synchronization.

### `v0.13.1` — `2026-11-14` (`6008413`)
- **`app.js`, `index.html`, `styles.css`**: Unified `"Brew Temperature"` label and toggle-group styling across two-phase preset cards, Custom Recipe builder, and single-stage cards; replaced stage drag-and-drop reordering with a dedicated `⇅ Swap Stage Order (1st ↔ 2nd)` button (`setPresetStageOrder` / `setCustomStageOrder`) to eliminate accidental slider changes.
- **`tests/test_app.js`**: Verified unified temperature button markup and click-to-swap stage reordering.

### `v0.13.0` — `2026-11-14` (`30ee84a`, `#18`)
- **`app.js`, `index.html`, `styles.css`**: Removed the standalone `"Split"` toggle in favor of independent 3x stage temperature buttons (`Warm ~80°C`, `Hot ~85°C`, `Max ~90°C`) on both Coffee and Water stages in Presets (`Americano`, `Great Americano XL`) and Custom Recipe Builder; automatic dispatch selects single-stage composite command when stage temperatures match or `two-stage-split` workflow when they differ.
- **`tests/test_app.js`**: Expanded two-phase test coverage for matching vs distinct stage temperatures and stage ordering.

### `v0.12.0` — `2026-11-14` (`3b4daa1`)
- **`app.js`, `index.html`, `styles.css`**: Added `forceAppCacheUpdate()`, `startLogoHoldRefresh()`, `cancelLogoHoldRefresh()`, and `#logoHoldCountdown` overlay to unregister Service Workers, delete Cache Storage entries (preserving `localStorage`), and reload cleanly with `?refresh=<timestamp>`; configured `registerServiceWorker()` with `{ updateViaCache: 'none' }` while keeping Cache-First fetches in `sw.js`.
- **`tests/test_app.js`**: Added `Feature [v0.12.0]` testing hold cancellation, countdown display, SW unregistration, cache purge, and reload URL.

### `v0.11.1` — `2026-11-14` (`b64c758`)
- **`index.html` & `app.js`**: Relocated `#badgeAppVersion` from the Settings modal header back next to the main `<h1>Notpresso</h1>` header and cleaned up `settingsVersionTag` wiring.

### CI Pipeline — `2026-11-14` (`2b6e944`)
- **`.github/workflows/pages.yml`**: Added GitHub Actions workflow gating GitHub Pages deployment on passing `node tests/test_app.js` and `python3 tests/test_python.py`.

### `v0.11.0` — `2026-11-14` (`40a04b3`, `#11`)
- **`tests/test_app.js` & `tests/test_python.py`**: Added zero-dependency Node VM + DOM mock suite (`Suite 1` protocol codecs/bitfields, `Suite 2` historical regressions `#1`, `#3`–`#16`, structural UI contracts) and Python `unittest` suite (`extract_auth_key.py` + `server.py` security regression).
- **`app.js`, `sw.js`, `index.html`**: Centralized `APP_VERSION` propagation (`applyAppVersion()`), derived `SW_VERSION` dynamically from `?v=` query parameter (`CACHE_NAME = notpresso-v${SW_VERSION}`), and enforced no hardcoded version duplication in `index.html` or `sw.js`.

### `v0.10.0` — `2026-11-14` (`b0e606e`, `#15`)
- **`app.js` & `index.html`**: Added 10-second post-brew auto-eject countdown inside the brew modal (`Done / Close`) with `triggerPostBrewTopUp('coffee' | 'water')` buttons (`+15 ml Coffee` / `+25 ml Hot Water`) locked to the last completed brew temperature per Manual p. 11.

### `v0.9.0` — `2026-11-14` (`f5572f1`, `#16`)
- **`app.js`, `index.html`, `documentation/`**:
  - Added automated 5-shot `SYSTEM_RINSE_STEPS` workflow (`startSystemRinseWorkflow()`, `executeCurrentSystemRinseStep()`, `advanceOrFinishSystemRinse()`, `stopSystemRinseWorkflow()`), validating closed slider, guiding `>= 650 ml` container setup (Manual pp. 7, 10), running 3x Lungo (coffee outlet) then 2x Hot Water (water spout), and advancing via `06aa3a12` transitions.
  - Promoted Machine Diagnostics, Stock, Fault History, and System Rinse above rotary dial calibration in `Machine` tab; moved `⚠️ Send BLE Factory Reset (03 07 00)` to Settings modal and removed duplicate onboarding button.

### `v0.8.0` — `2026-11-14` (`49035a4`, `#2`)
- **`app.js` & `index.html`**: Added Service `06aa1930` Fault History Inspector (`CHAR_ERROR_SELECT = 06aa3a13`, `CHAR_ERROR_INFO = 06aa3a23`, slots `0–9` with `parseFaultRecordBytes`) and `CHAR_STOCK_THRESHOLD` (`06aa3a25`, `parseStockThresholdBytes`) read/write support.

### `v0.7.3` — `2026-11-14` (`9aa4e84`, `#14`)
- **`app.js`, `index.html`, `documentation/02-pairing-and-authentication-internals.md`**: Fixed physical Factory Reset instructions per Manual p. 15 (`OFF` -> hold Brew `6s` -> dial `Lungo` -> Brew -> Temp `Max` -> Brew); aligned default `waterHardnessLevel` to `3` (`Level 3: Hard >25 °fH / >14 °dH • 1500 cups`).

### `v0.7.2` — `2026-11-14` (`3360360`, `#12`)
- **`app.js` & `sw.js`**: Deduplicated `generateValidNespressoKeyHex()` via `convertDbHash32ToBleKey16()`, replaced per-card click listener loops with single delegated `bindSavedRecipeCardActions()`, removed leftover dead `isNativeAndroid` / `envSubtitle` stubs, and hardened `sw.js` offline fallback (`request.mode === 'navigate'` -> `index.html`, otherwise `Response.error()`).

### `v0.7.1` — `2026-11-14` (`1e81a64`, `#10`)
- **Cleanup**: Removed unused `flutter_src/` (`expert_ble_constants.dart`, `expert_ble_service.dart`).

### `v0.7.0` — `2026-11-14` (`97f8fb2`, `#13`)
- **`app.js` & `index.html`**: Added `CHAR_STOCK` (`06aa3a15`) 16-bit big-endian capsule stock counter management (`readCapsuleStock`, `writeCapsuleStock` clamped `0..1000`, `disableCapsuleStock` writing `0xFFFF`, `0 caps (LED ON)` display).

### `v0.6.2` — `2026-11-14` (`b366de4`, `#9`)
- **`app.js`**: Added `enqueueGattOp()` promise mutex serializing all GATT reads/writes sequentially across errors and updated `connectBle()` to `await readInitialTelemetry()`.

### `v0.6.1` — `2026-11-14` (`ce781af`, `#1`)
- **`app.js`**: Synchronized `state.sliderOpen` and descale visual indicators on `06aa3a22` notifications, preserved detailed `06aa3a32` countdown timer badges when `06aa3a12` `schedActive=true`, added `capsuleStockLow` telemetry flag, and cleared active modals/timers cleanly on disconnect.

### `v0.6.0` — `2026-11-14` (`a2153bc`)
- **`app.js` & `index.html`**: Moved `Hot Water` first in the Presets grid and converted preset drink cards into tappable expandable cards with ad-hoc volume/temperature sliders (`state.presetTweaks`).

### `v0.5.1` — `2026-11-14` (`5e16e8b`)
- **`app.js`, `index.html`, `styles.css`**: Replaced manual up/down reorder buttons with pointer long-press drag-and-drop reordering (`bindLongPressReorder`) for Favorites and Library lists.

### `v0.5.0` — `2026-11-14` (`1669c43`)
- **`app.js`, `index.html`, `styles.css`**: Added transient per-cup temperature override pills (`Warm 80°` / `Hot 85°` / `Max 90°` / `Split`) on saved recipe cards without mutating stored recipes.

### `v0.4.7` — `2026-11-14` (`7894010`)
- **`index.html`, `manifest.json`, `styles.css`, `app.js`**: Compacted top app header, temporarily moved `#badgeAppVersion` to Settings, and replaced header/PWA icons with custom Nespresso Expert EN 350.G SVG artwork.

### `v0.4.6` — `2026-11-14` (`196b4b9`, `#8`)
- **`app.js`**: Added shared `applyDialProfile()` helper and fixed `#selectCupTarget` change handling to populate the volume slider/badge with the selected target's default volume.

### `v0.4.5` — `2026-11-14` (`d6a608d`, `#7`)
- **`app.js`**: Fixed `resumePhase2Extraction()` under `water-pause-soak` to send remaining `Math.max(15, wf.phase2Ml - wf.phase1Ml)` instead of duplicating the full `phase2Ml` volume.

### `v0.4.4` — `2026-11-14` (`1c41918`, `#6`)
- **`server.py`**: Blocked dotfile and URL-encoded dot-segment requests (`403 Forbidden`) and removed wildcard `Access-Control-Allow-Origin: *` header.

### `v0.4.3` — `2026-11-14` (`744387f`, `#5`)
- **`app.js`**: Fixed two-stage and bloom macro Stage 2 advancement to accept `HEATING_UP -> READY` (`1 -> 2`) transitions and apply a `+35s` workflow buffer while `MACHINE_STATES[state.machineState].isBusy`.

### `v0.4.2` — `2026-11-14` (`d3d62dd`, `#4`)
- **`app.js`**: Implemented `syncCustomRecipeUI()` for loading saved recipes back into Custom controls and added in-place updates for edited `bloom` recipes keyed by `state.editingRecipeId`.

### `v0.4.1` — `2026-11-14` (`58ea3d8`, `#3`)
- **`app.js`**: Centralized `rejectCommand()` handling on `06aa3a52` command rejections to clear `activeWorkflow`, soak timers, and brew modal immediately; decoded `MachineStatus` bit `47` (`obstacleDetected`) into live telematics warnings.

### `v0.4.0` — `2026-11-14` (`30d9251`, `#1, #2`)
- **`app.js`, `index.html`, `styles.css`, `documentation/NespressoExpertEN350G.pdf`**: Added interactive 8-step Visual Descaling Guide (`prepareDescaleViaBle()`, simulated front panel), live BLE LED Telematics alert banner (`describeLedTelematics`), and offline searchable official User Manual + embedded PDF viewer.

### `v0.3.0` — `2026-11-09` (`ba587b7`)
- **`app.js`, `index.html`, `styles.css`**: Added home-screen `⭐ My Favorites & Suggestions`, curated 9 Nespresso app recipes, recipe name fields & inline Rename modal, library reordering/editing controls, and `My App Calibration` rotary dial quick profile.

### Tooling & Reverse-Engineered Specs — `2026-11-08` (`18472fc`, `5e8378e`, `1f319e1`)
- **`documentation/` & `scripts/extract_auth_key.py`**: Added full BLE GATT reference (`01`), pairing/auth internals (`02`), zero-reset `adb backup` / SQLite / HCI snoop extractor (`03`, `extract_auth_key.py`), multi-stage recipe internals (`04`), hardware capability roadmap (`05`), and `.gitattributes` LF rules.

### `v0.2.0` — `2026-11-08` (`8e67ba8`)
- **`app.js`, `index.html`, `styles.css`**: Added Custom Recipe Builder (`0` or `15–130 ml` coffee, `0` or `25–300 ml` water, `430 ml` max), `Coffee → Water` / `Water → Coffee` stage order, split-temp 2-stage orchestration (`Great Americano XL`), Bloom/Cleaning Lab (300s water-pause chamber soak + 2-stage macro), hardware scheduled timer (`06aa3a32`), rotary dial R/W (`06aa3a14` / `06aa3a24`), standby/hardness (`06aa3a44`), and full 48-bit status (`06aa3a12`) + `06aa3a52` decoding.

### `v0.1.1` — `2026-11-08` (`ce0953d`)
- **`app.js`, `sw.js`, `index.html`, `styles.css`**: Added `APP_VERSION` constant and Service Worker `ignoreSearch: true` asset cache-busting (`notpresso-v0.1.1`).

### `v0.1.0` — `2026-11-08` (`11a125e`, `4acb892`)
- **Initial release**: Standalone Web Bluetooth PWA (`index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`) and Python local dev server (`server.py`) for offline EN 350.G control without cloud accounts.
- **`4acb892`**: Fixed BLE notification subscription order before auth handshake, added `safeWriteValue` fallback (`writeValueWithResponse`), enforced `0x8X` high-bit CMID prefix, and added `06aa3a61` TxPower `[0x01]` pairing handshake negotiation.
