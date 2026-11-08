/**
 * Notpresso Expert - Offline BLE Controller for Nespresso Expert EN 350.G (D80)
 *
 * Implements the Nespresso Expert BLE GATT protocol, custom volumetric recipes,
 * split-temperature two-stage orchestration, and in-chamber soak workflows.
 * See documentation/01-ble-gatt-protocol-reference.md for full byte tables.
 */

const APP_VERSION = '0.3.0';

// 1. BLE GATT Service & Characteristic UUIDs (Base template 06aaXXXX-f22a-11e3-9daa-0002a5d5c51b)
const BLE_UUIDS = {
  // Service 1: Authentication, Device Info & Onboarding (6416 = 0x1910)
  SERVICE_AUTH:        '06aa1910-f22a-11e3-9daa-0002a5d5c51b',
  CHAR_MACHINE_INFO:   '06aa3a21-f22a-11e3-9daa-0002a5d5c51b', // 10B: HW(0..1), FW(4..5), BLE_FW(6..7)
  CHAR_SERIAL:         '06aa3a31-f22a-11e3-9daa-0002a5d5c51b', // 19B ASCII Serial Number
  CHAR_AUTH:           '06aa3a41-f22a-11e3-9daa-0002a5d5c51b', // 8B Write: [0x8X, ...] Credentials
  CHAR_AUTH_TYPE:      '06aa3a51-f22a-11e3-9daa-0002a5d5c51b', // 1B Read: PairingKeyState (0/1=ABSENT, 2=PRESENT)
  CHAR_TX_LEVEL:       '06aa3a61-f22a-11e3-9daa-0002a5d5c51b', // 1B Write: 0x01=LOW_LEVEL (Pair), 0x00=DEFAULT

  // Service 2: Brewing, Commands & Live Monitoring (6432 = 0x1920)
  SERVICE_BREW:        '06aa1920-f22a-11e3-9daa-0002a5d5c51b',
  CHAR_MACHINE_STATUS: '06aa3a12-f22a-11e3-9daa-0002a5d5c51b', // 6-8B Read/Notify: 48-bit MachineStatus
  CHAR_SLIDER:         '06aa3a22-f22a-11e3-9daa-0002a5d5c51b', // 1-14B Read/Notify: Slider (0x00=Open, 0x02=Closed)
  CHAR_SCHEDULE:       '06aa3a32-f22a-11e3-9daa-0002a5d5c51b', // 6B Read: ProgrammedBrew (4B sec BE, 1B temp, 1B type)
  CHAR_COMMAND:        '06aa3a42-f22a-11e3-9daa-0002a5d5c51b', // 3-11B Write: CommandKey
  CHAR_CMD_RESPONSE:   '06aa3a52-f22a-11e3-9daa-0002a5d5c51b', // 20B Read/Notify: CommandResponse

  // Service 4: Rotary Dial Cup Sizes, Standby & Water Hardness (6464 = 0x1940)
  SERVICE_CUP_SIZE:    '06aa1940-f22a-11e3-9daa-0002a5d5c51b',
  CHAR_CUP_TARGET:     '06aa3a14-f22a-11e3-9daa-0002a5d5c51b', // 2B Write: CupTarget (0x0000..0x0005)
  CHAR_CUP_VOLUME:     '06aa3a24-f22a-11e3-9daa-0002a5d5c51b', // 4B Read/Write: [volHi, volLo, 0xFF, 0xFF]
  CHAR_USER_SETTINGS:  '06aa3a44-f22a-11e3-9daa-0002a5d5c51b', // 3-4B Read/Write: [standbyHi, standbyLo, hardness]

  // Service 5: Capsule Stock Counter (6480 = 0x1950)
  SERVICE_STOCK:       '06aa1950-f22a-11e3-9daa-0002a5d5c51b',
  CHAR_STOCK:          '06aa3a15-f22a-11e3-9daa-0002a5d5c51b'  // 2B Read/Write: CapsuleStock (uint16 BE)
};

// Default fallback BLE Auth Key (Override in Settings -> Auth Key; persisted in localStorage)
const DEFAULT_AUTH_KEY = '82C15F832A864437';

/**
 * Machine operational state enum (Byte 1 & 0x0F of 06aa3a12, bits 12..15)
 */
const MACHINE_STATES = {
  0:  { label: 'Resetting',         isBusy: false },
  1:  { label: 'Heating Up',        isBusy: true  },
  2:  { label: 'Ready',             isBusy: false },
  3:  { label: 'Descale Ready',     isBusy: false },
  4:  { label: 'Brewing',           isBusy: true  },
  5:  { label: 'Advanced Menu',     isBusy: false },
  6:  { label: 'Descaling',         isBusy: true  },
  7:  { label: 'Steaming Out',      isBusy: true  },
  8:  { label: 'Error',             isBusy: false },
  9:  { label: 'Standby (Sleep)',   isBusy: false },
  10: { label: 'Overheated',        isBusy: false },
  11: { label: 'Diagnostic Mode',   isBusy: false },
  12: { label: 'BLE Settings',      isBusy: false },
  13: { label: 'Factory Resetting', isBusy: true  },
  14: { label: 'Hardness Menu',     isBusy: false },
  15: { label: 'Standby Menu',      isBusy: false }
};

/**
 * CommandResponse (06aa3a52) rejection subcodes when responseCode == 0x24 (CONDITIONS_NOT_FULFILLED)
 */
const CONDITION_NOT_FULFILLED_REASONS = {
  0x01: 'Invalid machine state for this command.',
  0x02: 'Invalid machine state (standby or busy).',
  0x03: 'Spent capsule container is full! Please empty the bin.',
  0x04: 'Obstacle detected in slider or brewing unit!',
  0x05: 'Descaling mode is active.',
  0x06: 'Previous action has not finished yet.',
  0x07: 'Current action cannot be aborted.',
  0x08: 'Capsule slider is OPEN — please close the slider!',
  0x09: 'No scheduled brew is active.',
  0x10: 'Pump is already running.',
  0x11: 'Brewing unit motor is currently moving.',
  0x12: 'Capsule not changed — open & close the slider to insert a fresh capsule!'
};

// 2. Application State
const state = {
  isConnected: false,
  isScanning: false,
  isNativeAndroid: typeof window.AndroidBle !== 'undefined',
  device: null,
  server: null,
  characteristics: new Map(),

  // Presets tab temperature (TemperatureConversion: 1=LOW/Warm, 0=MEDIUM/Hot, 2=HIGH/Max)
  selectedTemp: 0,

  // Custom Recipe Builder state
  customTemp: 0,
  customSplitTemp: false,
  customCoffeeTemp: 2, // Default Max 90°C for Split-Temp
  customWaterTemp: 1,  // Default Warm 80°C for Split-Temp
  customSequence: 'coffee-first',
  customCoffeeMl: 40,
  customWaterMl: 160,

  // Bloom & Cleaning Capsule Lab state
  bloomPhase1Ml: 40,
  bloomWaitSec: 60,
  bloomPhase2Ml: 130,
  bloomTemp: 2,

  // Active Brew / Multi-stage / Soak state
  isBrewing: false,
  brewInterval: null,
  brewDurationSec: 30,
  brewStartTime: 0,
  activeWorkflow: null, // null | 'two-stage-split' | 'water-pause-soak' | 'two-stage-bloom'
  workflowStage: 0,
  soakInterval: null,
  soakRemainingSec: 0,
  clampTimeoutRemainingSec: 300,

  // Telemetry state
  machineState: 2,
  waterTankEmpty: false,
  sliderOpen: false,
  pairingKeyStateByte: -1,
  capsuleStock: null,
  serialNumber: '--',
  firmwareVersion: '--',

  savedRecipes: [],
  editingRecipeId: null,
  renamingRecipeIndex: null
};

