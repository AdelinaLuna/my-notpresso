# 05 — SDK Class Hierarchy & Machine Families (`com.nestle.connecteddevices.nespresso`)

Extracted from [`apk/dex/classes5.dex`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/apk/dex/classes5.dex) and [`apk/dex/classes4.dex`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/apk/dex/classes4.dex) (see [`raw/dump_all_nestle_sdk.txt`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/raw/dump_all_nestle_sdk.txt) and [`raw/all_nestle_ble_classes.txt`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/raw/all_nestle_ble_classes.txt)).

---

## 1. Two-Layer Architecture in `nespresso-3-28-0.apk`

The Nespresso Android app is split into two distinct layers:

1. **Low-Level BLE Protocol SDK (`com.nestle.connecteddevices.nespresso.*` in `classes5.dex`)**:
   - Contains all GATT UUID templates, byte-buffer serializers, bitfield parsers, and RxJava `Single`/`Completable`/`Observable` BLE operations.
2. **Application Domain & UI Layer (`com.nespresso.connect.*` in `classes4.dex`)**:
   - Contains SQLite persistence (`MyMachinesDao`, `MachineEntity`), `PairingKey` MD5 generation (`codeOff=0x37bd98`), `ZeroOrRangeValue` recipe validators, and MVP presenters (`CreateRecipePresenter`, `MyMachinePresenter`).

---

## 2. Machine Module Hierarchy (`com.nestle.connecteddevices.nespresso.modules.*`)

Each BLE-capable Nespresso machine family is represented by a `Module` subclass that matches the BLE peripheral's advertised device name regex (`isApplicable`) and instantiates feature `Adapter`s (`newAdapter`):

```text
NespressoModule (Base: Authentication, Onboarding, CredentialsRegistry, FactoryReset)
├── AeroccinoModule (Base Service UUID: 06aa1910-..., Device Name: "Aeroccino")
│   └── WhiteModule (Device Name regex: "White" — Barista Milk / Recipe Maker)
│       ├── MilkRecipeAdapter (CRC-checked recipe upload & execution)
│       ├── UiLanguageAdapter
│       ├── SetupCompleteAdapter
│       └── ErrorRetrievalAdapter
└── CoffeeMachineModule (Base Service UUID: 06aa1910-f22a-11e3-9daa-0002a5d5c51b)
    ├── ProdigioModule (Device Name regex: "Prodigio" — MachineType.PRODIGIO)
    │   ├── MachinePropertiesAdapter (Serial 06aa3a31, MachineInfo 06aa3a21)
    │   ├── prodigio.BrewAdapter (Ristretto, Espresso, Lungo, Schedule)
    │   ├── StockAdapter (Capsule Stock 06aa3a15, Threshold 06aa3a25)
    │   ├── MachineMonitoringAdapter (Status 06aa3a12, AdditionalData 06aa3a22)
    │   ├── WaterHardnessAdapter (06aa3a44)
    │   └── ExpertModule (Device Name regex: "Expert" — MachineType.EXPERT)
    │       ├── expert.BrewAdapter (Adds Hot Water, Americano, Temperature)
    │       ├── expert.RecipeBrewAdapter (Custom 2-step recipes 01 10 08 ... + 0x07)
    │       ├── expert.CupSizeAdapter (Rotary Dial Cup Sizes 06aa3a14 / 06aa3a24)
    │       └── expert.StandbyDelayAdapter (Auto-Off Delay 06aa3a44: 9m, 30m, 2h, 8h)
    └── Vtp2Module (Device Name regex: "ESSENZA" — MachineType.VTP2 / Essenza Plus)
        ├── NextPropertiesAdapter, WifiNetworkConfiguration, ScanSsid, CountryConfiguration
        ├── BlueModule (Device Name regex: "Blue" — MachineType.BLUE / Momento)
        │   └── blue.ExpertBrewAdapter (Capsule optical detection 06aa3a16 / 06aa3a26 / 06aa3a36)
        └── VenusModule (Device Name regex: "Venus" — Vertuo Next / CV5 / DV5)
```

---

## 3. Feature-to-Operation Mapping for `ExpertModule` (`MachineType.EXPERT`)

