# 05 — Hardware Capabilities Matrix & Feature Roadmap

This document catalogs all 11 hardware subsystems exposed by the **Nespresso Expert (EN 350.G / D80 & C80)** over Bluetooth Low Energy, how its GATT architecture relates to sibling Eugster/Frismag appliances, and how additional hardware capabilities can be leveraged in future **Notpresso** releases.

---

## 1. Complete Hardware Subsystems of the Nespresso Expert EN 350.G

| # | Hardware Subsystem | GATT Service | Characteristics | Status in Notpresso `v0.2.0` |
| :---: | :--- | :---: | :--- | :--- |
| **1** | **Session Authentication** | `06aa1910` | `06aa3a41` (`8B` Write), `06aa3a51` (`1B` Read) | **Implemented** (Supports both 16-char `8...` BLE key and 32-char hash auto-derivation) |
| **2** | **First-Time Key Onboarding** | `06aa1910` | `06aa3a61` (`TxLevel`), `06aa3a41`, `06aa3a51` | **Implemented** (Full OS-bond enrollment in `android-apk`; GATT write sequence in Web PWA) |
| **3** | **Hardware & Firmware Identification** | `06aa1910` | `06aa3a21` (`10B` FW/HW Info), `06aa3a31` (`19B` Serial) | **Ready for UI Expansion** (Characteristics mapped; can be surfaced in a Machine Diagnostics modal) |
| **4** | **Preset Beverage Extraction** | `06aa1920` | `06aa3a42` (`10B` Write), `06aa3a52` (`Response`) | **Implemented** (Ristretto `0x00`, Espresso `0x01`, Lungo `0x02`, Hot Water `0x04`, Americano `0x05` + 3 Temps) |
| **5** | **Custom Volumetric Recipes** | `06aa1920` | `06aa3a42` (`11B` Recipe + `10B` Trigger `0x07`) | **Implemented** (`0` or `15–130 ml` Coffee, `0` or `25–300 ml` Water, `Coffee→Water` / `Water→Coffee`, Split-Temp 2-Stage) |
| **6** | **Hardware Delayed / Scheduled Brew** | `06aa1920` | `06aa3a42` (`uint32` delay), `06aa3a32` (`6B` Read) | **Implemented** (Countdown scheduling & `06aa3a32` active schedule readback) |
| **7** | **Real-Time Telemetry & Interlocks** | `06aa1920` | `06aa3a12` (`48-bit` Status), `06aa3a22` (`Slider`), `06aa3a52` | **Implemented** (Full 48-bit bitfield decoder, live slider state, water-empty pause detector, and subcode alerts) |
| **8** | **Rotary Dial Cup-Size Programming** | `06aa1940` | `06aa3a14` (`2B` Target), `06aa3a24` (`4B` Volume) | **Implemented** (Reads and writes all 6 physical dial cup slots) |
| **9** | **Auto-Off Standby & Water Hardness** | `06aa1940` | `06aa3a44` (`3B` Read/Write with `0xFF` masks) | **Implemented** (`9m`, `30m`, `2h`, `8h` standby timer and `0–4` water hardness levels) |
| **10** | **Capsule Stock & Low-Stock Threshold** | `06aa1950` | `06aa3a15` (`Stock`), `06aa3a25` (`Threshold`), `06aa3a35` (`Key`) | **Implemented** (`06aa3a15` counter read/write + `06aa3a12` 10-bit live counter; `06aa3a25`/`06aa3a35` documented for expansion) |
| **11** | **Hardware Error Log History** | `06aa1930` | `06aa3a13` (`1B` Index), `06aa3a23` (`19B` Fault Record) | **Documented for Future UI** (Select error slot `0x00..0x09` on `06aa3a13` and read `errorNumber`, `category`, `subCode` on `06aa3a23`) |

---

## 2. Cross-Appliance Protocol Compatibility (Eugster/Frismag BLE Family)

The BLE GATT architecture used by the Nespresso Expert is shared across a broader family of connected coffee appliances manufactured by Eugster/Frismag. Understanding these shared traits makes it easy to adapt Notpresso to sibling machines in the future:

```text
Base Connected Appliance Architecture (Service 06aa1910: Auth 06aa3a41, KeyState 06aa3a51, TxLevel 06aa3a61)
├── Milk & Recipe Frothers (Advertised Name: "Aeroccino" / "Barista" / "White")
│   └── Uses CRC-verified multi-step recipe slots (motor RPM, coil temperature, duration)
└── Capsule Coffee Machines (Base Service 06aa1910-f22a-11e3-9daa-0002a5d5c51b)
    ├── Prodigio Family (Advertised Name: "Prodigio")
    │   ├── Services 06aa1910, 06aa1920, 06aa1930, 06aa1940 (Water Hardness), 06aa1950 (Stock)
    │   ├── Supports Ristretto (0x00), Espresso (0x01), Lungo (0x02), and Scheduled Brew (06aa3a32)
    │   └── Nespresso Expert / Expert&Milk (Advertised Name: "Expert" — Models D80 / C80 / EN 350.G)
    │       ├── Adds Hot Water (0x04), Americano (0x05), and Custom Recipe (0x07 + 01 10 08 ...)
    │       ├── Adds 3-Level Brew Temperature selection (Low 0x01, Medium 0x00, High 0x02)
    │       ├── Adds Rotary Dial Cup-Size Programming (06aa3a14 + 06aa3a24)
    │       └── Adds Configurable Auto-Off Standby Delay (06aa3a44: 9m, 30m, 2h, 8h)
    └── Next-Gen Original / Commercial / Vertuo BLE Families ("Essenza Plus", "Momento", "Vertuo Next")
        └── Extends with Wi-Fi onboarding characteristics or optical capsule-barcode readers (06aa3a16..06aa3a36)
```

---

## 3. Potential Capabilities for Future App Enhancements

The following hardware capabilities are fully mapped in this documentation and can be added to future versions of the Web PWA or Native Android APK:

1. **Hardware Fault History & Diagnostics Inspector (`Service 06aa1930`)**:
   - By writing error slot index `[0x00]` (most recent) through `[0x09]` to `06aa3a13` and reading `06aa3a23` (`19 bytes`), the app can display a complete diagnostic log (`errorNumber` at `byte[0]`, `ErrorCategory` at `byte[1] >> 4`, and `errorSubCode` at `byte[2]`) whenever `errorPresent` (`Bit 3` of `06aa3a12`) is set.
2. **Machine Identity & Firmware Inspector (`06aa3a21` & `06aa3a31`)**:
   - Reading `06aa3a21` (`10 bytes`) and `06aa3a31` (`19 bytes`) allows the app to display the exact PCB Hardware Revision (`bytes[0..1]`), Main Controller Firmware Version (`bytes[4..5]`), BLE Radio Firmware Version (`bytes[6..7]`), and 19-character Serial Number.
3. **Low-Capsule Warning Threshold & Sync Key (`06aa3a25` & `06aa3a35`)**:
   - In addition to setting the remaining capsule count on `06aa3a15`, the user can configure the hardware low-capsule warning threshold (`06aa3a25`, `uint16 BE`) that triggers `Bit 16` (`capsuleStockLow`) in `06aa3a12`.
4. **Wake-Up Morning Alarm with Pre-Warm**:
   - Combining the hardware countdown timer (`03 05 07 04 <delay_sec> <temp> <id>`) with a `25 ml` Hot Water spout rinse (`0x04` or `0x07` water-only recipe) allows scheduling an automatic morning machine pre-warm and cup-rinse before pulling an espresso.