// 3. DOM Elements Cache
const el = {
  envSubtitle: document.getElementById('envSubtitle'),
  connDot: document.getElementById('connDot'),
  connStatusText: document.getElementById('connStatusText'),
  deviceSubtext: document.getElementById('deviceSubtext'),
  btnConnect: document.getElementById('btnConnect'),
  btnConnectText: document.getElementById('btnConnectText'),
  telemetryRow: document.getElementById('telemetryRow'),
  chipMachineState: document.getElementById('chipMachineState'),
  chipSliderState: document.getElementById('chipSliderState'),
  chipPairingState: document.getElementById('chipPairingState'),

  navTabs: document.querySelectorAll('.nav-tab'),
  tabPanes: document.querySelectorAll('.tab-pane'),

  // Tab 1: Presets & Schedule
  tempButtons: document.querySelectorAll('.temp-btn'),
  drinkCards: document.querySelectorAll('.drink-card[data-size]'),
  btnGreatAmericanoPreset: document.getElementById('btnGreatAmericanoPreset'),
  homeFavoritesList: document.getElementById('homeFavoritesList'),
  btnJumpToLibrary: document.getElementById('btnJumpToLibrary'),
  badgeScheduleStatus: document.getElementById('badgeScheduleStatus'),
  selectScheduleDrink: document.getElementById('selectScheduleDrink'),
  selectScheduleDelay: document.getElementById('selectScheduleDelay'),
  btnScheduleBrew: document.getElementById('btnScheduleBrew'),
  btnReadSchedule: document.getElementById('btnReadSchedule'),
  btnCancelSchedule: document.getElementById('btnCancelSchedule'),

  // Tab 2: Custom Recipe & Split-Temp
  btnLoadGreatAmericano: document.getElementById('btnLoadGreatAmericano'),
  seqButtonsCustom: document.querySelectorAll('.seq-btn-custom'),
  chkSplitTemp: document.getElementById('chkSplitTemp'),
  singleTempGroup: document.getElementById('singleTempGroup'),
  splitTempGroup: document.getElementById('splitTempGroup'),
  tempButtonsCustom: document.querySelectorAll('#singleTempGroup .temp-btn-custom'),
  tempButtonsCoffee: document.querySelectorAll('.temp-btn-coffee'),
  tempButtonsWater: document.querySelectorAll('.temp-btn-water'),
  sliderCoffeeMl: document.getElementById('sliderCoffeeMl'),
  sliderWaterMl: document.getElementById('sliderWaterMl'),
  valCoffeeMl: document.getElementById('valCoffeeMl'),
  valWaterMl: document.getElementById('valWaterMl'),
  valTotalMl: document.getElementById('valTotalMl'),
  valRatio: document.getElementById('valRatio'),
  inputCustomRecipeName: document.getElementById('inputCustomRecipeName'),
  btnBrewCustom: document.getElementById('btnBrewCustom'),
  btnBrewCustomLabel: document.getElementById('btnBrewCustomLabel'),
  btnSaveCustom: document.getElementById('btnSaveCustom'),
  btnUpdateCustom: document.getElementById('btnUpdateCustom'),

  // Tab 3: Bloom & Cleaning Capsule Lab
  btnPresetCleaning: document.getElementById('btnPresetCleaning'),
  btnPresetBloomEsp: document.getElementById('btnPresetBloomEsp'),
  btnPresetBloomLungo: document.getElementById('btnPresetBloomLungo'),
  sliderBloomPhase1Ml: document.getElementById('sliderBloomPhase1Ml'),
  valBloomPhase1Ml: document.getElementById('valBloomPhase1Ml'),
  sliderBloomWaitSec: document.getElementById('sliderBloomWaitSec'),
  valBloomWaitSec: document.getElementById('valBloomWaitSec'),
  sliderBloomPhase2Ml: document.getElementById('sliderBloomPhase2Ml'),
  valBloomPhase2Ml: document.getElementById('valBloomPhase2Ml'),
  tempButtonsBloom: document.querySelectorAll('.temp-btn-bloom'),
  inputBloomRecipeName: document.getElementById('inputBloomRecipeName'),
  btnStartWaterPauseCycle: document.getElementById('btnStartWaterPauseCycle'),
  btnStartTwoStageMacro: document.getElementById('btnStartTwoStageMacro'),
  btnSaveBloomRecipe: document.getElementById('btnSaveBloomRecipe'),

  // Tab 4: Saved Library
  libraryList: document.getElementById('libraryList'),
  libraryCount: document.getElementById('libraryCount'),
  btnLibAddCustom: document.getElementById('btnLibAddCustom'),
  btnRestoreCurated: document.getElementById('btnRestoreCurated'),

  // Tab 5: Machine & Dial Config
  selectCupTarget: document.getElementById('selectCupTarget'),
  inputCupVolume: document.getElementById('inputCupVolume'),
  valCupTargetMl: document.getElementById('valCupTargetMl'),
  hintCupRange: document.getElementById('hintCupRange'),
  btnReadCupSize: document.getElementById('btnReadCupSize'),
  btnWriteCupSize: document.getElementById('btnWriteCupSize'),
  btnProfileFactoryDefaults: document.getElementById('btnProfileFactoryDefaults'),
  btnProfileAppCalibration: document.getElementById('btnProfileAppCalibration'),
  btnReadUserSettings: document.getElementById('btnReadUserSettings'),
  selectStandbyDelay: document.getElementById('selectStandbyDelay'),
  btnWriteStandby: document.getElementById('btnWriteStandby'),
  selectWaterHardness: document.getElementById('selectWaterHardness'),
  btnWriteHardness: document.getElementById('btnWriteHardness'),
  valSerial: document.getElementById('valSerial'),
  valFirmware: document.getElementById('valFirmware'),
  valStockCounter: document.getElementById('valStockCounter'),
  valDescaleStatus: document.getElementById('valDescaleStatus'),
  btnOpenOnboarding: document.getElementById('btnOpenOnboarding'),
  btnBleFactoryReset: document.getElementById('btnBleFactoryReset'),

  // Active Brew / Soak Modal
  brewModal: document.getElementById('brewModal'),
  brewCupGraphic: document.getElementById('brewCupGraphic'),
  brewModalTitle: document.getElementById('brewModalTitle'),
  brewModalSub: document.getElementById('brewModalSub'),
  brewProgressBar: document.getElementById('brewProgressBar'),
  soakControlBox: document.getElementById('soakControlBox'),
  soakTimerDisplay: document.getElementById('soakTimerDisplay'),
  soakTimeoutHint: document.getElementById('soakTimeoutHint'),
  btnTriggerSoakTimer: document.getElementById('btnTriggerSoakTimer'),
  btnResumeAfterSoak: document.getElementById('btnResumeAfterSoak'),
  btnStopBrew: document.getElementById('btnStopBrew'),

  // Rename Modal
  renameModal: document.getElementById('renameModal'),
  inputRenameName: document.getElementById('inputRenameName'),
  btnSaveRename: document.getElementById('btnSaveRename'),
  btnCancelRename: document.getElementById('btnCancelRename'),
  btnCloseRename: document.getElementById('btnCloseRename'),

  // Settings & Logs Modals
  btnSettings: document.getElementById('btnSettings'),
  settingsModal: document.getElementById('settingsModal'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  inputAuthKey: document.getElementById('inputAuthKey'),
  btnSaveAuthKey: document.getElementById('btnSaveAuthKey'),
  btnPairNewDevice: document.getElementById('btnPairNewDevice'),

  btnLogs: document.getElementById('btnLogs'),
  logsDrawer: document.getElementById('logsDrawer'),
  btnCloseLogs: document.getElementById('btnCloseLogs'),
  btnClearLogs: document.getElementById('btnClearLogs'),
  logConsole: document.getElementById('logConsole'),
  logCounter: document.getElementById('logCounter'),

  toast: document.getElementById('toast')
};

// 4. Logging & Toast Utilities
let logCount = 1;
function log(msg, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `[${time}] ${msg}`;
  el.logConsole.appendChild(div);
  el.logConsole.scrollTop = el.logConsole.scrollHeight;
  logCount++;
  el.logCounter.textContent = `${logCount} events`;
  console.log(`[Notpresso:${type.toUpperCase()}] ${msg}`);
}

let toastTimeout = null;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.toast.classList.add('hidden');
  }, 3400);
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// 5. PairingKey Codec (4-bit right nibble shift + 0x80 leading prefix)
function convertDbHash32ToBleKey16(hex32) {
  const raw = hexToBytes(hex32.substring(0, 16));
  const out = new Uint8Array(8);
  let prevLow = 8; // High nibble of byte 0 is forced to 0x8 (0x80..0x8F)
  for (let i = 0; i < 8; i++) {
    const b = raw[i] & 0xFF;
    out[i] = ((prevLow << 4) | (b >>> 4)) & 0xFF;
    prevLow = b & 0x0F;
  }
  return bytesToHexNoSpaces(out);
}

function generateValidNespressoKeyHex() {
  const rand = new Uint8Array(8);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < 8; i++) rand[i] = Math.floor(Math.random() * 256);
  }
  const out = new Uint8Array(8);
  let prevLow = 8;
  for (let i = 0; i < 8; i++) {
    const b = rand[i] & 0xFF;
    out[i] = ((prevLow << 4) | (b >>> 4)) & 0xFF;
    prevLow = b & 0x0F;
  }
  return bytesToHexNoSpaces(out);
}

function normalizeAuthKeyInput(rawInput) {
  const clean = (rawInput || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  if (clean.length === 32) {
    const converted = convertDbHash32ToBleKey16(clean);
    log(`Converted 32-char DB pairing_key -> 16-char BLE Auth Key: ${converted}`, 'info');
    return converted;
  }
  if (clean.length === 16) {
    const bytes = hexToBytes(clean);
    bytes[0] = (bytes[0] & 0x0F) | 0x80;
    return bytesToHexNoSpaces(bytes);
  }
  return DEFAULT_AUTH_KEY;
}

function getStoredAuthKey() {
  const stored = localStorage.getItem('notpresso_auth_key');
  return stored ? normalizeAuthKeyInput(stored) : DEFAULT_AUTH_KEY;
}

function setStoredAuthKey(hexStr) {
  const normalized = normalizeAuthKeyInput(hexStr);
  localStorage.setItem('notpresso_auth_key', normalized);
  return normalized;
}

// 6. Curated Favorites & Library Persistence (from Nespresso App setup + advanced cycles)
const DEFAULT_FAVORITE_RECIPES = [
  {
    id: 'fav-water-lungo-extra-hot',
    name: 'Water Lungo Extra Hot',
    kind: 'custom',
    coffeeMl: 0,
    waterMl: 270,
    splitTemp: false,
    temp: 2, // Extra Hot ~90°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-water-lazy-hot-pots',
    name: 'Water Lazy Hot Pots',
    kind: 'custom',
    coffeeMl: 0,
    waterMl: 200,
    splitTemp: false,
    temp: 2, // Extra Hot ~90°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-espresso-long-americano',
    name: 'Espresso Long Americano',
    kind: 'custom',
    coffeeMl: 40,
    waterMl: 160,
    splitTemp: false,
    temp: 2, // Extra Hot ~90°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-espresso-medium-americano',
    name: 'Espresso Medium Americano',
    kind: 'custom',
    coffeeMl: 40,
    waterMl: 120,
    splitTemp: false,
    temp: 0, // Hot ~85°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-espresso-short-americano',
    name: 'Espresso Short Americano',
    kind: 'custom',
    coffeeMl: 40,
    waterMl: 70,
    splitTemp: false,
    temp: 1, // Warm ~80°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-ristretto-lungo-americano',
    name: 'Ristretto Lungo Americano',
    kind: 'custom',
    coffeeMl: 25,
    waterMl: 115,
    splitTemp: false,
    temp: 0, // Hot ~85°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-ristretto-medium-american',
    name: 'Ristretto Medium American',
    kind: 'custom',
    coffeeMl: 25,
    waterMl: 85,
    splitTemp: false,
    temp: 0, // Hot ~85°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-ristretto-short-americano',
    name: 'Ristretto Short Americano',
    kind: 'custom',
    coffeeMl: 25,
    waterMl: 55,
    splitTemp: false,
    temp: 1, // Warm ~80°C
    seq: 'coffee-first'
  },
  {
    id: 'fav-cleaning-capsules',
    name: 'Cleaning Capsules',
    kind: 'custom',
    coffeeMl: 130,
    waterMl: 0,
    splitTemp: false,
    temp: 2, // Extra Hot ~90°C
    seq: 'coffee-first'
  },
  {
    id: 'preset-great-americano',
    name: 'Great Americano XL (Split-Temp)',
    kind: 'custom',
    coffeeMl: 40,
    waterMl: 160,
    splitTemp: true,
    coffeeTemp: 2, // Extra Hot 90°C
    waterTemp: 1,  // Warm 80°C
    temp: 0,
    seq: 'coffee-first'
  },
  {
    id: 'preset-cleaning-capsule-soak',
    name: 'Cleaning Capsule (40ml → 60s → 130ml)',
    kind: 'bloom',
    phase1Ml: 40,
    waitSec: 60,
    phase2Ml: 130,
    temp: 2,
    mode: 'water-pause'
  },
  {
    id: 'preset-bloom-espresso',
    name: 'Pre-Infusion Bloom Espresso (15ml → 10s → 30ml)',
    kind: 'bloom',
    phase1Ml: 15,
    waitSec: 10,
    phase2Ml: 30,
    temp: 2,
    mode: 'water-pause'
  }
];

function loadSavedRecipes() {
  try {
    const raw = localStorage.getItem('notpresso_saved_recipes_v3');
    if (raw) {
      state.savedRecipes = JSON.parse(raw);
    } else {
      state.savedRecipes = JSON.parse(JSON.stringify(DEFAULT_FAVORITE_RECIPES));
      persistSavedRecipes();
    }
  } catch (e) {
    state.savedRecipes = JSON.parse(JSON.stringify(DEFAULT_FAVORITE_RECIPES));
  }
}

function persistSavedRecipes() {
  localStorage.setItem('notpresso_saved_recipes_v3', JSON.stringify(state.savedRecipes));
}

// 7. BLE Read / Write / Connect Abstraction
async function writeBleCharacteristic(uuid, uint8Bytes) {
  if (state.isNativeAndroid) {
    window.AndroidBle.writeCharacteristicHex(uuid, bytesToHexNoSpaces(uint8Bytes));
    return;
  }
  const ch = state.characteristics.get(uuid);
  if (!ch) throw new Error(`Characteristic ${uuid.substring(4, 8)} not available`);
  if (ch.writeValueWithResponse) {
    await ch.writeValueWithResponse(uint8Bytes);
  } else {
    await ch.writeValue(uint8Bytes);
  }
}

async function readBleCharacteristic(uuid) {
  if (state.isNativeAndroid) {
    window.AndroidBle.readCharacteristic(uuid);
    return null;
  }
  const ch = state.characteristics.get(uuid);
  if (!ch) throw new Error(`Characteristic ${uuid.substring(4, 8)} not available`);
  const val = await ch.readValue();
  return new Uint8Array(val.buffer);
}

async function connectBle() {
  if (state.isConnected) {
    await disconnectBle();
    return;
  }

  if (!navigator.bluetooth) {
    alert('Web Bluetooth API is not available in this browser. Please use Chrome on Android/Desktop.');
    return;
  }

  try {
    state.isScanning = true;
    updateConnectionUI();
    log('Scanning for Nespresso Expert EN 350.G...', 'info');

    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'Expert' },
        { namePrefix: 'Nespresso' },
        { services: [BLE_UUIDS.SERVICE_AUTH] },
        { services: [BLE_UUIDS.SERVICE_BREW] }
      ],
      optionalServices: [
        BLE_UUIDS.SERVICE_AUTH,
        BLE_UUIDS.SERVICE_BREW,
        BLE_UUIDS.SERVICE_CUP_SIZE,
        BLE_UUIDS.SERVICE_STOCK
      ]
    });

    state.device = device;
    device.addEventListener('gattserverdisconnected', onDisconnected);

    log(`Selected "${device.name || 'Nespresso Expert'}". Connecting GATT...`, 'info');
    const server = await device.gatt.connect();
    state.server = server;

    await discoverAllCharacteristics(server);
    await performAuthHandshake(false);

    state.isConnected = true;
    state.isScanning = false;
    updateConnectionUI();
    showToast(`Connected to ${device.name || 'Expert EN 350.G'}`);

    // Read initial diagnostics in background
    readInitialTelemetry();
  } catch (err) {
    state.isScanning = false;
    updateConnectionUI();
    log(`Connection error: ${err.message}`, 'err');
    showToast(`Connection failed: ${err.message}`);
  }
}