When `ExpertModule.newAdapter(Class<T> feature, DeviceDriver driver)` (`dump_all_nestle_sdk.txt`, line 19530) is called (including inherited features from `ProdigioModule` and `NespressoModule`), it exposes these exact 11 features:

| Feature Interface (`features.*`) | Adapter Class (`adapters.*`) | Underlying Operation Class (`operations.*`) | GATT Characteristics Used |
| :--- | :--- | :--- | :--- |
| `common.Onboarding` | `OnboardingAdapter` | `OnboardingOperations` | `06aa3a61` (TX Level), `06aa3a41` (Auth), `06aa3a51` (KeyState) |
| `common.Authentication` | `AuthenticationAdapter` | `AuthenticationOperations` | `06aa3a41` (Write 8-byte Auth Key) |
| `common.MachineProperties` | `MachinePropertiesAdapter` | `MachinePropertiesOperations` | `06aa3a21` (FW/HW version), `06aa3a31` (Serial Number) |
| `common.FactoryReset` | `FactoryResetAdapter` | *(Direct write)* | `06aa3a42` (`[0x03, 0x07, 0x00]`) |
| `coffeemachine.MachineMonitoring` | `MachineMonitoringAdapter` | `MachineMonitoringOperations` | `06aa3a12` (Status), `06aa3a22` (Slider/Additional), `06aa3a32`, `06aa3a23` |
| `expert.Brew` | `expert.BrewAdapter` | `BrewOperations` | `06aa3a42` (Command), `06aa3a52` (Response), `06aa3a32` (Schedule) |
| `expert.RecipeBrew` | `expert.RecipeBrewAdapter` | `BrewOperations` | `06aa3a42` (`writeRecipe` `11B` + `writeBrewWithTemperatureNow` `10B`), `06aa3a52` |
| `expert.CupSize` | `expert.CupSizeAdapter` | `CupSizeOperations` | `06aa3a14` (Target `0..5`), `06aa3a24` (`[volHi, volLo, 0xFF, 0xFF]`) |
| `expert.StandByDelay` | `expert.StandbyDelayAdapter` | `GeneralUserOperations` | `06aa3a44` (`[secHi, secLo, 0xFF]`) |
| `prodigio.WaterHardness` | `WaterHardnessAdapter` | `GeneralUserOperations` | `06aa3a44` (`[0xFF, 0xFF, level]`) |
| `prodigio.Stock` | `StockAdapter` | `StockOperations` | `06aa3a15` (Stock), `06aa3a25` (Threshold), `06aa3a35` (StockKey) |

---

## 4. Reference File Line Numbers in `raw/dump_all_nestle_sdk.txt`

To jump directly to the disassembled Dalvik bytecode of any core class in [`raw/dump_all_nestle_sdk.txt`](file:///c:/Users/mbord/wa/notpresso-alternative/nespresso-official/rea/raw/dump_all_nestle_sdk.txt):

- `UuidTemplate`: **Line 2115**
- `coffeemachine.MachineStateBuilder`: **Line 2427**
- `ByteConversion`: **Line 2684**
- `PairingKeyStateBuilder`: **Line 2979**
- `TemperatureConversion`: **Line 3012**
- `BrewByteConversion`: **Line 3034**
- `CommandResponseBuilder`: **Line 3289**
- `prodigio.MachineStatusBuilder`: **Line 3413**
- `CupSizeConfiguration`: **Line 6738**
- `CupSizeInterval`: **Line 6820**
- `RecipeBrewParameters`: **Line 7011**
- `StandByDelayOption`: **Line 7146**
- `BrewOperations`: **Line 10480**
- `FactoryResetAdapter`: **Line 12620**
- `OnboardingAdapter`: **Line 12832**
- `expert.BrewAdapter`: **Line 13030**
- `expert.CupSizeAdapter`: **Line 13173**
- `expert.RecipeBrewAdapter`: **Line 13269**
- `expert.StandbyDelayAdapter`: **Line 13322**
- `GeneralUserOperations`: **Line 16673**
- `StockOperations`: **Line 16999**
- `ErrorRetrievalOperations`: **Line 17398**
- `CupSizeOperations`: **Line 17543**
- `MachineMonitoringOperations`: **Line 18506**
- `ExpertModule`: **Line 19498**
