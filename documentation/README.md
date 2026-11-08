# Nespresso Expert EN 350.G — Reverse-Engineering Documentation

This folder documents the complete Bluetooth Low Energy (BLE) GATT protocol, authentication/onboarding state machine, and command payloads of the **Nespresso Expert (EN 350.G / C80 / D80)** coffee machine, recovered by reverse-engineering the last official Android APK that supported BLE onboarding (`nespresso-3-28-0.apk`, package `com.nespresso.activities`).

These findings serve two purposes:
1. **Improving the Web Bluetooth (`main` branch) app** with missing protocol features (such as stopping/aborting a brew in progress, reading the capsule slider state, decoding real-time `CommandResponse` error masks, and programming hardware cup sizes).
2. **Powering the Standalone Android APK (`android-apk` branch)** and helping existing owners recover their original 8-byte (`16-hex-character`) BLE Auth Key **without factory-resetting their coffee machine**.

---

## Contents

1. **[01 — BLE GATT Protocol Reference](./01-ble-gatt-protocol-reference.md)**
   - Complete service and characteristic UUID table (`06aa1910`, `06aa1920`, `06aa1930`, `06aa1940`)
   - Exact byte layouts for `MachineStatus` (`06aa3a12`), `SliderState` (`06aa3a22`), and `CommandResponse` (`06aa3a52`)
   - All `CommandKey` (`06aa3a42`) payloads: Standard Brew, Custom Two-Step Recipe (`Americano`), **Abort/Stop Brew**, **Program Cup Size**, and **Factory Reset**
   - Actionable improvements for the `main` (Web Bluetooth) branch

2. **[02 — Pairing Key & Onboarding Internals](./02-pairing-and-authentication-internals.md)**
   - Exact decompiled algorithm of `PairingKey.getBufferFromByteArray(byte[])` (`0x80` high-nibble prefix + 4-bit right shift)
   - How `AuthenticationAdapter` and `OnboardingAdapter` handshake with the machine (`06aa3a51` `ReadPairingKeyState`, `06aa3a61` `WriteTXPowerLevel`, OS bonding, and `06aa3a41` `WriteAuth`)
   - Why Chrome Web Bluetooth fails during first-time onboarding and why previously paired machines reject newly generated keys

3. **[03 — Recovering Your Original Auth Key Without Factory Reset](./03-recovering-original-auth-key-without-reset.md)**
   - **Proven Succeeded Method (`adb backup`)**: Extracting `apps/com.nespresso.activities/db/nespresso_app_fusion.db` (`MyMachines` table, `pairing_key` column) from an unencrypted `nespresso.ab` Android backup and converting the 32-char DB hash into the 16-char (`0x8...`) BLE Auth Key
   - Alternative methods (`adb bugreport` HCI snoop extraction and GATT Server inspection)
   - Using the included [`scripts/extract_auth_key.py`](../scripts/extract_auth_key.py) utility on `nespresso.ab`, `nespresso_app_fusion.db`, `bugreport.zip`, or a 32-char `pairing_key` hash (including `--save-env` to write a git-ignored `.env` file)