async function discoverAllCharacteristics(server) {
  state.characteristics.clear();
  const serviceMap = [
    {
      serviceUuid: BLE_UUIDS.SERVICE_AUTH,
      chars: [BLE_UUIDS.CHAR_MACHINE_INFO, BLE_UUIDS.CHAR_SERIAL, BLE_UUIDS.CHAR_AUTH, BLE_UUIDS.CHAR_AUTH_TYPE, BLE_UUIDS.CHAR_TX_LEVEL]
    },
    {
      serviceUuid: BLE_UUIDS.SERVICE_BREW,
      chars: [BLE_UUIDS.CHAR_MACHINE_STATUS, BLE_UUIDS.CHAR_SLIDER, BLE_UUIDS.CHAR_SCHEDULE, BLE_UUIDS.CHAR_COMMAND, BLE_UUIDS.CHAR_CMD_RESPONSE]
    },
    {
      serviceUuid: BLE_UUIDS.SERVICE_CUP_SIZE,
      chars: [BLE_UUIDS.CHAR_CUP_TARGET, BLE_UUIDS.CHAR_CUP_VOLUME, BLE_UUIDS.CHAR_USER_SETTINGS]
    },
    {
      serviceUuid: BLE_UUIDS.SERVICE_STOCK,
      chars: [BLE_UUIDS.CHAR_STOCK]
    }
  ];

  for (const grp of serviceMap) {
    try {
      const svc = await server.getPrimaryService(grp.serviceUuid);
      for (const cUuid of grp.chars) {
        try {
          const ch = await svc.getCharacteristic(cUuid);
          state.characteristics.set(cUuid, ch);
        } catch (_) {}
      }
    } catch (e) {
      log(`Service ${grp.serviceUuid.substring(4, 8)} note: ${e.message}`, 'warn');
    }
  }

  // Subscribe to live notifications on MachineStatus (3a12), Slider (3a22), CommandResponse (3a52)
  for (const notifyUuid of [BLE_UUIDS.CHAR_MACHINE_STATUS, BLE_UUIDS.CHAR_SLIDER, BLE_UUIDS.CHAR_CMD_RESPONSE]) {
    const ch = state.characteristics.get(notifyUuid);
    if (ch) {
      try {
        await ch.startNotifications();
        ch.addEventListener('characteristicvaluechanged', (ev) => {
          handleRawCharacteristicBytes(notifyUuid, new Uint8Array(ev.target.value.buffer));
        });
        log(`Subscribed to notifications on ${notifyUuid.substring(4, 8)}`, 'info');
      } catch (e) {
        log(`Notify ${notifyUuid.substring(4, 8)} note: ${e.message}`, 'warn');
      }
    }
  }
}

async function performAuthHandshake(forceOnboarding = false) {
  const authKeyHex = getStoredAuthKey();

  // Check 06aa3a51 PairingKeyState
  try {
    const keyBytes = await readBleCharacteristic(BLE_UUIDS.CHAR_AUTH_TYPE);
    if (keyBytes && keyBytes.length >= 1) {
      state.pairingKeyStateByte = keyBytes[0];
      log(`[06aa3a51] PairingKeyState = ${keyBytes[0]} (${keyBytes[0] === 2 ? 'PRESENT' : 'ABSENT'})`, 'rx');
    }
  } catch (_) {}

  if (forceOnboarding || state.pairingKeyStateByte === 0 || state.pairingKeyStateByte === 1) {
    log('Writing TX Level [0x01] (LOW_LEVEL) to 06aa3a61 for onboarding...', 'tx');
    try {
      await writeBleCharacteristic(BLE_UUIDS.CHAR_TX_LEVEL, new Uint8Array([0x01]));
      await sleep(200);
    } catch (_) {}
  }

  const authBytes = hexToBytes(authKeyHex);
  if (authBytes.length === 8) {
    authBytes[0] = (authBytes[0] & 0x0F) | 0x80;
  }

  log(`Writing 8-byte Auth Key to 06aa3a41: ${bytesToHex(authBytes)}`, 'tx');
  await writeBleCharacteristic(BLE_UUIDS.CHAR_AUTH, authBytes);
  await sleep(200);

  if (forceOnboarding || state.pairingKeyStateByte === 0 || state.pairingKeyStateByte === 1) {
    log('Writing TX Level [0x00] (DEFAULT_LEVEL) to 06aa3a61 to commit onboarding...', 'tx');
    try {
      await writeBleCharacteristic(BLE_UUIDS.CHAR_TX_LEVEL, new Uint8Array([0x00]));
      await sleep(150);
    } catch (_) {}
  }
}

async function readInitialTelemetry() {
  for (const uuid of [
    BLE_UUIDS.CHAR_MACHINE_STATUS,
    BLE_UUIDS.CHAR_SLIDER,
    BLE_UUIDS.CHAR_AUTH_TYPE,
    BLE_UUIDS.CHAR_SERIAL,
    BLE_UUIDS.CHAR_MACHINE_INFO,
    BLE_UUIDS.CHAR_USER_SETTINGS,
    BLE_UUIDS.CHAR_SCHEDULE
  ]) {
    try {
      const bytes = await readBleCharacteristic(uuid);
      if (bytes) handleRawCharacteristicBytes(uuid, bytes);
      await sleep(120);
    } catch (_) {}
  }
}

// 8. Exact Bit-Level Telemetry & CommandResponse Parser
function selectBit(bytes, startBit, endBit) {
  // Big-endian bitfield extractor (Bit 0 = MSB 0x80 of Byte 0)
  let acc = 0;
  const maxBit = Math.min(endBit, bytes.length * 8 - 1);
  for (let bit = Math.max(0, startBit); bit <= maxBit; bit++) {
    acc <<= 1;
    const byteVal = bytes[Math.floor(bit / 8)] & 0xFF;
    const shift = 7 - (bit % 8);
    acc |= (byteVal >>> shift) & 0x01;
  }
  return acc;
}

function getBitBoolean(bytes, bitIndex) {
  return selectBit(bytes, bitIndex, bitIndex) > 0;
}

