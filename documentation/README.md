# Notpresso Expert (EN 350.G / D80) — Hardware Protocol & Engineering Documentation

This directory provides a complete, self-contained technical specification of the Bluetooth Low Energy (BLE) GATT protocol, hardware state machine, volumetric capabilities, and multi-stage brewing architecture for the **Nespresso Expert (EN 350.G / D80 & C80)** coffee machine.

It is designed as a clean-room interoperability reference for maintaining and extending **Notpresso** across both the Web Bluetooth Progressive Web App (`main` branch) and the standalone native Android application (`android-apk` branch).

---

## Documentation Index

1. [**01 — BLE GATT Protocol Reference (`01-ble-gatt-protocol-reference.md`)**](./01-ble-gatt-protocol-reference.md)
   - Complete GATT service and characteristic UUID map (`06aa1910` through `06aa1950`) and 16-bit UUID offset formula.
   - Exact 48-bit (`6-byte`) `MachineStatus` (`06aa3a12`) bitfield specification (`MSB = Bit 0` indexing) and all 16 `MachineState` values (`0x00..0x0F`).
   - Exact `CommandResponse` (`06aa3a52`) status codes (`ACK` `0x20`, `OUT_OF_RANGE` `0x36`, `CONDITIONS_NOT_FULFILLED` `0x24`) and rejection subcodes (`0x01..0x12`).
   - All command frames written to `06aa3a42` (Immediate Brew, Hardware Scheduled Countdown Brew, Custom Volumetric Recipe `01 10 08`, Abort Brew `03 06 01 02`, and Factory Reset `03 07 00`).
   - Rotary Dial Cup-Size programming (`06aa3a14` + `06aa3a24`), Auto-Off Standby & Water Hardness (`06aa3a44`), Capsule Stock Counter (`06aa3a15`–`06aa3a35`), and Error Log Retrieval (`06aa3a13`–`06aa3a23`).

2. [**02 — Pairing, Bonding & Authentication Internals (`02-pairing-and-authentication-internals.md`)**](./02-pairing-and-authentication-internals.md)
   - How a 128-bit (`32-hex-char`) pairing identifier is transformed into the 64-bit (`8-byte`) BLE wire authentication token (`0x8X` prefix + 4-bit right nibble shift).
   - How `06aa3a51` (`PairingKeyState`) distinguishes an unconfigured machine (`0x00`/`0x01`) from an enrolled machine (`0x02`), and how `06aa3a61` (`TxPowerLevel`) controls low-power key enrollment.
   - OS-level Bluetooth bonding requirements vs. browser Web Bluetooth limitations, plus physical and BLE factory-reset procedures.

3. [**03 — Recovering an Enrolled Auth Key Without Factory Reset (`03-recovering-original-auth-key-without-reset.md`)**](./03-recovering-original-auth-key-without-reset.md)
   - How to recover an already-enrolled machine's 8-byte BLE Auth Key from an Android device backup (`.ab`), local SQLite database, Bluetooth HCI snoop log (`btsnoop_hci.log`), or GATT server mirror using [`scripts/extract_auth_key.py`](../scripts/extract_auth_key.py) — avoiding any need to factory-reset the coffee machine.

4. [**04 — Custom Recipes, Volumetric Limits & Multi-Stage Brewing (`04-custom-recipes-volumes-and-multi-stage-brewing.md`)**](./04-custom-recipes-volumes-and-multi-stage-brewing.md)
   - Exact hardware volumetric ranges: Coffee `0 ml` or `15–130 ml` (`1 ml` increments) and Hot Water `0 ml` or `25–300 ml` (`1 ml` increments), up to `430 ml` combined.
   - Programmable Rotary Dial cup-size limits (`06aa3a14` / `06aa3a24`) and ingredient pour sequence (`Coffee → Water` vs. `Water → Coffee` Long Black).
   - **Split-Temperature Two-Stage Brewing ("Great Americano XL")**: Orchestrating High-temperature espresso extraction (`0x02`) followed automatically by Low/Warm-temperature bypass water (`0x01`).
   - **Cleaning Capsule & Pre-Infusion Bloom Lab**: Leveraging the firmware's `300-second` (`5-minute`) water-empty pause window to soak capsules inside the clamped brew chamber without ejecting them.

5. [**05 — Hardware Capabilities Matrix & Feature Roadmap (`05-hardware-capabilities-and-feature-roadmap.md`)**](./05-hardware-capabilities-and-feature-roadmap.md)
   - Complete inventory of all 11 hardware subsystems exposed by the Nespresso Expert EN 350.G.
   - Protocol compatibility across sibling Eugster/Frismag BLE appliances (Prodigio, Essenza Plus, Barista / Aeroccino).
   - Roadmap of additional hardware capabilities (Historical Error Log Diagnostics `06aa1930`, Hardware Firmware/Board Inspector `06aa3a21`, Stock Sync Keys `06aa3a35`, and Multi-Pulse Extraction) ready to be leveraged in future UI/UX iterations.
