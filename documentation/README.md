# Nespresso Expert EN 350.G — Reverse-Engineered BLE Documentation

This documentation synthesizes the complete reverse-engineering findings from the official Nespresso Android application (`com.nespresso.activities` v3.28.0 — [`apk/nespresso-3-28-0.apk`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/apk/nespresso-3-28-0.apk)), Android Bluetooth HCI snoop logs (`btsnoop_hci.log`), and the unencrypted Android Backup (`nespresso.ab` -> `nespresso_app_fusion.db`).

---

## Contents

1. [**01 — BLE GATT Protocol Reference (`01-ble-gatt-protocol-reference.md`)**](./01-ble-gatt-protocol-reference.md)
   - Complete GATT service & characteristic UUID mapping (`UuidTemplate.evaluate` math).
   - Exact 48-bit (`6-byte`) `MachineStatus` (`06aa3a12`) bitfield layout (`MachineMonitoringOperations.fromByteToBuilder`).
   - Exact `CommandResponse` (`06aa3a52`) ACK (`0x20`), `OUT_OF_RANGE` (`0x36`), and `CONDITIONS_NOT_FULFILLED` (`0x24`) subcodes (`0x01..0x12`).
   - All command payloads on `06aa3a42` (Brew Now, Scheduled Countdown Brew, Custom Recipe `01 10 08`, Abort Brew `03 06 01 02`, Factory Reset `03 07 00`).
   - Hardware Rotary Dial Cup-Size programming (`06aa3a14` + `06aa3a24`), Auto-Off Standby & Water Hardness (`06aa3a44`), Capsule Stock Counter (`06aa3a15`/`06aa3a25`), and Error Retrieval (`06aa3a13`/`06aa3a23`).

2. [**02 — Pairing, Onboarding & Authentication Internals (`02-pairing-and-authentication-internals.md`)**](./02-pairing-and-authentication-internals.md)
   - How `PairingKey` (`classes4.dex`, `codeOff=0x37bd98`) generates the 32-char MD5 database hash and transforms the first 8 bytes into the 8-byte BLE `authKey` (`0x8X` leading byte + 4-bit right nibble shift).
   - Why `06aa3a51` (`PairingKeyState`) blocks new keys when `state == 2 (PRESENT)` and how `06aa3a61` (`TxLevel`) gates onboarding.
   - How to factory-reset the machine either via BLE (`03 07 00`) or via the physical temperature button (`10s` hold with slider closed and dial on Lungo).

3. [**03 — Recovering the Original Auth Key Without Factory Resetting (`03-recovering-original-auth-key-without-reset.md`)**](./03-recovering-original-auth-key-without-reset.md)
   - How the official app stores `MyMachines.pairing_key` inside `nespresso_app_fusion.db`.
   - Step-by-step extraction via `adb backup -f nespresso.ab -noapk com.nespresso.activities` and [`scripts/extract_auth_key.py`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/scripts/extract_auth_key.py).

4. [**04 — Custom Recipes, Volume Limits & Multi-Stage Brewing (`04-custom-recipes-volumes-and-multi-stage-brewing.md`)**](./04-custom-recipes-volumes-and-multi-stage-brewing.md)
   - Pour order (`COFFEE_THEN_WATER` vs `WATER_THEN_COFFEE` "Long Black").
   - Exact min/max milliliter limits (`ZeroOrRangeValue`: Coffee `0` or `15–130 ml`, Water `0` or `25–300 ml`, up to `430 ml` combined; plus `CupSizeInterval` rotary dial limits).
   - **Split-Temperature Two-Stage Brewing ("Great Americano")**: Brewing Coffee at `HIGH` temp (`0x02`) and Hot Water at `LOW` temp (`0x01`) automatically over BLE.
   - **Cleaning Capsules & Pre-Infusion ("Bloom Phase")**: How the motorized brew chamber interlock works, `LONG_BREW_TIMEOUT` (`300 seconds`), Water-Tank Pause Soak Mode (`1 min` / `10s`), and Two-Stage Macro execution.

5. [**05 — SDK Class Hierarchy & Machine Families (`05-sdk-class-hierarchy-and-machine-families.md`)**](./05-sdk-class-hierarchy-and-machine-families.md)
   - Architectural map of `com.nestle.connecteddevices.nespresso.*` (`ExpertModule`, `ProdigioModule`, `BlueModule`, `VenusModule`, `Vtp2Module`, `WhiteModule`) and `com.nespresso.connect.*` for future UI/UX or native tech-stack implementations.