function handleRawCharacteristicBytes(uuid, bytes) {
  if (!bytes || bytes.length === 0) return;

  if (uuid === BLE_UUIDS.CHAR_MACHINE_STATUS && bytes.length >= 2) {
    // Decode 48-bit MachineStatus bitfield (06aa3a12)
    const pairingState = selectBit(bytes, 1, 2);
    const errorPresent = getBitBoolean(bytes, 3);
    const descalingNeeded = getBitBoolean(bytes, 5);
    const waterTankEmpty = getBitBoolean(bytes, 7);
    const capsuleContainerFull = getBitBoolean(bytes, 9);
    const stateCode = selectBit(bytes, 12, 15);

    const prevState = state.machineState;
    state.machineState = stateCode;
    state.waterTankEmpty = waterTankEmpty;

    if (bytes.length >= 4) {
      const stockCount = selectBit(bytes, 17, 26);
      const schedActive = getBitBoolean(bytes, 27);
      state.capsuleStock = stockCount;
      el.valStockCounter.textContent = stockCount < 1023 ? `${stockCount} caps` : 'Disabled';
      el.badgeScheduleStatus.textContent = schedActive ? 'Timer Active' : 'Idle';
    }
    if (bytes.length >= 6) {
      const sliderOpen = !getBitBoolean(bytes, 46);
      state.sliderOpen = sliderOpen;
      el.chipSliderState.textContent = sliderOpen ? 'Open' : 'Closed';
    }

    el.valDescaleStatus.textContent = descalingNeeded ? 'Descale Needed!' : 'OK';

    const warnings = [];
    if (waterTankEmpty) warnings.push('Water Empty');
    if (capsuleContainerFull) warnings.push('Bin Full');
    if (descalingNeeded) warnings.push('Descale');
    if (errorPresent) warnings.push('Error');

    const mState = MACHINE_STATES[stateCode] || { label: `State ${stateCode}`, isBusy: false };
    const statusLabel = warnings.length > 0 ? `${mState.label} (${warnings.join(', ')})` : mState.label;
    el.chipMachineState.textContent = statusLabel;
    el.chipPairingState.textContent = pairingState === 2
      ? (state.capsuleStock !== null && state.capsuleStock < 1023 ? `Auth OK • ${state.capsuleStock}` : 'Auth OK (2)')
      : `Unpaired (${pairingState})`;

    log(`[06aa3a12 Status] ${bytesToHex(bytes)} -> ${statusLabel}`, 'rx');

    // Handle active multi-stage workflows on state transitions!
    handleWorkflowStatusUpdate(prevState, stateCode, waterTankEmpty);

  } else if (uuid === BLE_UUIDS.CHAR_SLIDER) {
    const isOpen = bytes[0] === 0x00;
    state.sliderOpen = isOpen;
    el.chipSliderState.textContent = isOpen ? 'Open' : 'Closed';
    log(`[06aa3a22 Slider] ${isOpen ? 'OPEN (0x00)' : 'CLOSED (0x02)'}`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_AUTH_TYPE) {
    const code = bytes[0];
    state.pairingKeyStateByte = code;
    el.chipPairingState.textContent = code === 2 ? 'Auth OK (2)' : `Unpaired (${code})`;
    log(`[06aa3a51 PairingKeyState] ${code} (${code === 2 ? 'PRESENT' : 'ABSENT'})`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_CMD_RESPONSE) {
    decodeCommandResponse(bytes);

  } else if (uuid === BLE_UUIDS.CHAR_SCHEDULE && bytes.length >= 6) {
    // Active scheduled brew (06aa3a32): 4B seconds BE, 1B temp, 1B scheduleType
    const sec = ((bytes[0] & 0xFF) << 24) | ((bytes[1] & 0xFF) << 16) | ((bytes[2] & 0xFF) << 8) | (bytes[3] & 0xFF);
    const tempCode = bytes[4] & 0xFF;
    const typeCode = bytes[5] & 0xFF;
    if (sec > 0 && sec < 86400) {
      const mins = Math.ceil(sec / 60);
      el.badgeScheduleStatus.textContent = `In ${mins}m (0x0${typeCode})`;
      showToast(`Scheduled brew active: ${mins} min remaining`);
    } else {
      el.badgeScheduleStatus.textContent = 'No Timer';
    }
    log(`[06aa3a32 Schedule] ${sec}s remaining, temp=${tempCode}, type=${typeCode}`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_USER_SETTINGS && bytes.length >= 3) {
    // User configuration (06aa3a44): [standbyHi, standbyLo, waterHardness]
    const standbySec = ((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF);
    const hardness = bytes[2] & 0xFF;
    if ([540, 1800, 7200, 28800].includes(standbySec)) {
      el.selectStandbyDelay.value = String(standbySec);
    }
    if (hardness >= 0 && hardness <= 4) {
      el.selectWaterHardness.value = String(hardness);
    }
    log(`[06aa3a44 UserSettings] Standby=${standbySec}s (${Math.round(standbySec / 60)}m), WaterHardness=Level ${hardness}`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_CUP_VOLUME && bytes.length >= 2) {
    const vol = ((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF);
    if (vol >= 10 && vol <= 500) {
      el.inputCupVolume.value = vol;
      el.valCupTargetMl.textContent = `${vol} ml`;
      showToast(`Dial volume read: ${vol} ml`);
    }
    log(`[06aa3a24 CupVolume] ${vol} ml (${bytesToHex(bytes)})`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_SERIAL) {
    const ascii = Array.from(bytes).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '').join('').trim();
    state.serialNumber = ascii || bytesToHex(bytes);
    el.valSerial.textContent = state.serialNumber;
    log(`[06aa3a31 Serial] ${state.serialNumber}`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_MACHINE_INFO && bytes.length >= 8) {
    const hw = `${bytes[0]}.${bytes[1]}`;
    const fw = `${bytes[4]}.${bytes[5]} (BLE ${bytes[6]}.${bytes[7]})`;
    state.firmwareVersion = `FW ${fw} / HW ${hw}`;
    el.valFirmware.textContent = state.firmwareVersion;
    log(`[06aa3a21 MachineInfo] ${state.firmwareVersion}`, 'rx');
  }
}

function decodeCommandResponse(bytes) {
  const hex = bytesToHex(bytes);
  // Check both 20-byte SDK layout (bytes[3]=code, bytes[4]=subcode) and 4-byte layout (bytes[2]=code, bytes[3]=subcode)
  let respCode = bytes.length >= 5 ? bytes[3] : (bytes.length >= 4 ? bytes[2] : bytes[0]);
  let subCode = bytes.length >= 5 ? bytes[4] : (bytes.length >= 4 ? bytes[3] : 0);

  if (respCode === 0x20 || (bytes[0] & 0xF0) === 0x80) {
    log(`[06aa3a52 CommandResponse] ACK / DONE (${hex})`, 'rx');
  } else if (respCode === 0x36) {
    log(`[06aa3a52 Command Rejected] OUT_OF_RANGE (0x36): Requested volume out of bounds (${hex})`, 'err');
    showToast('Command rejected: Volume out of hardware range!');
  } else if (respCode === 0x24 || (bytes[0] & 0xC0) === 0xC0) {
    const reason = CONDITION_NOT_FULFILLED_REASONS[subCode] || `Condition not fulfilled (0x24, subcode 0x${subCode.toString(16)})`;
    log(`[06aa3a52 Command Rejected] ${reason} (${hex})`, 'err');
    showToast(reason);
  } else {
    log(`[06aa3a52 CommandResponse] ${hex}`, 'rx');
  }
}

async function disconnectBle() {
  if (state.device && state.device.gatt.connected) {
    state.device.gatt.disconnect();
  }
  onDisconnected();
}

function onDisconnected() {
  state.isConnected = false;
  state.isScanning = false;
  state.characteristics.clear();
  updateConnectionUI();
  log('Disconnected from machine.', 'warn');
}

function updateConnectionUI() {
  if (state.isConnected) {
    el.connDot.className = 'status-dot connected';
    el.connStatusText.textContent = state.device ? (state.device.name || 'Connected') : 'Connected';
    el.deviceSubtext.textContent = 'Web Bluetooth GATT Authenticated';
    el.btnConnect.className = 'btn btn-outline';
    el.btnConnectText.textContent = 'Disconnect';
    el.telemetryRow.classList.remove('hidden');
  } else if (state.isScanning) {
    el.connDot.className = 'status-dot scanning';
    el.connStatusText.textContent = 'Scanning...';
    el.deviceSubtext.textContent = 'Select your Expert EN 350.G';
    el.btnConnectText.textContent = 'Scanning...';
    el.telemetryRow.classList.add('hidden');
  } else {
    el.connDot.className = 'status-dot disconnected';
    el.connStatusText.textContent = 'Disconnected';
    el.deviceSubtext.textContent = 'Tap Connect to scan for Expert EN 350.G';
    el.btnConnect.className = 'btn btn-connect';
    el.btnConnectText.textContent = 'Connect';
    el.telemetryRow.classList.add('hidden');
  }
}

// 9. Brew & Recipe Command Builders (06aa3a42 CommandKey frames)

/**
 * Builds the 11-byte custom recipe definition payload:
 * [0x01, 0x10, 0x08, 0x00, 0x00, step1Type, step1Hi, step1Lo, step2Type, step2Hi, step2Lo]
 * If one ingredient has 0 ml, Step 1 holds the active ingredient and Step 2 is padded with [0x00, 0x00, 0x00].
 */
function buildSetRecipePayload(coffeeMl, waterMl, sequence = 'coffee-first') {
  const cHi = (coffeeMl >> 8) & 0xFF;
  const cLo = coffeeMl & 0xFF;
  const wHi = (waterMl >> 8) & 0xFF;
  const wLo = waterMl & 0xFF;

  if (coffeeMl > 0 && waterMl === 0) {
    return new Uint8Array([0x01, 0x10, 0x08, 0x00, 0x00, 0x01, cHi, cLo, 0x00, 0x00, 0x00]);
  }
  if (waterMl > 0 && coffeeMl === 0) {
    return new Uint8Array([0x01, 0x10, 0x08, 0x00, 0x00, 0x02, wHi, wLo, 0x00, 0x00, 0x00]);
  }
  if (sequence === 'water-first') {
    return new Uint8Array([0x01, 0x10, 0x08, 0x00, 0x00, 0x02, wHi, wLo, 0x01, cHi, cLo]);
  }
  return new Uint8Array([0x01, 0x10, 0x08, 0x00, 0x00, 0x01, cHi, cLo, 0x02, wHi, wLo]);
}

/**
 * Builds the 10-byte getProgrammedBrewPayload:
 * [0x03, 0x05, 0x07, 0x04, delayB3, delayB2, delayB1, delayB0, tempByte, coffeeTypeId]
 */
function buildProgrammedBrewPayload(coffeeTypeId, tempCode, delaySeconds = 0) {
  const d3 = (delaySeconds >>> 24) & 0xFF;
  const d2 = (delaySeconds >>> 16) & 0xFF;
  const d1 = (delaySeconds >>> 8) & 0xFF;
  const d0 = delaySeconds & 0xFF;
  return new Uint8Array([
    0x03, 0x05, 0x07, 0x04,
    d3, d2, d1, d0,
    tempCode & 0xFF,
    coffeeTypeId & 0xFF
  ]);
}

function getTempLabel(tempCode) {
  if (tempCode === 2) return 'Max ~90°C';
  if (tempCode === 1) return 'Warm ~80°C';
  return 'Hot ~85°C';
}

async function brewPreset(drinkName, sizeCode, tempCode) {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  state.activeWorkflow = null;
  const payload = buildProgrammedBrewPayload(sizeCode, tempCode, 0);
  log(`Triggering ${drinkName} (ID: 0x0${sizeCode}, Temp: ${getTempLabel(tempCode)}): ${bytesToHex(payload)}`, 'tx');

  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, payload);
    startBrewTracking(`Brewing ${drinkName}`, `Temperature: ${getTempLabel(tempCode)}`, calculateBrewDuration(sizeCode));
  } catch (err) {
    log(`Brew error: ${err.message}`, 'err');
    showToast(`Brew error: ${err.message}`);
  }
}

async function sendSingleStageCustomBrew(coffeeMl, waterMl, tempCode, sequence, titleLabel) {
  const recipePayload = buildSetRecipePayload(coffeeMl, waterMl, sequence);
  log(`writeRecipe [Coffee ${coffeeMl}ml, Water ${waterMl}ml, ${sequence}]: ${bytesToHex(recipePayload)}`, 'tx');
  await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, recipePayload);
  await sleep(250);

  const execPayload = buildProgrammedBrewPayload(0x07, tempCode, 0);
  log(`writeBrewWithTemperatureNow (0x07, ${getTempLabel(tempCode)}): ${bytesToHex(execPayload)}`, 'tx');
  await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, execPayload);

  const estDuration = Math.max(15, Math.round((coffeeMl + waterMl) * 0.33));
  startBrewTracking(titleLabel || `Brewing Custom (${coffeeMl}ml + ${waterMl}ml)`, `Temp: ${getTempLabel(tempCode)} • ${sequence === 'water-first' ? 'Water → Coffee' : 'Coffee → Water'}`, estDuration);
}

/**
 * Executes either a Single-Temp Custom Recipe OR a 2-Stage Split-Temperature Recipe ("Great Americano")!
 */
async function brewCustomRecipe(coffeeMl, waterMl, options = {}) {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  if (coffeeMl === 0 && waterMl === 0) {
    showToast('Set at least Coffee or Water volume above 0 ml!');
    return;
  }

  const sequence = options.seq || state.customSequence || 'coffee-first';
  const splitTemp = options.splitTemp !== undefined ? options.splitTemp : state.customSplitTemp;
  const singleTemp = options.temp !== undefined ? options.temp : state.customTemp;
  const coffeeTemp = options.coffeeTemp !== undefined ? options.coffeeTemp : state.customCoffeeTemp;
  const waterTemp = options.waterTemp !== undefined ? options.waterTemp : state.customWaterTemp;

  // If only 1 ingredient is > 0 or both temperatures are identical, run native 1-command recipe:
  if (!splitTemp || coffeeMl === 0 || waterMl === 0 || coffeeTemp === waterTemp) {
    state.activeWorkflow = null;
    const effectiveTemp = coffeeMl === 0 ? waterTemp : (splitTemp ? coffeeTemp : singleTemp);
    try {
      await sendSingleStageCustomBrew(coffeeMl, waterMl, effectiveTemp, sequence);
    } catch (err) {
      log(`Custom recipe error: ${err.message}`, 'err');
      showToast(`Error: ${err.message}`);
    }
    return;
  }

  // Otherwise execute 2-Stage Split-Temperature Orchestration!
  const firstIsWater = sequence === 'water-first';
  const stage1 = firstIsWater
    ? { coffeeMl: 0, waterMl, temp: waterTemp, label: `Stage 1/2: ${waterMl}ml Water (${getTempLabel(waterTemp)})` }
    : { coffeeMl, waterMl: 0, temp: coffeeTemp, label: `Stage 1/2: ${coffeeMl}ml Coffee (${getTempLabel(coffeeTemp)})` };
  const stage2 = firstIsWater
    ? { coffeeMl, waterMl: 0, temp: coffeeTemp, label: `Stage 2/2: ${coffeeMl}ml Coffee (${getTempLabel(coffeeTemp)})` }
    : { coffeeMl: 0, waterMl, temp: waterTemp, label: `Stage 2/2: ${waterMl}ml Water (${getTempLabel(waterTemp)})` };

  state.activeWorkflow = {
    type: 'two-stage-split',
    stage: 1,
    stage1,
    stage2,
    stage2Triggered: false
  };

  log(`Starting 2-Stage Split-Temp Brew: [${stage1.label}] -> [${stage2.label}]`, 'info');
  try {
    await sendSingleStageCustomBrew(stage1.coffeeMl, stage1.waterMl, stage1.temp, 'coffee-first', stage1.label);
    el.brewModalSub.textContent = `Next up automatically: ${stage2.label}`;
  } catch (err) {
    state.activeWorkflow = null;
    log(`Split-temp Stage 1 error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

// 10. Bloom & Cleaning Capsule Multi-Phase Workflows
async function startWaterPauseSoakWorkflow(phase1Ml, waitSec, phase2Ml, tempCode) {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }

  const phase1Sec = Math.max(5, Math.round(phase1Ml / 3.4));
  state.activeWorkflow = {
    type: 'water-pause-soak',
    phase1Ml,
    phase1Sec,
    waitSec,
    phase2Ml,
    tempCode,
    soakStarted: false
  };

  log(`Starting In-Chamber Water-Pause Soak: Phase 1 (~${phase1Ml}ml / ~${phase1Sec}s) -> ${waitSec}s Soak -> ${phase2Ml}ml Flush`, 'info');
  try {
    await sendSingleStageCustomBrew(
      phase2Ml,
      0,
      tempCode,
      'coffee-first',
      `Phase 1: Wetting Capsule (${phase1Ml} ml target)`
    );
    el.soakControlBox.classList.remove('hidden');
    el.soakTimerDisplay.textContent = formatMmSs(waitSec);
    el.brewModalSub.textContent = `At ~${phase1Ml} ml (~${phase1Sec}s), lift water tank 1 cm (or let low water run out) to pause chamber!`;
  } catch (err) {
    state.activeWorkflow = null;
    log(`Water-pause start error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function startTwoStageBloomMacro(phase1Ml, waitSec, phase2Ml, tempCode) {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }

  state.activeWorkflow = {
    type: 'two-stage-bloom',
    stage: 1,
    phase1Ml,
    waitSec,
    phase2Ml,
    tempCode,
    soakStarted: false,
    stage2Triggered: false
  };

  log(`Starting 2-Stage Bloom/Clean Macro: ${phase1Ml}ml -> ${waitSec}s Wait -> ${phase2Ml}ml`, 'info');
  try {
    await sendSingleStageCustomBrew(
      phase1Ml,
      0,
      tempCode,
      'coffee-first',
      `Stage 1/2: Pulling ${phase1Ml} ml (${getTempLabel(tempCode)})`
    );
    el.soakControlBox.classList.remove('hidden');
    el.soakTimerDisplay.textContent = formatMmSs(waitSec);
    el.brewModalSub.textContent = `After ${phase1Ml} ml finishes, ${waitSec}s countdown will start automatically.`;
  } catch (err) {
    state.activeWorkflow = null;
    log(`2-Stage macro error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

function beginSoakCountdown(waitSec, clampMaxSec = 300) {
  if (!state.activeWorkflow) return;
  state.activeWorkflow.soakStarted = true;
  state.soakRemainingSec = waitSec;
  state.clampTimeoutRemainingSec = clampMaxSec;

  clearInterval(state.brewInterval);
  clearInterval(state.soakInterval);

  el.soakControlBox.classList.remove('hidden');
  el.brewCupGraphic.textContent = '⏱️';
  el.brewModalTitle.textContent = `Soaking / Blooming Capsule (${waitSec}s)`;
  el.brewModalSub.textContent = state.activeWorkflow.type === 'water-pause-soak'
    ? 'Chamber clamped! Refill/seat water tank, then tap Resume when timer reaches 00:00.'
    : 'Countdown active! Re-drop cleaning capsule & flick slider if needed; Stage 2 fires at 00:00.';

  state.soakInterval = setInterval(async () => {
    state.soakRemainingSec = Math.max(0, state.soakRemainingSec - 1);
    state.clampTimeoutRemainingSec = Math.max(0, state.clampTimeoutRemainingSec - 1);

    el.soakTimerDisplay.textContent = formatMmSs(state.soakRemainingSec);
    el.soakTimeoutHint.textContent = `Firmware LONG_BREW_TIMEOUT window remaining: ${formatMmSs(state.clampTimeoutRemainingSec)}`;

    const pct = Math.min(100, Math.round(((waitSec - state.soakRemainingSec) / Math.max(1, waitSec)) * 100));
    el.brewProgressBar.style.width = `${pct}%`;

    if (state.soakRemainingSec === 0) {
      clearInterval(state.soakInterval);
      showToast('Soak / Bloom timer complete! Ready for Phase 2.');
      log('Soak / Bloom timer reached 00:00!', 'info');

      if (state.activeWorkflow && state.activeWorkflow.type === 'two-stage-bloom' && !state.activeWorkflow.stage2Triggered) {
        await resumePhase2Extraction();
      } else {
        el.brewModalTitle.textContent = 'Soak Complete — Tap Resume!';
      }
    }
  }, 1000);
}

async function resumePhase2Extraction() {
  const wf = state.activeWorkflow;
  if (!wf) return;
  clearInterval(state.soakInterval);
  wf.stage2Triggered = true;
  el.soakControlBox.classList.add('hidden');
  el.brewCupGraphic.textContent = '☕';

  try {
    log(`Triggering Phase 2 Extraction (${wf.phase2Ml} ml @ ${getTempLabel(wf.tempCode)})...`, 'tx');
    state.activeWorkflow = null;
    await sendSingleStageCustomBrew(
      wf.phase2Ml,
      0,
      wf.tempCode,
      'coffee-first',
      `Phase 2: Extracting ${wf.phase2Ml} ml (${getTempLabel(wf.tempCode)})`
    );
  } catch (err) {
    log(`Phase 2 resume error: ${err.message}`, 'err');
    showToast(`Resume error: ${err.message}`);
  }
}

async function handleWorkflowStatusUpdate(prevState, newState, waterTankEmpty) {
  const wf = state.activeWorkflow;

  // 1. If In-Chamber Water-Pause Soak detects Water Tank Empty (06aa3a12 bit 7), auto-start the soak countdown!
  if (wf && wf.type === 'water-pause-soak' && !wf.soakStarted && waterTankEmpty) {
    log('Detected Water Tank Empty (06aa3a12 bit 7) — chamber is paused & clamped! Starting soak countdown.', 'info');
    showToast('Water pause detected! Starting soak timer.');
    beginSoakCountdown(wf.waitSec, 300);
    return;
  }

  // 2. If 2-Stage Split-Temp finished Stage 1 (transitioned from BREWING/HEAT_UP back to READY=2):
  if (wf && wf.type === 'two-stage-split' && wf.stage === 1 && !wf.stage2Triggered) {
    if ((prevState === 4 || prevState === 1) && newState === 2) {
      wf.stage = 2;
      wf.stage2Triggered = true;
      const s2 = wf.stage2;
      log(`Stage 1 finished (MachineState=READY). Launching Stage 2: ${s2.label}`, 'info');
      state.activeWorkflow = null;
      await sleep(350);
      await sendSingleStageCustomBrew(s2.coffeeMl, s2.waterMl, s2.temp, 'coffee-first', s2.label);
      return;
    }
  }

  // 3. If 2-Stage Bloom/Clean Macro finished Stage 1 (transitioned from BREWING to READY=2):
  if (wf && wf.type === 'two-stage-bloom' && wf.stage === 1 && !wf.soakStarted) {
    if (prevState === 4 && newState === 2) {
      log(`Phase 1 complete. Starting ${wf.waitSec}s soak/bloom countdown...`, 'info');
      beginSoakCountdown(wf.waitSec, 300);
      return;
    }
  }

  // Standard brew progress tracking
  const mState = MACHINE_STATES[newState] || { isBusy: false };
  if (mState.isBusy && !state.isBrewing) {
    startBrewTracking('Extraction in Progress', 'Machine is running...', 30);
  } else if (!mState.isBusy && state.isBrewing && !state.activeWorkflow) {
    finishBrewTracking();
  }
}

// 11. Hardware Scheduled Brew, Rotary Dial Cup Sizes & User Settings (06aa3a44)
async function scheduleHardwareBrew() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const drinkCode = parseInt(el.selectScheduleDrink.value, 10);
  const delaySec = parseInt(el.selectScheduleDelay.value, 10);

  try {
    if (drinkCode === 7) {
      const recipePayload = buildSetRecipePayload(state.customCoffeeMl, state.customWaterMl, state.customSequence);
      log(`Loading custom recipe before scheduling: ${bytesToHex(recipePayload)}`, 'tx');
      await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, recipePayload);
      await sleep(250);
    }

    const schedPayload = buildProgrammedBrewPayload(drinkCode, state.selectedTemp, delaySec);
    log(`Scheduling hardware brew in ${delaySec}s (03 05 07 04): ${bytesToHex(schedPayload)}`, 'tx');
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, schedPayload);
    el.badgeScheduleStatus.textContent = `In ${Math.round(delaySec / 60)}m`;
    showToast(`Scheduled brew on machine in ${Math.round(delaySec / 60)} min!`);
  } catch (err) {
    log(`Schedule error: ${err.message}`, 'err');
    showToast(`Schedule error: ${err.message}`);
  }
}

async function readScheduledBrew() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  try {
    const bytes = await readBleCharacteristic(BLE_UUIDS.CHAR_SCHEDULE);
    if (bytes) handleRawCharacteristicBytes(BLE_UUIDS.CHAR_SCHEDULE, bytes);
  } catch (err) {
    log(`Read schedule error: ${err.message}`, 'err');
  }
}

async function emergencyStop() {
  state.activeWorkflow = null;
  clearInterval(state.soakInterval);
  el.soakControlBox.classList.add('hidden');

  const stopPayload = new Uint8Array([0x03, 0x06, 0x01, 0x02]);
  log(`Sending Abort Action (03 06 01 02): ${bytesToHex(stopPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, stopPayload);
    finishBrewTracking();
    el.badgeScheduleStatus.textContent = 'Idle';
    showToast('Action cancelled.');
  } catch (err) {
    log(`Cancel error: ${err.message}`, 'err');
  }
}

async function readDialCupSize() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const targetIdx = parseInt(el.selectCupTarget.value, 10);
  const targetPayload = new Uint8Array([(targetIdx >> 8) & 0xFF, targetIdx & 0xFF]);
  log(`Selecting CupTarget ${targetIdx} on 06aa3a14: ${bytesToHex(targetPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_TARGET, targetPayload);
    await sleep(200);
    const volBytes = await readBleCharacteristic(BLE_UUIDS.CHAR_CUP_VOLUME);
    if (volBytes) handleRawCharacteristicBytes(BLE_UUIDS.CHAR_CUP_VOLUME, volBytes);
  } catch (err) {
    log(`Cup size read error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function writeDialCupSize() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const targetIdx = parseInt(el.selectCupTarget.value, 10);
  const volMl = parseInt(el.inputCupVolume.value, 10);
  const targetPayload = new Uint8Array([(targetIdx >> 8) & 0xFF, targetIdx & 0xFF]);
  const volPayload = new Uint8Array([(volMl >> 8) & 0xFF, volMl & 0xFF, 0xFF, 0xFF]);

  log(`Programming Dial Target ${targetIdx} -> ${volMl} ml: ${bytesToHex(volPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_TARGET, targetPayload);
    await sleep(200);
    await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_VOLUME, volPayload);
    showToast(`Saved ${volMl} ml to rotary dial!`);
  } catch (err) {
    log(`Cup size write error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function readUserSettings() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  try {
    const bytes = await readBleCharacteristic(BLE_UUIDS.CHAR_USER_SETTINGS);
    if (bytes) handleRawCharacteristicBytes(BLE_UUIDS.CHAR_USER_SETTINGS, bytes);
    showToast('Read Standby & Water Hardness from machine');
  } catch (err) {
    log(`Read 06aa3a44 error: ${err.message}`, 'err');
  }
}

async function writeStandbyDelay() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const sec = parseInt(el.selectStandbyDelay.value, 10);
  // GeneralUserOperations.select: [secHi, secLo, 0xFF] (0xFF leaves water hardness unchanged)
  const payload = new Uint8Array([(sec >> 8) & 0xFF, sec & 0xFF, 0xFF]);
  log(`Writing Standby Delay (${sec}s) to 06aa3a44: ${bytesToHex(payload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_USER_SETTINGS, payload);
    showToast(`Auto-off timer set to ${Math.round(sec / 60)} min!`);
  } catch (err) {
    log(`Write standby error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function writeWaterHardness() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const level = parseInt(el.selectWaterHardness.value, 10);
  // GeneralUserOperations.writeLevel: [0xFF, 0xFF, level] (0xFFFF leaves standby delay unchanged)
  const payload = new Uint8Array([0xFF, 0xFF, level & 0xFF]);
  log(`Writing Water Hardness (Level ${level}) to 06aa3a44: ${bytesToHex(payload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_USER_SETTINGS, payload);
    showToast(`Water hardness set to Level ${level}!`);
  } catch (err) {
    log(`Write water hardness error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function sendBleFactoryReset() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  if (!confirm('Send BLE Factory Reset [03 07 00] to the Nespresso Expert? This clears the stored pairing key and resets rotary dial cup volumes to factory defaults.')) {
    return;
  }
  const resetPayload = new Uint8Array([0x03, 0x07, 0x00]);
  log(`Sending FactoryResetAdapter.PAYLOAD to 06aa3a42: ${bytesToHex(resetPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, resetPayload);
    showToast('Factory Reset command sent!');
  } catch (err) {
    log(`Factory reset error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

// 12. Brewing Progress Overlay Tracking
function startBrewTracking(title, subtitle, durationSec) {
  state.isBrewing = true;
  state.brewDurationSec = durationSec;
  state.brewStartTime = Date.now();

  el.brewCupGraphic.textContent = '☕';
  el.brewModalTitle.textContent = title;
  el.brewModalSub.textContent = subtitle || 'Machine is running. Please keep cup under outlet...';
  el.brewModal.classList.remove('hidden');
  el.brewProgressBar.style.width = '0%';

  if (!state.activeWorkflow || state.activeWorkflow.type === 'two-stage-split') {
    el.soakControlBox.classList.add('hidden');
  }

  clearInterval(state.brewInterval);
  state.brewInterval = setInterval(async () => {
    const elapsedSec = (Date.now() - state.brewStartTime) / 1000;
    const progress = Math.min(100, Math.round((elapsedSec / state.brewDurationSec) * 100));
    el.brewProgressBar.style.width = `${progress}%`;

    // If Water-Pause Soak workflow is in Phase 1, show live estimated ml pumped!
    const wf = state.activeWorkflow;
    if (wf && wf.type === 'water-pause-soak' && !wf.soakStarted) {
      const estMl = Math.min(wf.phase2Ml, Math.round(elapsedSec * 3.4));
      if (estMl >= wf.phase1Ml) {
        el.brewModalTitle.textContent = `Reached ~${wf.phase1Ml} ml! Lift Water Tank Now!`;
      } else {
        el.brewModalTitle.textContent = `Phase 1: ~${estMl} / ${wf.phase1Ml} ml pumped`;
      }
    }

    if (elapsedSec >= state.brewDurationSec) {
      // Fallback if 06aa3a12 notifications did not fire for 2-stage split-temp:
      if (wf && wf.type === 'two-stage-split' && wf.stage === 1 && !wf.stage2Triggered) {
        wf.stage = 2;
        wf.stage2Triggered = true;
        const s2 = wf.stage2;
        state.activeWorkflow = null;
        await sendSingleStageCustomBrew(s2.coffeeMl, s2.waterMl, s2.temp, 'coffee-first', s2.label);
        return;
      }
      if (wf && wf.type === 'two-stage-bloom' && wf.stage === 1 && !wf.soakStarted) {
        beginSoakCountdown(wf.waitSec, 300);
        return;
      }
      if (!wf || !wf.soakStarted) {
        finishBrewTracking();
      }
    }
  }, 250);
}

function finishBrewTracking() {
  state.isBrewing = false;
  clearInterval(state.brewInterval);
  el.brewProgressBar.style.width = '100%';
  setTimeout(() => {
    if (!state.activeWorkflow) {
      el.brewModal.classList.add('hidden');
    }
  }, 600);
}

function calculateBrewDuration(sizeCode) {
  switch (sizeCode) {
    case 0: return 18;
    case 1: return 25;
    case 2: return 40;
    case 5: return 50;
    case 4: return 45;
    default: return 30;
  }
}

// 13. Custom Recipe & ZeroOrRangeValue Snap Logic (0 or 15..130ml Coffee, 0 or 25..300ml Water)
function snapCoffeeVolume(rawVal) {
  const v = parseInt(rawVal, 10) || 0;
  if (v <= 7) return 0;
  if (v < 15) return 15;
  return Math.min(130, v);
}

function snapWaterVolume(rawVal) {
  const v = parseInt(rawVal, 10) || 0;
  if (v <= 12) return 0;
  if (v < 25) return 25;
  return Math.min(300, v);
}

function updateCustomRecipeSummary() {
  const coffee = snapCoffeeVolume(el.sliderCoffeeMl.value);
  const water = snapWaterVolume(el.sliderWaterMl.value);
  el.sliderCoffeeMl.value = coffee;
  el.sliderWaterMl.value = water;

  state.customCoffeeMl = coffee;
  state.customWaterMl = water;

  el.valCoffeeMl.textContent = `${coffee} ml`;
  el.valWaterMl.textContent = `${water} ml`;

  const total = coffee + water;
  el.valTotalMl.textContent = `${total} ml`;

  // EditableRecipeMapper.getMatchingVolume classification
  let profile = '';
  if (coffee === 0 && water > 0) {
    profile = 'Pure Hot Water';
  } else if (water === 0) {
    if (coffee <= 25) profile = 'Ristretto (Pure)';
    else if (coffee <= 40) profile = 'Espresso (Pure)';
    else profile = 'Lungo (Pure)';
  } else {
    const ratio = (water / coffee).toFixed(1);
    const kind = state.customSequence === 'water-first' ? 'Long Black' : 'Americano';
    profile = `${kind} (1:${ratio})`;
  }
  el.valRatio.textContent = profile;

  const isSplit = state.customSplitTemp && coffee > 0 && water > 0 && state.customCoffeeTemp !== state.customWaterTemp;
  el.btnBrewCustomLabel.textContent = isSplit
    ? `Start 2-Stage Split-Temp (${total} ml)`
    : `Start Custom Extraction (${total} ml)`;
}

function updateCupRangeHint() {
  const opt = el.selectCupTarget.options[el.selectCupTarget.selectedIndex];
  const min = parseInt(opt.dataset.min, 10);
  const max = parseInt(opt.dataset.max, 10);
  const def = parseInt(opt.dataset.def, 10);
  el.inputCupVolume.min = min;
  el.inputCupVolume.max = max;
  const cur = parseInt(el.inputCupVolume.value, 10);
  const clamped = Math.max(min, Math.min(max, cur || def));
  el.inputCupVolume.value = clamped;
  el.valCupTargetMl.textContent = `${clamped} ml`;
  el.hintCupRange.textContent = `Hardware allowed range: ${min} ml – ${max} ml (Factory default: ${def} ml)`;
}

// 14. Saved Library & Favorites UI
function renderLibrary() {
  if (!el.libraryList) return;
  el.libraryList.innerHTML = '';
  el.libraryCount.textContent = `${state.savedRecipes.length} items`;

  if (state.savedRecipes.length === 0) {
    el.libraryList.innerHTML = '<div class="alert alert-warning" style="text-align:center;">No saved recipes. Craft one in Custom or tap "Restore Nespresso App Favorites"!</div>';
    return;
  }

  state.savedRecipes.forEach((recipe, idx) => {
    const item = document.createElement('div');
    item.className = 'recipe-item';

    let details = '';
    let totalMl = 0;
    if (recipe.kind === 'bloom') {
      totalMl = (recipe.phase1Ml || 0) + (recipe.phase2Ml || 0);
      details = `${recipe.phase1Ml}ml Phase 1 → ${recipe.waitSec}s Soak → ${recipe.phase2Ml}ml Phase 2 (${totalMl}ml) • ${getTempLabel(recipe.temp)}`;
    } else {
      totalMl = (recipe.coffeeMl || 0) + (recipe.waterMl || 0);
      const seqLabel = recipe.seq === 'water-first' ? 'Water→Coffee' : 'Coffee→Water';
      const tempDesc = recipe.splitTemp
        ? `Split: ☕${getTempLabel(recipe.coffeeTemp)} / 💧${getTempLabel(recipe.waterTemp)}`
        : getTempLabel(recipe.temp);
      details = `${recipe.coffeeMl}ml coffee + ${recipe.waterMl}ml water (${totalMl}ml) • ${tempDesc} • ${seqLabel}`;
    }

    const isFirst = idx === 0;
    const isLast = idx === state.savedRecipes.length - 1;

    item.innerHTML = `
      <div class="recipe-reorder-col">
        <button class="btn-reorder btn-move-up" data-idx="${idx}" ${isFirst ? 'disabled' : ''} title="Move Up">▲</button>
        <button class="btn-reorder btn-move-down" data-idx="${idx}" ${isLast ? 'disabled' : ''} title="Move Down">▼</button>
      </div>
      <div class="recipe-info-col">
        <div class="recipe-name-row">
          <span class="recipe-meta-name">${escapeHtml(recipe.name)}</span>
          <button class="btn-inline-rename" data-idx="${idx}" title="Rename">✏️</button>
        </div>
        <div class="recipe-meta-details">${escapeHtml(details)}</div>
      </div>
      <div class="recipe-actions">
        <button class="btn btn-connect btn-brew-saved" data-idx="${idx}">Brew</button>
        <button class="icon-btn btn-edit-saved" data-idx="${idx}" title="Edit / Tweak in Custom Tab">🎛️</button>
        <button class="icon-btn btn-del-saved" data-idx="${idx}" title="Delete">🗑️</button>
      </div>
    `;
    el.libraryList.appendChild(item);
  });

  // Reorder buttons
  document.querySelectorAll('.btn-move-up').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      moveRecipe(idx, -1);
    });
  });
  document.querySelectorAll('.btn-move-down').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      moveRecipe(idx, 1);
    });
  });

  // Rename buttons
  document.querySelectorAll('.btn-inline-rename').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      openRenameModal(idx);
    });
  });

  // Brew buttons
  document.querySelectorAll('.btn-brew-saved').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const r = state.savedRecipes[idx];
      if (!r) return;
      if (r.kind === 'bloom') {
        startWaterPauseSoakWorkflow(r.phase1Ml, r.waitSec, r.phase2Ml, r.temp);
      } else {
        brewCustomRecipe(r.coffeeMl, r.waterMl, r);
      }
    });
  });

  // Edit buttons
  document.querySelectorAll('.btn-edit-saved').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      editRecipeInCustomTab(idx);
    });
  });

  // Delete buttons
  document.querySelectorAll('.btn-del-saved').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const r = state.savedRecipes[idx];
      if (confirm(`Delete "${r.name}" from library?`)) {
        state.savedRecipes.splice(idx, 1);
        persistSavedRecipes();
        renderLibrary();
        renderFavoritesOnHome();
        showToast('Recipe deleted');
      }
    });
  });
}

function renderFavoritesOnHome() {
  if (!el.homeFavoritesList) return;
  el.homeFavoritesList.innerHTML = '';

  if (state.savedRecipes.length === 0) {
    el.homeFavoritesList.innerHTML = '<div class="card-desc" style="text-align:center; padding:12px;">No favorites yet. Add one in Custom or restore from Library!</div>';
    return;
  }

  state.savedRecipes.forEach((recipe, idx) => {
    const card = document.createElement('div');
    card.className = 'home-favorite-card';

    let totalMl = 0;
    let desc = '';
    if (recipe.kind === 'bloom') {
      totalMl = (recipe.phase1Ml || 0) + (recipe.phase2Ml || 0);
      desc = `${recipe.phase1Ml}ml Phase 1 → ${recipe.waitSec}s Soak → ${recipe.phase2Ml}ml Phase 2 • ${getTempLabel(recipe.temp)}`;
    } else {
      totalMl = (recipe.coffeeMl || 0) + (recipe.waterMl || 0);
      const tempDesc = recipe.splitTemp
        ? `Split: ☕${getTempLabel(recipe.coffeeTemp)} / 💧${getTempLabel(recipe.waterTemp)}`
        : getTempLabel(recipe.temp);
      const seqLabel = recipe.seq === 'water-first' ? 'Water first' : 'Coffee first';
      desc = `${recipe.coffeeMl}ml coffee + ${recipe.waterMl}ml water • ${tempDesc} • ${seqLabel}`;
    }

    card.innerHTML = `
      <div class="home-fav-info">
        <div class="home-fav-top">
          <span class="home-fav-name">${escapeHtml(recipe.name)}</span>
          <span class="home-fav-vol">${totalMl} ml</span>
        </div>
        <div class="home-fav-desc">${escapeHtml(desc)}</div>
      </div>
      <div class="home-fav-actions">
        <button class="btn btn-connect btn-home-fav-brew" data-idx="${idx}" style="padding:6px 14px; font-size:12px;">Brew</button>
        <button class="icon-btn btn-home-fav-edit" data-idx="${idx}" title="Edit in Custom Tab">🎛️</button>
      </div>
    `;
    el.homeFavoritesList.appendChild(card);
  });

  document.querySelectorAll('.btn-home-fav-brew').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const r = state.savedRecipes[idx];
      if (!r) return;
      if (r.kind === 'bloom') {
        startWaterPauseSoakWorkflow(r.phase1Ml, r.waitSec, r.phase2Ml, r.temp);
      } else {
        brewCustomRecipe(r.coffeeMl, r.waterMl, r);
      }
    });
  });

  document.querySelectorAll('.btn-home-fav-edit').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      editRecipeInCustomTab(idx);
    });
  });
}

function moveRecipe(idx, delta) {
  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= state.savedRecipes.length) return;
  const temp = state.savedRecipes[idx];
  state.savedRecipes[idx] = state.savedRecipes[targetIdx];
  state.savedRecipes[targetIdx] = temp;
  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  showToast(`Moved "${temp.name}" ${delta < 0 ? 'up' : 'down'}`);
}

function openRenameModal(idx) {
  const r = state.savedRecipes[idx];
  if (!r) return;
  state.renamingRecipeIndex = idx;
  el.inputRenameName.value = r.name;
  el.renameModal.classList.remove('hidden');
  el.inputRenameName.focus();
  el.inputRenameName.select();
}

function closeRenameModal() {
  el.renameModal.classList.add('hidden');
  state.renamingRecipeIndex = null;
}

function saveRename() {
  if (state.renamingRecipeIndex === null) return;
  const newName = el.inputRenameName.value.trim();
  if (!newName) {
    showToast('Please enter a recipe name');
    return;
  }
  const r = state.savedRecipes[state.renamingRecipeIndex];
  r.name = newName;
  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  closeRenameModal();
  showToast(`Renamed to "${newName}"`);
}

function switchTab(tabId) {
  el.navTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  el.tabPanes.forEach(p => p.classList.toggle('active', p.id === tabId));
}

function editRecipeInCustomTab(idx) {
  const r = state.savedRecipes[idx];
  if (!r) return;

  if (r.kind === 'bloom') {
    state.bloomPhase1Ml = r.phase1Ml || 40;
    state.bloomWaitSec = r.waitSec || 60;
    state.bloomPhase2Ml = r.phase2Ml || 130;
    state.bloomTemp = r.temp !== undefined ? r.temp : 2;

    el.sliderBloomPhase1Ml.value = state.bloomPhase1Ml;
    el.valBloomPhase1Ml.textContent = `${state.bloomPhase1Ml} ml`;
    el.sliderBloomWaitSec.value = state.bloomWaitSec;
    el.valBloomWaitSec.textContent = `${state.bloomWaitSec} sec`;
    el.sliderBloomPhase2Ml.value = state.bloomPhase2Ml;
    el.valBloomPhase2Ml.textContent = `${state.bloomPhase2Ml} ml`;
    if (el.inputBloomRecipeName) el.inputBloomRecipeName.value = r.name;

    el.tempButtonsBloom.forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.temp, 10) === state.bloomTemp);
    });

    switchTab('tab-bloom');
    showToast(`Loaded "${r.name}" in Bloom/Clean tab`);
    return;
  }

  // Custom recipe
  state.customCoffeeMl = r.coffeeMl !== undefined ? r.coffeeMl : 40;
  state.customWaterMl = r.waterMl !== undefined ? r.waterMl : 160;
  state.customSplitTemp = !!r.splitTemp;
  state.customCoffeeTemp = r.coffeeTemp !== undefined ? r.coffeeTemp : (r.temp || 2);
  state.customWaterTemp = r.waterTemp !== undefined ? r.waterTemp : (r.temp || 1);
  state.customTemp = r.temp !== undefined ? r.temp : 0;
  state.customSequence = r.seq || 'coffee-first';
  state.editingRecipeId = r.id;

  if (el.inputCustomRecipeName) el.inputCustomRecipeName.value = r.name;
  if (el.btnUpdateCustom) el.btnUpdateCustom.classList.remove('hidden');

  syncCustomRecipeUI();
  switchTab('tab-custom');
  showToast(`Loaded "${r.name}" for editing`);
}

function saveCurrentCustomRecipe() {
  const inputName = el.inputCustomRecipeName ? el.inputCustomRecipeName.value.trim() : '';
  const defaultName = state.customSplitTemp
    ? 'Split-Temp Americano'
    : (state.customCoffeeMl === 0 ? 'Hot Water Dispense' : `${state.customCoffeeMl}ml Coffee Recipe`);
  const name = inputName || defaultName;

  const newRecipe = {
    id: Date.now().toString(),
    name: name,
    kind: 'custom',
    coffeeMl: state.customCoffeeMl,
    waterMl: state.customWaterMl,
    splitTemp: state.customSplitTemp,
    coffeeTemp: state.customCoffeeTemp,
    waterTemp: state.customWaterTemp,
    temp: state.customTemp,
    seq: state.customSequence
  };

  state.savedRecipes.unshift(newRecipe);
  state.editingRecipeId = newRecipe.id;
  if (el.btnUpdateCustom) el.btnUpdateCustom.classList.remove('hidden');
  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  showToast(`Saved "${newRecipe.name}" to Library!`);
}

function updateCurrentCustomRecipe() {
  if (!state.editingRecipeId) {
    saveCurrentCustomRecipe();
    return;
  }
  const idx = state.savedRecipes.findIndex(r => r.id === state.editingRecipeId);
  if (idx === -1) {
    saveCurrentCustomRecipe();
    return;
  }

  const inputName = el.inputCustomRecipeName ? el.inputCustomRecipeName.value.trim() : '';
  const existing = state.savedRecipes[idx];
  existing.name = inputName || existing.name;
  existing.coffeeMl = state.customCoffeeMl;
  existing.waterMl = state.customWaterMl;
  existing.splitTemp = state.customSplitTemp;
  existing.coffeeTemp = state.customCoffeeTemp;
  existing.waterTemp = state.customWaterTemp;
  existing.temp = state.customTemp;
  existing.seq = state.customSequence;

  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  showToast(`Updated "${existing.name}"!`);
}

function saveCurrentBloomRecipe() {
  const inputName = el.inputBloomRecipeName ? el.inputBloomRecipeName.value.trim() : '';
  const name = inputName || 'Cleaning Capsule Cycle';

  const newRecipe = {
    id: Date.now().toString(),
    name: name,
    kind: 'bloom',
    phase1Ml: state.bloomPhase1Ml,
    waitSec: state.bloomWaitSec,
    phase2Ml: state.bloomPhase2Ml,
    temp: state.bloomTemp,
    mode: 'water-pause'
  };

  state.savedRecipes.unshift(newRecipe);
  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  showToast(`Saved "${newRecipe.name}"`);
}

function restoreCuratedFavorites() {
  if (confirm('Restore the official Nespresso app favorites + multi-stage cycles to your library?')) {
    state.savedRecipes = JSON.parse(JSON.stringify(DEFAULT_FAVORITE_RECIPES));
    persistSavedRecipes();
    renderLibrary();
    renderFavoritesOnHome();
    showToast('Restored Nespresso app favorites!');
  }
}

// Machine Dial Quick Profiles
function applyFactoryDefaultsProfile() {
  el.selectCupTarget.value = '1'; // Espresso
  el.inputCupVolume.value = 40;
  el.valCupTargetMl.textContent = '40 ml';
  updateCupRangeHint();
  showToast('Profile: Factory Defaults (25 / 40 / 110 / 200 / 25 / 125)');
}

function applyAppCalibrationProfile() {
  el.selectCupTarget.value = '2'; // Lungo (80 ml in screenshot)
  el.inputCupVolume.value = 80;
  el.valCupTargetMl.textContent = '80 ml';
  updateCupRangeHint();
  showToast('Profile: App Calibration (25 / 40 / 80 / 230 / 40 / 140)');
}

// 15. Formatting & Byte Helpers
function formatMmSs(totalSec) {
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = Math.floor(totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function hexToBytes(hex) {
  const clean = (hex || '').replace(/[^A-Fa-f0-9]/g, '');
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length * 2; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function bytesToHexNoSpaces(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}

// 16. Event Listeners Initialization
function initListeners() {
  el.btnConnect.addEventListener('click', connectBle);

  // Navigation Tabs
  el.navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      el.navTabs.forEach(t => t.classList.remove('active'));
      el.tabPanes.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });

  // Tab 1: Presets & Schedule
  el.tempButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tempButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedTemp = parseInt(btn.dataset.temp, 10);
    });
  });

  el.drinkCards.forEach(card => {
    card.addEventListener('click', () => {
      const drinkName = card.querySelector('.drink-name').textContent;
      const sizeCode = parseInt(card.dataset.size, 10);
      brewPreset(drinkName, sizeCode, state.selectedTemp);
    });
  });

  el.btnGreatAmericanoPreset.addEventListener('click', () => {
    brewCustomRecipe(40, 160, {
      seq: 'coffee-first',
      splitTemp: true,
      coffeeTemp: 2, // Max 90°C
      waterTemp: 1   // Warm 80°C
    });
  });

  el.btnScheduleBrew.addEventListener('click', scheduleHardwareBrew);
  el.btnReadSchedule.addEventListener('click', readScheduledBrew);
  el.btnCancelSchedule.addEventListener('click', emergencyStop);

  // Tab 2: Custom Recipe & Split-Temp Builder
  el.btnLoadGreatAmericano.addEventListener('click', () => {
    el.sliderCoffeeMl.value = 40;
    el.sliderWaterMl.value = 160;
    state.customSequence = 'coffee-first';
    el.seqButtonsCustom.forEach(b => b.classList.toggle('active', b.dataset.seq === 'coffee-first'));
    el.chkSplitTemp.checked = true;
    state.customSplitTemp = true;
    el.singleTempGroup.classList.add('hidden');
    el.splitTempGroup.classList.remove('hidden');
    state.customCoffeeTemp = 2;
    state.customWaterTemp = 1;
    el.tempButtonsCoffee.forEach(b => b.classList.toggle('active', parseInt(b.dataset.temp, 10) === 2));
    el.tempButtonsWater.forEach(b => b.classList.toggle('active', parseInt(b.dataset.temp, 10) === 1));
    updateCustomRecipeSummary();
    showToast('Loaded Great Americano (40ml @ Max + 160ml @ Warm)');
  });

  el.seqButtonsCustom.forEach(btn => {
    btn.addEventListener('click', () => {
      el.seqButtonsCustom.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.customSequence = btn.dataset.seq;
      updateCustomRecipeSummary();
    });
  });

  el.chkSplitTemp.addEventListener('change', () => {
    state.customSplitTemp = el.chkSplitTemp.checked;
    el.singleTempGroup.classList.toggle('hidden', state.customSplitTemp);
    el.splitTempGroup.classList.toggle('hidden', !state.customSplitTemp);
    updateCustomRecipeSummary();
  });

  el.tempButtonsCustom.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tempButtonsCustom.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.customTemp = parseInt(btn.dataset.temp, 10);
    });
  });

  el.tempButtonsCoffee.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tempButtonsCoffee.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.customCoffeeTemp = parseInt(btn.dataset.temp, 10);
      updateCustomRecipeSummary();
    });
  });

  el.tempButtonsWater.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tempButtonsWater.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.customWaterTemp = parseInt(btn.dataset.temp, 10);
      updateCustomRecipeSummary();
    });
  });

  el.sliderCoffeeMl.addEventListener('input', updateCustomRecipeSummary);
  el.sliderWaterMl.addEventListener('input', updateCustomRecipeSummary);

  // Fine-tune +/- buttons
  document.querySelectorAll('.btn-step').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      const delta = parseInt(btn.dataset.delta, 10);
      if (target === 'coffee') {
        let next = state.customCoffeeMl + delta;
        if (state.customCoffeeMl === 0 && delta > 0) next = 15;
        else if (state.customCoffeeMl === 15 && delta < 0) next = 0;
        el.sliderCoffeeMl.value = Math.max(0, Math.min(130, next));
      } else {
        let next = state.customWaterMl + delta;
        if (state.customWaterMl === 0 && delta > 0) next = 25;
        else if (state.customWaterMl <= 25 && delta < 0) next = 0;
        el.sliderWaterMl.value = Math.max(0, Math.min(300, next));
      }
      updateCustomRecipeSummary();
    });
  });

  // Quick volume chips
  document.querySelectorAll('.chip-btn[data-coffee]').forEach(chip => {
    chip.addEventListener('click', () => {
      el.sliderCoffeeMl.value = parseInt(chip.dataset.coffee, 10);
      updateCustomRecipeSummary();
    });
  });
  document.querySelectorAll('.chip-btn[data-water]').forEach(chip => {
    chip.addEventListener('click', () => {
      el.sliderWaterMl.value = parseInt(chip.dataset.water, 10);
      updateCustomRecipeSummary();
    });
  });

  el.btnBrewCustom.addEventListener('click', () => {
    brewCustomRecipe(state.customCoffeeMl, state.customWaterMl);
  });
  el.btnSaveCustom.addEventListener('click', saveCurrentCustomRecipe);
  if (el.btnUpdateCustom) el.btnUpdateCustom.addEventListener('click', updateCurrentCustomRecipe);
  if (el.btnJumpToLibrary) el.btnJumpToLibrary.addEventListener('click', () => switchTab('tab-saved'));
  if (el.btnLibAddCustom) el.btnLibAddCustom.addEventListener('click', () => {
    state.editingRecipeId = null;
    if (el.btnUpdateCustom) el.btnUpdateCustom.classList.add('hidden');
    if (el.inputCustomRecipeName) el.inputCustomRecipeName.value = '';
    switchTab('tab-custom');
  });
  if (el.btnRestoreCurated) el.btnRestoreCurated.addEventListener('click', restoreCuratedFavorites);

  // Tab 3: Bloom & Cleaning Capsule Lab
  function applyBloomTemplate(p1, wait, p2, temp, activeBtn) {
    [el.btnPresetCleaning, el.btnPresetBloomEsp, el.btnPresetBloomLungo].forEach(b => b.classList.remove('active-chip'));
    if (activeBtn) activeBtn.classList.add('active-chip');
    state.bloomPhase1Ml = p1;
    state.bloomWaitSec = wait;
    state.bloomPhase2Ml = p2;
    state.bloomTemp = temp;
    el.sliderBloomPhase1Ml.value = p1;
    el.valBloomPhase1Ml.textContent = `${p1} ml`;
    el.sliderBloomWaitSec.value = wait;
    el.valBloomWaitSec.textContent = `${wait} sec`;
    el.sliderBloomPhase2Ml.value = p2;
    el.valBloomPhase2Ml.textContent = `${p2} ml`;
    el.tempButtonsBloom.forEach(b => b.classList.toggle('active', parseInt(b.dataset.temp, 10) === temp));
  }

  el.btnPresetCleaning.addEventListener('click', () => applyBloomTemplate(40, 60, 130, 2, el.btnPresetCleaning));
  el.btnPresetBloomEsp.addEventListener('click', () => applyBloomTemplate(15, 10, 30, 2, el.btnPresetBloomEsp));
  el.btnPresetBloomLungo.addEventListener('click', () => applyBloomTemplate(15, 12, 95, 0, el.btnPresetBloomLungo));

  el.sliderBloomPhase1Ml.addEventListener('input', () => {
    state.bloomPhase1Ml = parseInt(el.sliderBloomPhase1Ml.value, 10);
    el.valBloomPhase1Ml.textContent = `${state.bloomPhase1Ml} ml`;
  });
  el.sliderBloomWaitSec.addEventListener('input', () => {
    state.bloomWaitSec = parseInt(el.sliderBloomWaitSec.value, 10);
    el.valBloomWaitSec.textContent = `${state.bloomWaitSec} sec`;
  });
  document.querySelectorAll('.chip-btn[data-bloomwait]').forEach(chip => {
    chip.addEventListener('click', () => {
      state.bloomWaitSec = parseInt(chip.dataset.bloomwait, 10);
      el.sliderBloomWaitSec.value = state.bloomWaitSec;
      el.valBloomWaitSec.textContent = `${state.bloomWaitSec} sec`;
    });
  });
  el.sliderBloomPhase2Ml.addEventListener('input', () => {
    state.bloomPhase2Ml = parseInt(el.sliderBloomPhase2Ml.value, 10);
    el.valBloomPhase2Ml.textContent = `${state.bloomPhase2Ml} ml`;
  });
  el.tempButtonsBloom.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tempButtonsBloom.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.bloomTemp = parseInt(btn.dataset.temp, 10);
    });
  });

  el.btnStartWaterPauseCycle.addEventListener('click', () => {
    startWaterPauseSoakWorkflow(state.bloomPhase1Ml, state.bloomWaitSec, state.bloomPhase2Ml, state.bloomTemp);
  });
  el.btnStartTwoStageMacro.addEventListener('click', () => {
    startTwoStageBloomMacro(state.bloomPhase1Ml, state.bloomWaitSec, state.bloomPhase2Ml, state.bloomTemp);
  });
  el.btnSaveBloomRecipe.addEventListener('click', saveCurrentBloomRecipe);

  // Modal Soak Controls
  el.btnTriggerSoakTimer.addEventListener('click', () => {
    const wait = state.activeWorkflow ? state.activeWorkflow.waitSec : state.bloomWaitSec;
    beginSoakCountdown(wait, 300);
  });
  el.btnResumeAfterSoak.addEventListener('click', resumePhase2Extraction);
  el.btnStopBrew.addEventListener('click', emergencyStop);

  // Tab 5: Machine & Dial Config
  el.selectCupTarget.addEventListener('change', updateCupRangeHint);
  el.inputCupVolume.addEventListener('input', () => {
    el.valCupTargetMl.textContent = `${el.inputCupVolume.value} ml`;
  });
  el.btnReadCupSize.addEventListener('click', readDialCupSize);
  el.btnWriteCupSize.addEventListener('click', writeDialCupSize);
  if (el.btnProfileFactoryDefaults) el.btnProfileFactoryDefaults.addEventListener('click', applyFactoryDefaultsProfile);
  if (el.btnProfileAppCalibration) el.btnProfileAppCalibration.addEventListener('click', applyAppCalibrationProfile);
  el.btnReadUserSettings.addEventListener('click', readUserSettings);
  el.btnWriteStandby.addEventListener('click', writeStandbyDelay);
  el.btnWriteHardness.addEventListener('click', writeWaterHardness);
  el.btnOpenOnboarding.addEventListener('click', () => {
    el.inputAuthKey.value = getStoredAuthKey();
    el.settingsModal.classList.remove('hidden');
  });
  el.btnBleFactoryReset.addEventListener('click', sendBleFactoryReset);

  // Rename Modal
  if (el.btnSaveRename) el.btnSaveRename.addEventListener('click', saveRename);
  if (el.btnCancelRename) el.btnCancelRename.addEventListener('click', closeRenameModal);
  if (el.btnCloseRename) el.btnCloseRename.addEventListener('click', closeRenameModal);
  if (el.renameModal) {
    el.renameModal.addEventListener('click', (e) => {
      if (e.target === el.renameModal) closeRenameModal();
    });
  }
  if (el.inputRenameName) {
    el.inputRenameName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveRename();
      else if (e.key === 'Escape') closeRenameModal();
    });
  }

  // Settings Modal
  el.btnSettings.addEventListener('click', () => {
    el.inputAuthKey.value = getStoredAuthKey();
    el.settingsModal.classList.remove('hidden');
  });
  el.btnCloseSettings.addEventListener('click', () => {
    el.settingsModal.classList.add('hidden');
  });
  el.btnSaveAuthKey.addEventListener('click', () => {
    const raw = el.inputAuthKey.value.trim();
    const cleanHex = raw.replace(/[^A-Fa-f0-9]/g, '');
    if (cleanHex.length !== 16 && cleanHex.length !== 32) {
      alert('Please enter either a 16-character BLE Auth Key (starting with 8) OR a 32-character Nespresso SQLite pairing_key.');
      return;
    }
    const saved = setStoredAuthKey(cleanHex);
    el.inputAuthKey.value = saved;
    el.settingsModal.classList.add('hidden');
    showToast(`Saved Auth Key: ${saved}`);
    log(`Saved Auth Key: ${saved}`, 'info');
  });

  el.btnPairNewDevice.addEventListener('click', async () => {
    const newKey = generateValidNespressoKeyHex();
    setStoredAuthKey(newKey);
    el.inputAuthKey.value = newKey;
    log(`Generated new Nespresso 0x8X PairingKey: ${newKey}`, 'info');
    if (state.isConnected) {
      try {
        await performAuthHandshake(true);
        showToast(`Onboarding complete! Key: ${newKey}`);
      } catch (e) {
        log(`Onboarding error: ${e.message}`, 'err');
      }
    } else {
      showToast(`Generated ${newKey}! Now tap Connect.`);
    }
  });

  // Logs Drawer
  el.btnLogs.addEventListener('click', () => el.logsDrawer.classList.remove('hidden'));
  el.btnCloseLogs.addEventListener('click', () => el.logsDrawer.classList.add('hidden'));
  el.btnClearLogs.addEventListener('click', () => {
    el.logConsole.innerHTML = '';
    logCount = 0;
    el.logCounter.textContent = '0 events';
  });

  [el.settingsModal, el.logsDrawer].forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });
}

// 17. Service Worker Registration
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
  initListeners();
  loadSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  updateCustomRecipeSummary();
  updateCupRangeHint();
  registerServiceWorker();
  log(`Notpresso Expert v${APP_VERSION} initialized (AuthKey: ${getStoredAuthKey()}).`, 'info');
});
