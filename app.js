/**
 * Notpresso Expert - Offline BLE Controller for Nespresso Expert EN 350.G (D80)
 *
 * Implements the Nespresso Expert BLE GATT protocol, custom volumetric recipes,
 * split-temperature two-stage orchestration, and in-chamber soak workflows.
 * See documentation/01-ble-gatt-protocol-reference.md for full byte tables.
 */

const APP_VERSION = '0.13.10';
const LOGO_HOLD_REFRESH_SEC = 3;

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

  // Service 3: Hardware Error / Fault History Log (6448 = 0x1930)
  SERVICE_ERROR:       '06aa1930-f22a-11e3-9daa-0002a5d5c51b',
  CHAR_ERROR_SELECT:   '06aa3a13-f22a-11e3-9daa-0002a5d5c51b', // 1B Write: Error slot index (0x00..0x09)
  CHAR_ERROR_INFO:     '06aa3a23-f22a-11e3-9daa-0002a5d5c51b', // 19B Read: [errorNumber, category<<4, subCode, ...]

  // Service 4: Rotary Dial Cup Sizes, Standby & Water Hardness (6464 = 0x1940)
  SERVICE_CUP_SIZE:    '06aa1940-f22a-11e3-9daa-0002a5d5c51b',
  CHAR_CUP_TARGET:     '06aa3a14-f22a-11e3-9daa-0002a5d5c51b', // 2B Write: CupTarget (0x0000..0x0005)
  CHAR_CUP_VOLUME:     '06aa3a24-f22a-11e3-9daa-0002a5d5c51b', // 4B Read/Write: [volHi, volLo, 0xFF, 0xFF]
  CHAR_USER_SETTINGS:  '06aa3a44-f22a-11e3-9daa-0002a5d5c51b', // 3-4B Read/Write: [standbyHi, standbyLo, hardness]

  // Service 5: Capsule Stock Counter & Threshold (6480 = 0x1950)
  SERVICE_STOCK:       '06aa1950-f22a-11e3-9daa-0002a5d5c51b',
  CHAR_STOCK:          '06aa3a15-f22a-11e3-9daa-0002a5d5c51b', // 2B Read/Write: CapsuleStock (uint16 BE)
  CHAR_STOCK_THRESHOLD:'06aa3a25-f22a-11e3-9daa-0002a5d5c51b'  // 2B Read/Write: Low-Stock Threshold (uint16 BE)
};

const ERROR_CATEGORIES = {
  0: 'NONE',
  1: 'INFO',
  2: 'WARN',
  3: 'ERROR',
  4: 'FATAL'
};

// First-Use / Post-Weekend System Rinse sequence per Manual pp. 7, 10 (3x Lungo + 2x Hot Water @ Hot/Medium temp)
const SYSTEM_RINSE_STEPS = [
  { step: 1, sizeCode: 2, tempCode: 0, label: 'Shot 1/5: Lungo Rinse (1/3 • Coffee Outlet)' },
  { step: 2, sizeCode: 2, tempCode: 0, label: 'Shot 2/5: Lungo Rinse (2/3 • Coffee Outlet)' },
  { step: 3, sizeCode: 2, tempCode: 0, label: 'Shot 3/5: Lungo Rinse (3/3 • Coffee Outlet)' },
  { step: 4, sizeCode: 4, tempCode: 0, label: 'Shot 4/5: Hot Water Rinse (1/2 • Water Spout)' },
  { step: 5, sizeCode: 4, tempCode: 0, label: 'Shot 5/5: Hot Water Rinse (2/2 • Water Spout)' }
];

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

const PRESET_DRINK_DEFAULTS = {
  hotwater:          { name: 'Hot Water',          sizeCode: 4,    coffeeMl: 0,   waterMl: 250, temp: 2,       splitTemp: false, actionLabel: 'Dispense' },
  ristretto:         { name: 'Ristretto',          sizeCode: 0,    coffeeMl: 25,  waterMl: 0,   temp: 0,       splitTemp: false, actionLabel: 'Brew' },
  espresso:          { name: 'Espresso',           sizeCode: 1,    coffeeMl: 40,  waterMl: 0,   temp: 0,       splitTemp: false, actionLabel: 'Brew' },
  lungo:             { name: 'Lungo',              sizeCode: 2,    coffeeMl: 110, waterMl: 0,   temp: 0,       splitTemp: false, actionLabel: 'Brew' },
  americano:         { name: 'Americano',          sizeCode: 5,    coffeeMl: 25,  waterMl: 125, temp: 0, coffeeTemp: 0, waterTemp: 0, seq: 'coffee-first', splitTemp: false, actionLabel: 'Brew' },
  'great-americano': { name: 'Great Americano XL', sizeCode: null, coffeeMl: 40,  waterMl: 160, temp: 2, coffeeTemp: 2, waterTemp: 1, seq: 'water-first',  splitTemp: true,  actionLabel: 'Brew' }
};

// 2. Application State
const state = {
  isConnected: false,
  isScanning: false,
  device: null,
  server: null,
  characteristics: new Map(),

  // Presets tab temperature & per-card ad-hoc tweaks (TemperatureConversion: 1=LOW/Warm, 0=MEDIUM/Hot, 2=HIGH/Max)
  selectedTemp: 0,
  expandedPresetDrink: null,
  presetTweaks: JSON.parse(JSON.stringify(PRESET_DRINK_DEFAULTS)),

  // Custom Recipe Builder state
  customTemp: 0,
  customSplitTemp: true,
  customCoffeeTemp: 2, // Default Max 90°C for Coffee stage
  customWaterTemp: 1,  // Default Warm 80°C for Water stage
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
  lastBrewTemp: 0,
  postBrewInterval: null,
  postBrewRemainingSec: 0,
  activeWorkflow: null, // null | 'two-stage-split' | 'water-pause-soak' | 'two-stage-bloom' | 'system-rinse'
  workflowStage: 0,
  soakInterval: null,
  soakRemainingSec: 0,
  clampTimeoutRemainingSec: 300,

  // Telemetry state
  machineState: 2,
  waterTankEmpty: false,
  capsuleContainerFull: false,
  descalingNeeded: false,
  waterHardnessLevel: 3,
  sliderOpen: false,
  obstacleDetected: false,
  errorPresent: false,
  capsuleStockLow: false,
  pairingKeyStateByte: -1,
  capsuleStock: null,
  capsuleStockThreshold: null,
  selectedErrorSlot: 0,
  lastErrorRecord: null,
  machineDialVolumes: { 0: 25, 1: 40, 2: 110, 3: 25, 4: 125, 5: 200 },
  lastCupTargetIdx: null,
  serialNumber: '--',
  firmwareVersion: '--',

  descaleStep: 1,
  descaleDone: false,

  savedRecipes: [],
  recipeTempOverrides: {}, // Transient per-cup temperature overrides keyed by recipe.id: 1 (80°C), 0 (85°C), 2 (90°C), or 'split'
  editingRecipeId: null,
  renamingRecipeIndex: null
};

// 3. DOM Elements Cache
const el = {
  connDot: document.getElementById('connDot'),
  connStatusText: document.getElementById('connStatusText'),
  deviceSubtext: document.getElementById('deviceSubtext'),
  btnConnect: document.getElementById('btnConnect'),
  btnConnectText: document.getElementById('btnConnectText'),
  telemetryRow: document.getElementById('telemetryRow'),
  chipMachineState: document.getElementById('chipMachineState'),
  chipSliderState: document.getElementById('chipSliderState'),
  chipPairingState: document.getElementById('chipPairingState'),
  ledTelematicsBanner: document.getElementById('ledTelematicsBanner'),
  ledBannerDot: document.getElementById('ledBannerDot'),
  ledBannerTitle: document.getElementById('ledBannerTitle'),
  ledBannerDesc: document.getElementById('ledBannerDesc'),
  btnJumpToDescale: document.getElementById('btnJumpToDescale'),

  navTabs: document.querySelectorAll('.nav-tab'),
  tabPanes: document.querySelectorAll('.tab-pane'),

  // Tab 1: Presets & Schedule
  presetDrinkCards: document.querySelectorAll('.drink-card[data-drink]'),
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
  customStagesList: document.getElementById('customStagesList'),
  btnSwapCustomStages: document.getElementById('btnSwapCustomStages'),
  customStageCoffee: document.getElementById('customStageCoffee'),
  customStageWater: document.getElementById('customStageWater'),
  badgeCustomCoffeeOrder: document.getElementById('badgeCustomCoffeeOrder'),
  badgeCustomWaterOrder: document.getElementById('badgeCustomWaterOrder'),
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
  valStockThreshold: document.getElementById('valStockThreshold'),
  valFaultRecord: document.getElementById('valFaultRecord'),
  inputStockCount: document.getElementById('inputStockCount'),
  btnReadStock: document.getElementById('btnReadStock'),
  btnWriteStock: document.getElementById('btnWriteStock'),
  btnDisableStock: document.getElementById('btnDisableStock'),
  inputStockThreshold: document.getElementById('inputStockThreshold'),
  btnReadStockThreshold: document.getElementById('btnReadStockThreshold'),
  btnWriteStockThreshold: document.getElementById('btnWriteStockThreshold'),
  selectErrorSlot: document.getElementById('selectErrorSlot'),
  btnReadErrorSlot: document.getElementById('btnReadErrorSlot'),
  badgeRinseStatus: document.getElementById('badgeRinseStatus'),
  btnStartSystemRinse: document.getElementById('btnStartSystemRinse'),
  btnStopSystemRinse: document.getElementById('btnStopSystemRinse'),
  rinseStatusText: document.getElementById('rinseStatusText'),
  btnBleFactoryReset: document.getElementById('btnBleFactoryReset'),
  cardDescalingGuide: document.getElementById('cardDescalingGuide'),
  badgeDescalePhase: document.getElementById('badgeDescalePhase'),
  btnBlePrepDescale: document.getElementById('btnBlePrepDescale'),
  descalePrepStatus: document.getElementById('descalePrepStatus'),
  descaleSteps: document.querySelectorAll('#descaleStepsList .descale-step'),
  btnDescalePrevStep: document.getElementById('btnDescalePrevStep'),
  btnDescaleNextStep: document.getElementById('btnDescaleNextStep'),
  btnDescaleResetSteps: document.getElementById('btnDescaleResetSteps'),
  visSlider: document.getElementById('visSlider'),
  visBrewBtn: document.getElementById('visBrewBtn'),
  visMaintLed: document.getElementById('visMaintLed'),
  visBevDial: document.getElementById('visBevDial'),
  visTempDial: document.getElementById('visTempDial'),
  visOutlet: document.getElementById('visOutlet'),
  visTank: document.getElementById('visTank'),
  visTankLabel: document.getElementById('visTankLabel'),
  visStepTitle: document.getElementById('visStepTitle'),
  visBleStateTag: document.getElementById('visBleStateTag'),
  visWhatToDo: document.getElementById('visWhatToDo'),
  visWhatToExpect: document.getElementById('visWhatToExpect'),

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
  postBrewBox: document.getElementById('postBrewBox'),
  postBrewTimerBadge: document.getElementById('postBrewTimerBadge'),
  btnTopUpCoffee: document.getElementById('btnTopUpCoffee'),
  btnTopUpWater: document.getElementById('btnTopUpWater'),
  btnDismissPostBrew: document.getElementById('btnDismissPostBrew'),
  btnStopBrew: document.getElementById('btnStopBrew'),

  // Rename Modal
  renameModal: document.getElementById('renameModal'),
  inputRenameName: document.getElementById('inputRenameName'),
  btnSaveRename: document.getElementById('btnSaveRename'),
  btnCancelRename: document.getElementById('btnCancelRename'),
  btnCloseRename: document.getElementById('btnCloseRename'),

  // Settings & Logs Modals
  btnSettings: document.getElementById('btnSettings'),
  btnManual: document.getElementById('btnManual'),
  btnOpenManualDescale: document.getElementById('btnOpenManualDescale'),
  manualModal: document.getElementById('manualModal'),
  btnCloseManual: document.getElementById('btnCloseManual'),
  btnManualModeReader: document.getElementById('btnManualModeReader'),
  btnManualModePdf: document.getElementById('btnManualModePdf'),
  inputManualSearch: document.getElementById('inputManualSearch'),
  manualJumpChips: document.querySelectorAll('.manual-jump-chip'),
  manualReaderPane: document.getElementById('manualReaderPane'),
  manualSecCards: document.querySelectorAll('#manualReaderPane .manual-sec-card'),
  manualPdfPane: document.getElementById('manualPdfPane'),
  manualPdfFrame: document.getElementById('manualPdfFrame'),
  manualPdfPageTag: document.getElementById('manualPdfPageTag'),
  settingsModal: document.getElementById('settingsModal'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  btnLogoRefresh: document.getElementById('btnLogoRefresh'),
  logoHoldCountdown: document.getElementById('logoHoldCountdown'),
  badgeAppVersion: document.getElementById('badgeAppVersion'),
  initLogEntry: document.getElementById('initLogEntry'),
  inputAuthKey: document.getElementById('inputAuthKey'),
  btnSaveAuthKey: document.getElementById('btnSaveAuthKey'),
  btnPairNewDevice: document.getElementById('btnPairNewDevice'),

  btnLogs: document.getElementById('btnLogs'),
  logsDrawer: document.getElementById('logsDrawer'),
  btnCloseLogs: document.getElementById('btnCloseLogs'),
  btnCopyLogs: document.getElementById('btnCopyLogs'),
  btnClearLogs: document.getElementById('btnClearLogs'),
  logConsole: document.getElementById('logConsole'),
  logCounter: document.getElementById('logCounter'),

  toast: document.getElementById('toast')
};

// 4. Logging & Toast Utilities
const MAX_LOG_ENTRIES = 500;
let logCount = 1;
function log(msg, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `[${time}] ${msg}`;
  el.logConsole.appendChild(div);
  while (el.logConsole.children.length > MAX_LOG_ENTRIES && el.logConsole.firstElementChild) {
    el.logConsole.removeChild(el.logConsole.firstElementChild);
  }
  el.logConsole.scrollTop = el.logConsole.scrollHeight;
  logCount = el.logConsole.children.length;
  el.logCounter.textContent = `${logCount} events`;
  console.log(`[Notpresso:${type.toUpperCase()}] ${msg}`);
}

async function copyLogsToClipboard() {
  if (!el.logConsole) return;
  const text = Array.from(el.logConsole.children || []).map(n => n.textContent).filter(Boolean).join('\n');
  if (!text) {
    showToast('No logs to copy');
    return;
  }
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('Clipboard API unavailable');
    }
    await navigator.clipboard.writeText(text);
    showToast('Logs copied to clipboard');
  } catch (err) {
    showToast(`Copy failed: ${err.message}`);
  }
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
  return '8' + hex32.slice(0, 15).toUpperCase();
}

function generateValidNespressoKeyHex() {
  const rand = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < 8; i++) rand[i] = Math.floor(Math.random() * 256);
  }
  return convertDbHash32ToBleKey16(bytesToHexNoSpaces(rand));
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
let gattQueue = Promise.resolve();
function enqueueGattOp(fn) {
  const next = gattQueue.then(fn, fn);
  gattQueue = next.catch(() => {});
  return next;
}

async function writeBleCharacteristic(uuid, uint8Bytes) {
  return enqueueGattOp(async () => {
    const ch = state.characteristics.get(uuid);
    if (!ch) throw new Error(`Characteristic ${uuid.substring(4, 8)} not available`);
    if (ch.writeValueWithResponse) {
      await ch.writeValueWithResponse(uint8Bytes);
    } else {
      await ch.writeValue(uint8Bytes);
    }
  });
}

async function readBleCharacteristic(uuid) {
  return enqueueGattOp(async () => {
    const ch = state.characteristics.get(uuid);
    if (!ch) throw new Error(`Characteristic ${uuid.substring(4, 8)} not available`);
    const val = await ch.readValue();
    return new Uint8Array(val.buffer);
  });
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
        BLE_UUIDS.SERVICE_ERROR,
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

    // Read initial diagnostics before releasing connect flow
    await readInitialTelemetry();
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
      serviceUuid: BLE_UUIDS.SERVICE_ERROR,
      chars: [BLE_UUIDS.CHAR_ERROR_SELECT, BLE_UUIDS.CHAR_ERROR_INFO]
    },
    {
      serviceUuid: BLE_UUIDS.SERVICE_CUP_SIZE,
      chars: [BLE_UUIDS.CHAR_CUP_TARGET, BLE_UUIDS.CHAR_CUP_VOLUME, BLE_UUIDS.CHAR_USER_SETTINGS]
    },
    {
      serviceUuid: BLE_UUIDS.SERVICE_STOCK,
      chars: [BLE_UUIDS.CHAR_STOCK, BLE_UUIDS.CHAR_STOCK_THRESHOLD]
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
    BLE_UUIDS.CHAR_SCHEDULE,
    BLE_UUIDS.CHAR_STOCK,
    BLE_UUIDS.CHAR_STOCK_THRESHOLD
  ]) {
    try {
      const bytes = await readBleCharacteristic(uuid);
      if (bytes) handleRawCharacteristicBytes(uuid, bytes);
      await sleep(120);
    } catch (_) {}
  }

  if (state.characteristics.has(BLE_UUIDS.CHAR_CUP_TARGET) && state.characteristics.has(BLE_UUIDS.CHAR_CUP_VOLUME)) {
    for (const targetIdx of [0, 1, 2, 3, 4, 5]) {
      try {
        state.lastCupTargetIdx = targetIdx;
        await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_TARGET, new Uint8Array([(targetIdx >> 8) & 0xFF, targetIdx & 0xFF]));
        await sleep(120);
        const volBytes = await readBleCharacteristic(BLE_UUIDS.CHAR_CUP_VOLUME);
        if (volBytes && volBytes.length >= 2) {
          const vol = ((volBytes[0] & 0xFF) << 8) | (volBytes[1] & 0xFF);
          applyMachineCupTargetVolume(targetIdx, vol);
        }
      } catch (_) {}
    }
    state.lastCupTargetIdx = null;
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

function updateCapsuleStockDisplay(stockVal, syncInput = false) {
  state.capsuleStock = stockVal;
  if (el.valStockCounter) {
    if (stockVal === null) {
      el.valStockCounter.textContent = 'Disabled';
    } else {
      el.valStockCounter.textContent = stockVal === 0 ? '0 caps (LED ON)' : `${stockVal} caps`;
    }
  }
  if (syncInput && stockVal !== null && el.inputStockCount) {
    el.inputStockCount.value = stockVal;
  }
}

function parseStockThresholdBytes(bytes) {
  if (!bytes || bytes.length < 2) return null;
  return ((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF);
}

function parseFaultRecordBytes(bytes, slotIdx = 0) {
  if (!bytes || bytes.length < 2) return null;
  const errNum = bytes[0] & 0xFF;
  const errCat = (bytes[1] >> 4) & 0x0F;
  const errSub = bytes.length >= 3 ? (bytes[2] & 0xFF) : 0;
  const category = ERROR_CATEGORIES[errCat] || `CAT_${errCat}`;
  const isEmpty = errNum === 0 && errCat === 0;
  const summary = isEmpty
    ? `Slot ${slotIdx}: None (OK)`
    : `Slot ${slotIdx}: #${errNum} ${category} (sub 0x${errSub.toString(16).padStart(2, '0')})`;
  return { slot: slotIdx, errNum, errCat, category, errSub, isEmpty, summary };
}

const MACHINE_DIAL_STORAGE_KEY = 'notpresso_machine_dial_v2';
const DIAL_COFFEE_DRINK_MAP = { 0: 'ristretto', 1: 'espresso', 2: 'lungo', 3: 'americano' };
const DIAL_COFFEE_CHIP_LABELS = { 0: 'Ristretto', 1: 'Espresso', 2: 'Lungo' };

function syncCupTargetOptionUI(targetIdx, volMl) {
  if (!el.selectCupTarget) return;
  const opt = Array.from(el.selectCupTarget.options || []).find(o => parseInt(o.value, 10) === targetIdx);
  if (!opt) return;
  opt.dataset.def = String(volMl);
  if (opt.textContent) {
    opt.textContent = opt.textContent.replace(/Default \d+ml/, `Default ${volMl}ml`);
  }
}

function loadMachineDialVolumes() {
  try {
    const raw = localStorage.getItem(MACHINE_DIAL_STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return false;
    let loadedAny = false;
    for (let i = 0; i <= 5; i += 1) {
      if (typeof saved[i] === 'number') {
        applyMachineCupTargetVolume(i, saved[i], false);
        loadedAny = true;
      }
    }
    return loadedAny;
  } catch (_) {
    return false;
  }
}

function applyMachineCupTargetVolume(targetIdx, volMl, persist = true) {
  if (typeof volMl !== 'number' || Number.isNaN(volMl) || volMl < 10 || volMl > 500) return;
  if (state.machineDialVolumes) state.machineDialVolumes[targetIdx] = volMl;
  if (persist && state.machineDialVolumes) {
    try { localStorage.setItem(MACHINE_DIAL_STORAGE_KEY, JSON.stringify(state.machineDialVolumes)); } catch (_) {}
  }

  syncCupTargetOptionUI(targetIdx, volMl);
  if (el.selectCupTarget && parseInt(el.selectCupTarget.value, 10) === targetIdx) {
    updateCupRangeHint();
  }
  syncDialProfileChipUI();

  if (DIAL_COFFEE_CHIP_LABELS[targetIdx] && typeof document !== 'undefined') {
    const chip = document.querySelector(`.chip-btn[data-dial-target="${targetIdx}"]`);
    if (chip) {
      chip.dataset.coffee = String(volMl);
      chip.textContent = `${volMl}ml (${DIAL_COFFEE_CHIP_LABELS[targetIdx]})`;
    }
  }

  let updatedDrink = null;
  const coffeeDrink = DIAL_COFFEE_DRINK_MAP[targetIdx];
  if (coffeeDrink && volMl >= 15 && volMl <= 130) {
    PRESET_DRINK_DEFAULTS[coffeeDrink].coffeeMl = volMl;
    if (state.presetTweaks && state.presetTweaks[coffeeDrink]) {
      state.presetTweaks[coffeeDrink].coffeeMl = volMl;
    }
    updatedDrink = coffeeDrink;
  } else if (targetIdx === 4 && volMl >= 25 && volMl <= 300) {
    PRESET_DRINK_DEFAULTS.americano.waterMl = volMl;
    if (state.presetTweaks && state.presetTweaks.americano) {
      state.presetTweaks.americano.waterMl = volMl;
    }
    updatedDrink = 'americano';
  }

  Array.from(el.presetDrinkCards || []).forEach(card => {
    const key = card.dataset && card.dataset.drink;
    if (!key) return;
    if (updatedDrink === 'americano' && key === 'americano') {
      const volLabel = card.querySelector('.drink-vol');
      if (volLabel) {
        volLabel.textContent = `Rotary Dial Preset (${PRESET_DRINK_DEFAULTS.americano.coffeeMl}ml + ${PRESET_DRINK_DEFAULTS.americano.waterMl}ml)`;
      }
    }
    syncPresetCardUI(card, key);
  });
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
    const capsuleStockLow = bytes.length >= 4 ? getBitBoolean(bytes, 16) : false;

    const prevState = state.machineState;
    state.machineState = stateCode;
    state.waterTankEmpty = waterTankEmpty;
    state.capsuleContainerFull = capsuleContainerFull;
    state.descalingNeeded = descalingNeeded;
    state.errorPresent = errorPresent;
    state.capsuleStockLow = capsuleStockLow;

    if (bytes.length >= 4) {
      const stockCount = selectBit(bytes, 17, 26);
      const schedActive = getBitBoolean(bytes, 27);
      updateCapsuleStockDisplay(stockCount < 1023 ? stockCount : null, false);
      if (!schedActive) {
        el.badgeScheduleStatus.textContent = 'Idle';
      } else if (!el.badgeScheduleStatus.textContent.startsWith('In ')) {
        el.badgeScheduleStatus.textContent = 'Timer Active';
      }
    }
    if (bytes.length >= 6) {
      const sliderOpen = !getBitBoolean(bytes, 46);
      const obstacleDetected = getBitBoolean(bytes, 47);
      state.sliderOpen = sliderOpen;
      state.obstacleDetected = obstacleDetected;
      el.chipSliderState.textContent = sliderOpen ? 'Open' : 'Closed';
    }

    el.valDescaleStatus.textContent = descalingNeeded ? 'Descale Needed!' : 'OK';

    const warnings = [];
    if (waterTankEmpty) warnings.push('Water Empty');
    if (capsuleContainerFull) warnings.push('Bin Full');
    if (descalingNeeded) warnings.push('Descale');
    if (errorPresent) warnings.push('Error');
    if (state.obstacleDetected) warnings.push('Obstacle');

    const mState = MACHINE_STATES[stateCode] || { label: `State ${stateCode}`, isBusy: false };
    const statusLabel = warnings.length > 0 ? `${mState.label} (${warnings.join(', ')})` : mState.label;
    el.chipMachineState.textContent = statusLabel;
    el.chipPairingState.textContent = pairingState === 2
      ? (state.capsuleStock !== null && state.capsuleStock < 1023 ? `Auth OK • ${state.capsuleStock}` : 'Auth OK (2)')
      : `Unpaired (${pairingState})`;

    updateLedTelematicsBanner({
      stateCode,
      descalingNeeded,
      waterTankEmpty,
      capsuleContainerFull,
      sliderOpen: state.sliderOpen,
      capsuleStockLow,
      errorPresent,
      obstacleDetected: state.obstacleDetected
    });
    syncDescaleStepFromTelemetry(prevState, stateCode, waterTankEmpty, descalingNeeded);

    log(`[06aa3a12 Status] ${bytesToHex(bytes)} -> ${statusLabel}`, 'rx');

    // Handle active multi-stage workflows on state transitions!
    handleWorkflowStatusUpdate(prevState, stateCode, waterTankEmpty);

  } else if (uuid === BLE_UUIDS.CHAR_SLIDER) {
    const isOpen = bytes[0] === 0x00;
    state.sliderOpen = isOpen;
    el.chipSliderState.textContent = isOpen ? 'Open' : 'Closed';
    updateLedTelematicsBanner({
      stateCode: state.machineState,
      descalingNeeded: state.descalingNeeded,
      waterTankEmpty: state.waterTankEmpty,
      capsuleContainerFull: state.capsuleContainerFull,
      sliderOpen: state.sliderOpen,
      capsuleStockLow: state.capsuleStockLow,
      errorPresent: state.errorPresent,
      obstacleDetected: state.obstacleDetected
    });
    updateDescaleGuideUI();
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
      state.waterHardnessLevel = hardness;
      el.selectWaterHardness.value = String(hardness);
    }
    log(`[06aa3a44 UserSettings] Standby=${standbySec}s (${Math.round(standbySec / 60)}m), WaterHardness=Level ${hardness}`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_CUP_VOLUME && bytes.length >= 2) {
    const vol = ((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF);
    if (vol >= 10 && vol <= 500) {
      const targetIdx = state.lastCupTargetIdx !== null && state.lastCupTargetIdx !== undefined
        ? state.lastCupTargetIdx
        : parseInt(el.selectCupTarget.value, 10);
      applyMachineCupTargetVolume(targetIdx, vol);
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

  } else if (uuid === BLE_UUIDS.CHAR_STOCK && bytes.length >= 2) {
    // CapsuleStock (06aa3a15): 2B BE uint16 (0..1000 active, 0xFFFF disabled)
    const rawStock = ((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF);
    const stockVal = (rawStock === 0xFFFF || rawStock > 1000) ? null : rawStock;
    updateCapsuleStockDisplay(stockVal, true);
    log(`[06aa3a15 CapsuleStock] ${stockVal === null ? 'DISABLED (0xFFFF)' : `${stockVal} capsules`}`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_STOCK_THRESHOLD && bytes.length >= 2) {
    const thresh = parseStockThresholdBytes(bytes);
    state.capsuleStockThreshold = thresh;
    if (el.valStockThreshold) el.valStockThreshold.textContent = `${thresh} caps`;
    if (el.inputStockThreshold && thresh <= 1000) el.inputStockThreshold.value = thresh;
    log(`[06aa3a25 StockThreshold] ${thresh} capsules (${bytesToHex(bytes)})`, 'rx');

  } else if (uuid === BLE_UUIDS.CHAR_ERROR_INFO && bytes.length >= 2) {
    const rec = parseFaultRecordBytes(bytes, state.selectedErrorSlot);
    state.lastErrorRecord = rec;
    if (el.valFaultRecord && rec) el.valFaultRecord.textContent = rec.summary;
    log(`[06aa3a23 ErrorInfo] ${rec ? rec.summary : '--'} (${bytesToHex(bytes)})`, 'rx');
  }
}

function decodeCommandResponse(bytes) {
  const hex = bytesToHex(bytes);
  // Check both 20-byte SDK layout (bytes[3]=code, bytes[4]=subcode) and 4-byte layout (bytes[2]=code, bytes[3]=subcode)
  let respCode = bytes.length >= 5 ? bytes[3] : (bytes.length >= 4 ? bytes[2] : bytes[0]);
  let subCode = bytes.length >= 5 ? bytes[4] : (bytes.length >= 4 ? bytes[3] : 0);

  const rejectCommand = (reason) => {
    log(`[06aa3a52 Command Rejected] ${reason} (${hex})`, 'err');
    const wasRinse = !!(state.activeWorkflow && state.activeWorkflow.type === 'system-rinse');
    state.activeWorkflow = null;
    clearInterval(state.soakInterval);
    el.soakControlBox.classList.add('hidden');
    finishBrewTracking({ immediate: true });
    el.brewModal.classList.add('hidden');
    if (wasRinse) {
      updateSystemRinseUI('Idle (5 Shots)', 'Ready to run automated 5-shot purge: Shots 1–3 Lungo (coffee outlet) → Shots 4–5 Hot Water (dedicated water spout).', false);
    }
    if (el.ledTelematicsBanner) {
      el.ledTelematicsBanner.classList.remove('hidden', 'led-state-warn');
      el.ledTelematicsBanner.classList.add('led-state-err');
      el.ledBannerDot.className = 'led-dot led-err led-blink';
      el.ledBannerTitle.textContent = 'Brew Command Rejected by Machine';
      el.ledBannerDesc.textContent = reason;
    }
    showToast(reason);
  };

  if (respCode === 0x20 || (bytes[0] & 0xF0) === 0x80) {
    log(`[06aa3a52 CommandResponse] ACK / DONE (${hex})`, 'rx');
  } else if (respCode === 0x36) {
    rejectCommand('Command rejected: Volume out of hardware range (0x36).');
  } else if (respCode === 0x24 || (bytes[0] & 0xC0) === 0xC0) {
    const reason = CONDITION_NOT_FULFILLED_REASONS[subCode] || `Condition not fulfilled (0x24, subcode 0x${subCode.toString(16)})`;
    rejectCommand(reason);
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
  state.isBrewing = false;
  state.activeWorkflow = null;
  clearInterval(state.brewInterval);
  clearInterval(state.soakInterval);
  dismissPostBrewModal();
  if (el.soakControlBox) el.soakControlBox.classList.add('hidden');
  if (el.brewModal) el.brewModal.classList.add('hidden');
  updateSystemRinseUI('Idle (5 Shots)', 'Ready to run automated 5-shot purge: Shots 1–3 Lungo (coffee outlet) → Shots 4–5 Hot Water (dedicated water spout).', false);
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
    if (el.ledTelematicsBanner) el.ledTelematicsBanner.classList.add('hidden');
  } else {
    el.connDot.className = 'status-dot disconnected';
    el.connStatusText.textContent = 'Disconnected';
    el.deviceSubtext.textContent = 'Tap Connect to scan for Expert EN 350.G';
    el.btnConnect.className = 'btn btn-connect';
    el.btnConnectText.textContent = 'Connect';
    el.telemetryRow.classList.add('hidden');
    if (el.ledTelematicsBanner) el.ledTelematicsBanner.classList.add('hidden');
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
  state.lastBrewTemp = tempCode & 0xFF;
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
  state.lastBrewTemp = tempCode & 0xFF;
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
  const singleTemp = options.temp !== undefined ? options.temp : state.customTemp;
  const coffeeTemp = options.coffeeTemp !== undefined ? options.coffeeTemp : state.customCoffeeTemp;
  const waterTemp = options.waterTemp !== undefined ? options.waterTemp : state.customWaterTemp;
  const splitTemp = options.splitTemp !== undefined ? options.splitTemp : (coffeeTemp !== waterTemp);

  // If only 1 ingredient is > 0 or both temperatures are identical, run native 1-command recipe:
  if (!splitTemp || coffeeMl === 0 || waterMl === 0 || coffeeTemp === waterTemp) {
    state.activeWorkflow = null;
    const effectiveTemp = coffeeMl === 0
      ? waterTemp
      : (options.splitTemp === false && options.temp !== undefined ? singleTemp : coffeeTemp);
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

  const flushMl = wf.type === 'water-pause-soak'
    ? Math.max(15, wf.phase2Ml - wf.phase1Ml)
    : wf.phase2Ml;

  try {
    log(`Triggering Phase 2 Extraction (${flushMl} ml @ ${getTempLabel(wf.tempCode)})...`, 'tx');
    state.activeWorkflow = null;
    await sendSingleStageCustomBrew(
      flushMl,
      0,
      wf.tempCode,
      'coffee-first',
      `Phase 2: Extracting ${flushMl} ml (${getTempLabel(wf.tempCode)})`
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

  // 3. If 2-Stage Bloom/Clean Macro finished Stage 1 (transitioned from BREWING/HEAT_UP to READY=2):
  if (wf && wf.type === 'two-stage-bloom' && wf.stage === 1 && !wf.soakStarted) {
    if ((prevState === 4 || prevState === 1) && newState === 2) {
      log(`Phase 1 complete. Starting ${wf.waitSec}s soak/bloom countdown...`, 'info');
      beginSoakCountdown(wf.waitSec, 300);
      return;
    }
  }

  // 4. If 5-Shot System Rinse finished current step (transitioned from BREWING/HEAT_UP back to READY=2):
  if (wf && wf.type === 'system-rinse' && !wf.advancing) {
    if ((prevState === 4 || prevState === 1) && newState === 2) {
      await advanceOrFinishSystemRinse(wf);
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
  const wasRinse = !!(state.activeWorkflow && state.activeWorkflow.type === 'system-rinse');
  state.activeWorkflow = null;
  clearInterval(state.soakInterval);
  el.soakControlBox.classList.add('hidden');

  const stopPayload = new Uint8Array([0x03, 0x06, 0x01, 0x02]);
  log(`Sending Abort Action (03 06 01 02): ${bytesToHex(stopPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, stopPayload);
    finishBrewTracking({ immediate: true });
    el.badgeScheduleStatus.textContent = 'Idle';
    if (wasRinse) {
      updateSystemRinseUI('Idle (5 Shots)', 'Ready to run automated 5-shot purge: Shots 1–3 Lungo (coffee outlet) → Shots 4–5 Hot Water (dedicated water spout).', false);
    }
    showToast('Action cancelled.');
  } catch (err) {
    log(`Cancel error: ${err.message}`, 'err');
  }
}

function updateSystemRinseUI(badgeText, detailText, isRunning) {
  if (el.badgeRinseStatus) el.badgeRinseStatus.textContent = badgeText;
  if (el.rinseStatusText) el.rinseStatusText.textContent = detailText;
  if (el.btnStartSystemRinse) el.btnStartSystemRinse.disabled = !!isRunning;
  if (el.btnStopSystemRinse) el.btnStopSystemRinse.disabled = !isRunning;
}

async function startSystemRinseWorkflow() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  if (state.sliderOpen) {
    showToast('Close the capsule slider (with no capsule inside) before rinsing!');
    return;
  }
  state.activeWorkflow = {
    type: 'system-rinse',
    stepIndex: 0,
    totalSteps: SYSTEM_RINSE_STEPS.length,
    advancing: false
  };
  log('Starting First-Use / Post-Weekend 5-Shot System Rinse (3x Lungo + 2x Hot Water)...', 'info');
  await executeCurrentSystemRinseStep();
}

async function executeCurrentSystemRinseStep() {
  const wf = state.activeWorkflow;
  if (!wf || wf.type !== 'system-rinse') return;
  const s = SYSTEM_RINSE_STEPS[wf.stepIndex];
  if (!s) return;
  wf.advancing = false;
  updateSystemRinseUI(`Step ${s.step} / ${wf.totalSteps}`, `Running ${s.label}...`, true);
  const payload = buildProgrammedBrewPayload(s.sizeCode, s.tempCode, 0);
  log(`System Rinse [${s.step}/${wf.totalSteps}] ${s.label}: ${bytesToHex(payload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, payload);
    startBrewTracking(`System Rinse (${s.step}/${wf.totalSteps})`, s.label, calculateBrewDuration(s.sizeCode));
  } catch (err) {
    log(`System rinse error at step ${s.step}: ${err.message}`, 'err');
    state.activeWorkflow = null;
    updateSystemRinseUI('Error', `System rinse halted at step ${s.step}: ${err.message}`, false);
    showToast(`System rinse error: ${err.message}`);
  }
}

async function advanceOrFinishSystemRinse(wf) {
  if (!wf || wf.type !== 'system-rinse' || wf.advancing) return;
  if (wf.stepIndex + 1 < SYSTEM_RINSE_STEPS.length) {
    wf.advancing = true;
    wf.stepIndex += 1;
    log(`System Rinse step complete. Advancing to shot ${wf.stepIndex + 1}/${wf.totalSteps}...`, 'info');
    await sleep(400);
    await executeCurrentSystemRinseStep();
    return;
  }
  state.activeWorkflow = null;
  finishBrewTracking({ immediate: true });
  updateSystemRinseUI('Complete ✓', '5-shot System Rinse complete (3x Lungo + 2x Hot Water)! Empty drip tray & capsule bin.', false);
  log('5-Shot System Rinse finished (3x Lungo + 2x Hot Water).', 'info');
  showToast('5-Shot System Rinse complete! Empty drip tray.');
}

async function stopSystemRinseWorkflow() {
  await emergencyStop();
  updateSystemRinseUI('Stopped', 'System rinse cancelled by user.', false);
}

async function readDialCupSize() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const targetIdx = parseInt(el.selectCupTarget.value, 10);
  state.lastCupTargetIdx = targetIdx;
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
  state.lastCupTargetIdx = targetIdx;
  const volMl = parseInt(el.inputCupVolume.value, 10);
  const targetPayload = new Uint8Array([(targetIdx >> 8) & 0xFF, targetIdx & 0xFF]);
  const volPayload = new Uint8Array([(volMl >> 8) & 0xFF, volMl & 0xFF, 0xFF, 0xFF]);

  log(`Programming Dial Target ${targetIdx} -> ${volMl} ml: ${bytesToHex(volPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_TARGET, targetPayload);
    await sleep(200);
    await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_VOLUME, volPayload);
    applyMachineCupTargetVolume(targetIdx, volMl);
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

async function readCapsuleStock() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  try {
    const bytes = await readBleCharacteristic(BLE_UUIDS.CHAR_STOCK);
    if (bytes) {
      handleRawCharacteristicBytes(BLE_UUIDS.CHAR_STOCK, bytes);
      showToast(state.capsuleStock === null
        ? 'Capsule stock tracking is disabled (0xFFFF)'
        : `Capsule stock: ${state.capsuleStock} capsules`);
    }
  } catch (err) {
    log(`Read 06aa3a15 error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function writeCapsuleStock() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const parsed = parseInt(el.inputStockCount ? el.inputStockCount.value : '0', 10);
  const count = Math.max(0, Math.min(1000, Number.isNaN(parsed) ? 0 : parsed));
  if (el.inputStockCount) el.inputStockCount.value = count;
  const payload = new Uint8Array([(count >> 8) & 0xFF, count & 0xFF]);
  log(`Writing Capsule Stock (${count}) to 06aa3a15: ${bytesToHex(payload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_STOCK, payload);
    updateCapsuleStockDisplay(count, false);
    showToast(count === 0
      ? 'Capsule stock set to 0 (Nespresso LED ON)!'
      : `Capsule stock set to ${count}!`);
  } catch (err) {
    log(`Write 06aa3a15 error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function disableCapsuleStock() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const payload = new Uint8Array([0xFF, 0xFF]);
  log(`Disabling Capsule Stock (0xFFFF) on 06aa3a15: ${bytesToHex(payload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_STOCK, payload);
    updateCapsuleStockDisplay(null, false);
    showToast('Capsule stock tracking disabled (0xFFFF)!');
  } catch (err) {
    log(`Disable 06aa3a15 error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function readStockThreshold() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  try {
    const bytes = await readBleCharacteristic(BLE_UUIDS.CHAR_STOCK_THRESHOLD);
    if (bytes) {
      handleRawCharacteristicBytes(BLE_UUIDS.CHAR_STOCK_THRESHOLD, bytes);
      showToast(`Low-stock threshold: ${state.capsuleStockThreshold} capsules`);
    }
  } catch (err) {
    log(`Read 06aa3a25 error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function writeStockThreshold() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const parsed = parseInt(el.inputStockThreshold ? el.inputStockThreshold.value : '10', 10);
  const thresh = Math.max(0, Math.min(1000, Number.isNaN(parsed) ? 10 : parsed));
  if (el.inputStockThreshold) el.inputStockThreshold.value = thresh;
  const payload = new Uint8Array([(thresh >> 8) & 0xFF, thresh & 0xFF]);
  log(`Writing Low-Stock Threshold (${thresh}) to 06aa3a25: ${bytesToHex(payload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_STOCK_THRESHOLD, payload);
    state.capsuleStockThreshold = thresh;
    if (el.valStockThreshold) el.valStockThreshold.textContent = `${thresh} caps`;
    showToast(`Low-stock warning threshold set to ${thresh}!`);
  } catch (err) {
    log(`Write 06aa3a25 error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function readErrorLogSlot() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const parsed = parseInt(el.selectErrorSlot ? el.selectErrorSlot.value : '0', 10);
  const slot = Math.max(0, Math.min(9, Number.isNaN(parsed) ? 0 : parsed));
  state.selectedErrorSlot = slot;
  const selPayload = new Uint8Array([slot & 0xFF]);
  log(`Selecting Fault History slot ${slot} on 06aa3a13: ${bytesToHex(selPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_ERROR_SELECT, selPayload);
    await sleep(80);
    const bytes = await readBleCharacteristic(BLE_UUIDS.CHAR_ERROR_INFO);
    if (bytes) {
      handleRawCharacteristicBytes(BLE_UUIDS.CHAR_ERROR_INFO, bytes);
      showToast(state.lastErrorRecord ? state.lastErrorRecord.summary : `Read fault slot ${slot}`);
    }
  } catch (err) {
    log(`Read fault history 06aa1930 error: ${err.message}`, 'err');
    showToast(`Fault log error: ${err.message}`);
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
  clearInterval(state.postBrewInterval);
  state.postBrewRemainingSec = 0;

  el.brewCupGraphic.textContent = '☕';
  el.brewModalTitle.textContent = title;
  el.brewModalSub.textContent = subtitle || 'Machine is running. Please keep cup under outlet...';
  el.brewModal.classList.remove('hidden');
  el.brewProgressBar.style.width = '0%';
  if (el.postBrewBox) el.postBrewBox.classList.add('hidden');
  if (el.btnStopBrew) el.btnStopBrew.classList.remove('hidden');

  if (!state.activeWorkflow || state.activeWorkflow.type === 'two-stage-split' || state.activeWorkflow.type === 'system-rinse') {
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

    const isMachineBusy = !!(MACHINE_STATES[state.machineState] && MACHINE_STATES[state.machineState].isBusy);
    const fallbackSec = wf ? state.brewDurationSec + 35 : state.brewDurationSec;
    if (!isMachineBusy && elapsedSec >= fallbackSec) {
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
      if (wf && wf.type === 'system-rinse' && !wf.advancing) {
        await advanceOrFinishSystemRinse(wf);
        return;
      }
      if (!wf || !wf.soakStarted) {
        finishBrewTracking();
      }
    }
  }, 250);
}

function dismissPostBrewModal() {
  clearInterval(state.postBrewInterval);
  state.postBrewRemainingSec = 0;
  if (el.postBrewBox) el.postBrewBox.classList.add('hidden');
  if (el.btnStopBrew) el.btnStopBrew.classList.remove('hidden');
  if (el.brewModal) el.brewModal.classList.add('hidden');
}

async function triggerPostBrewTopUp(kind) {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  clearInterval(state.postBrewInterval);
  state.postBrewRemainingSec = 0;
  if (el.postBrewBox) el.postBrewBox.classList.add('hidden');
  if (el.btnStopBrew) el.btnStopBrew.classList.remove('hidden');

  const temp = state.lastBrewTemp ?? 0;
  try {
    if (kind === 'water') {
      await sendSingleStageCustomBrew(0, 25, temp, 'coffee-first', `Top-Up: +25 ml Hot Water (${getTempLabel(temp)})`);
    } else {
      await sendSingleStageCustomBrew(15, 0, temp, 'coffee-first', `Top-Up: +15 ml Coffee (${getTempLabel(temp)})`);
    }
  } catch (err) {
    log(`Top-up error: ${err.message}`, 'err');
    showToast(`Top-up error: ${err.message}`);
  }
}

function finishBrewTracking({ immediate = false } = {}) {
  state.isBrewing = false;
  clearInterval(state.brewInterval);
  clearInterval(state.postBrewInterval);
  el.brewProgressBar.style.width = '100%';

  if (immediate || state.activeWorkflow || state.errorPresent || state.machineState === 6 || state.machineState === 8) {
    state.postBrewRemainingSec = 0;
    setTimeout(() => {
      if (!state.activeWorkflow && state.postBrewRemainingSec === 0) {
        dismissPostBrewModal();
      }
    }, 600);
    return;
  }

  // Show 10-second pre-eject countdown & top-up controls (Manual p. 11)
  state.postBrewRemainingSec = 10;
  if (el.brewCupGraphic) el.brewCupGraphic.textContent = '✨';
  if (el.brewModalTitle) el.brewModalTitle.textContent = 'Brew Complete — Auto-Eject in 10s';
  if (el.brewModalSub) {
    el.brewModalSub.textContent = `Temperature locked at ${getTempLabel(state.lastBrewTemp)} (Manual p. 11). Top up before capsule ejects:`;
  }
  if (el.soakControlBox) el.soakControlBox.classList.add('hidden');
  if (el.btnStopBrew) el.btnStopBrew.classList.add('hidden');
  if (el.postBrewBox) el.postBrewBox.classList.remove('hidden');
  if (el.postBrewTimerBadge) el.postBrewTimerBadge.textContent = '10s';
  if (el.brewModal) el.brewModal.classList.remove('hidden');

  state.postBrewInterval = setInterval(() => {
    state.postBrewRemainingSec = Math.max(0, state.postBrewRemainingSec - 1);
    if (el.postBrewTimerBadge) el.postBrewTimerBadge.textContent = `${state.postBrewRemainingSec}s`;
    if (el.brewModalTitle) el.brewModalTitle.textContent = `Brew Complete — Auto-Eject in ${state.postBrewRemainingSec}s`;
    if (el.brewProgressBar) el.brewProgressBar.style.width = `${state.postBrewRemainingSec * 10}%`;
    if (state.postBrewRemainingSec <= 0) {
      dismissPostBrewModal();
    }
  }, 1000);
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

  const isSplit = coffee > 0 && water > 0 && state.customCoffeeTemp !== state.customWaterTemp;
  state.customSplitTemp = isSplit;
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
  const clamped = Math.max(min, Math.min(max, def));
  el.inputCupVolume.value = clamped;
  el.valCupTargetMl.textContent = `${clamped} ml`;
  el.hintCupRange.textContent = `Hardware allowed range: ${min} ml – ${max} ml (Default: ${def} ml)`;
}

// 14. Saved Library & Favorites UI
function getRecipeTempKey(recipe, fallbackIdx = '') {
  return recipe && recipe.id ? recipe.id : `idx-${fallbackIdx}`;
}

function getEffectiveRecipeTempMode(recipe, fallbackIdx = '') {
  const key = getRecipeTempKey(recipe, fallbackIdx);
  const ov = state.recipeTempOverrides && state.recipeTempOverrides[key];
  if (ov === 0 || ov === 1 || ov === 2) return ov;
  if (ov === 'split' && recipe.splitTemp) return 'split';
  return recipe.splitTemp ? 'split' : (recipe.temp !== undefined ? recipe.temp : 0);
}

function getRecipeDetailText(recipe, { includeTotal = true, compactSeq = true, fallbackIdx = '' } = {}) {
  const mode = getEffectiveRecipeTempMode(recipe, fallbackIdx);
  const tempDesc = mode === 'split'
    ? `Split: ☕${getTempLabel(recipe.coffeeTemp)} / 💧${getTempLabel(recipe.waterTemp)}`
    : getTempLabel(mode);

  if (recipe.kind === 'bloom') {
    const totalMl = (recipe.phase1Ml || 0) + (recipe.phase2Ml || 0);
    const totalPart = includeTotal ? ` (${totalMl}ml)` : '';
    return `${recipe.phase1Ml}ml Phase 1 → ${recipe.waitSec}s Soak → ${recipe.phase2Ml}ml Phase 2${totalPart} • ${tempDesc}`;
  }

  const totalMl = (recipe.coffeeMl || 0) + (recipe.waterMl || 0);
  const seqLabel = compactSeq
    ? (recipe.seq === 'water-first' ? 'Water→Coffee' : 'Coffee→Water')
    : (recipe.seq === 'water-first' ? 'Water first' : 'Coffee first');
  const totalPart = includeTotal ? ` (${totalMl}ml)` : '';
  return `${recipe.coffeeMl}ml coffee + ${recipe.waterMl}ml water${totalPart} • ${tempDesc} • ${seqLabel}`;
}

function renderRecipeTempPillsHtml(recipe, fallbackIdx = '') {
  const key = escapeHtml(getRecipeTempKey(recipe, fallbackIdx));
  const mode = getEffectiveRecipeTempMode(recipe, fallbackIdx);
  const options = [
    { mode: 1, label: '80°', title: 'Warm ~80°C (Low)' },
    { mode: 0, label: '85°', title: 'Hot ~85°C (Medium)' },
    { mode: 2, label: '90°', title: 'Max ~90°C (High)' }
  ];
  if (recipe.splitTemp) {
    options.push({ mode: 'split', label: 'Split', title: 'Saved Split Temperature' });
  }
  const buttons = options.map(opt => {
    const isActive = mode === opt.mode;
    return `<button type="button" class="recipe-temp-pill${isActive ? ' active' : ''}" data-recipe-key="${key}" data-temp-mode="${opt.mode}" title="${opt.title}" aria-pressed="${isActive}">${opt.label}</button>`;
  }).join('');
  return `<div class="recipe-temp-pills" role="group" aria-label="Per-cup temperature">${buttons}</div>`;
}

function bindSavedRecipeCardActions(container) {
  if (!container || (container.dataset && container.dataset.actionsBound === '1')) return;
  if (container.dataset) container.dataset.actionsBound = '1';

  container.addEventListener('click', (e) => {
    const tempPill = e.target.closest('.recipe-temp-pill');
    if (tempPill) {
      e.stopPropagation();
      const key = tempPill.dataset.recipeKey;
      const rawMode = tempPill.dataset.tempMode;
      state.recipeTempOverrides[key] = rawMode === 'split' ? 'split' : parseInt(rawMode, 10);
      renderLibrary();
      renderFavoritesOnHome();
      return;
    }

    const renameBtn = e.target.closest('.btn-inline-rename');
    if (renameBtn) {
      e.stopPropagation();
      openRenameModal(parseInt(renameBtn.dataset.idx, 10));
      return;
    }

    const brewBtn = e.target.closest('.btn-brew-saved, .btn-home-fav-brew');
    if (brewBtn) {
      executeSavedRecipe(parseInt(brewBtn.dataset.idx, 10));
      return;
    }

    const editBtn = e.target.closest('.btn-edit-saved, .btn-home-fav-edit');
    if (editBtn) {
      editRecipeInCustomTab(parseInt(editBtn.dataset.idx, 10));
      return;
    }

    const delBtn = e.target.closest('.btn-del-saved');
    if (delBtn) {
      const idx = parseInt(delBtn.dataset.idx, 10);
      const r = state.savedRecipes[idx];
      if (r && confirm(`Delete "${r.name}" from library?`)) {
        delete state.recipeTempOverrides[getRecipeTempKey(r, idx)];
        state.savedRecipes.splice(idx, 1);
        persistSavedRecipes();
        renderLibrary();
        renderFavoritesOnHome();
        showToast('Recipe deleted');
      }
    }
  });
}

function executeSavedRecipe(idx) {
  const r = state.savedRecipes[idx];
  if (!r) return;
  const mode = getEffectiveRecipeTempMode(r, idx);
  if (r.kind === 'bloom') {
    const tempCode = (mode === 0 || mode === 1 || mode === 2) ? mode : (r.temp !== undefined ? r.temp : 0);
    return startWaterPauseSoakWorkflow(r.phase1Ml, r.waitSec, r.phase2Ml, tempCode);
  }
  if (mode === 0 || mode === 1 || mode === 2) {
    return brewCustomRecipe(r.coffeeMl, r.waterMl, {
      ...r,
      splitTemp: false,
      temp: mode,
      coffeeTemp: mode,
      waterTemp: mode
    });
  }
  return brewCustomRecipe(r.coffeeMl, r.waterMl, r);
}

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
    item.dataset.idx = String(idx);

    const details = getRecipeDetailText(recipe, { includeTotal: true, compactSeq: true, fallbackIdx: idx });

    item.innerHTML = `
      <div class="recipe-drag-handle" title="Hold and drag to reorder" aria-label="Hold and drag to reorder">⋮⋮</div>
      <div class="recipe-info-col">
        <div class="recipe-name-row">
          <span class="recipe-meta-name">${escapeHtml(recipe.name)}</span>
          <button class="btn-inline-rename" data-idx="${idx}" title="Rename">✏️</button>
        </div>
        <div class="recipe-meta-details">${escapeHtml(details)}</div>
      </div>
      <div class="recipe-actions">
        ${renderRecipeTempPillsHtml(recipe, idx)}
        <button class="btn btn-connect btn-brew-saved" data-idx="${idx}">Brew</button>
        <button class="icon-btn btn-edit-saved" data-idx="${idx}" title="Edit / Tweak in Custom Tab">🎛️</button>
        <button class="icon-btn btn-del-saved" data-idx="${idx}" title="Delete">🗑️</button>
      </div>
    `;
    el.libraryList.appendChild(item);
  });

  // Delegated card actions & long-press drag reordering
  bindSavedRecipeCardActions(el.libraryList);
  bindLongPressReorder(el.libraryList, '.recipe-item');
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
    card.dataset.idx = String(idx);

    const totalMl = recipe.kind === 'bloom'
      ? (recipe.phase1Ml || 0) + (recipe.phase2Ml || 0)
      : (recipe.coffeeMl || 0) + (recipe.waterMl || 0);
    const desc = getRecipeDetailText(recipe, { includeTotal: false, compactSeq: false, fallbackIdx: idx });

    card.innerHTML = `
      <div class="recipe-drag-handle" title="Hold and drag to reorder" aria-label="Hold and drag to reorder">⋮⋮</div>
      <div class="home-fav-info">
        <div class="home-fav-top">
          <span class="home-fav-name">${escapeHtml(recipe.name)}</span>
          <span class="home-fav-vol">${totalMl} ml</span>
        </div>
        <div class="home-fav-desc">${escapeHtml(desc)}</div>
      </div>
      <div class="home-fav-actions">
        ${renderRecipeTempPillsHtml(recipe, idx)}
        <button class="btn btn-connect btn-home-fav-brew" data-idx="${idx}" style="padding:6px 14px; font-size:12px;">Brew</button>
        <button class="icon-btn btn-home-fav-edit" data-idx="${idx}" title="Edit in Custom Tab">🎛️</button>
      </div>
    `;
    el.homeFavoritesList.appendChild(card);
  });

  bindSavedRecipeCardActions(el.homeFavoritesList);
  bindLongPressReorder(el.homeFavoritesList, '.home-favorite-card');
}

function moveRecipeFromTo(fromIdx, toIdx) {
  if (
    fromIdx === toIdx ||
    fromIdx < 0 ||
    toIdx < 0 ||
    fromIdx >= state.savedRecipes.length ||
    toIdx >= state.savedRecipes.length
  ) {
    return false;
  }
  const [moved] = state.savedRecipes.splice(fromIdx, 1);
  state.savedRecipes.splice(toIdx, 0, moved);
  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  showToast(`Moved "${moved.name}"`);
  return true;
}

function orderTwoStageElements(listEl, coffeeEl, waterEl, coffeeBadgeEl, waterBadgeEl, seq) {
  const waterFirst = seq === 'water-first';
  if (listEl && coffeeEl && waterEl) {
    const first = waterFirst ? waterEl : coffeeEl;
    const second = waterFirst ? coffeeEl : waterEl;
    const swapRow = listEl.querySelector ? listEl.querySelector('.stage-swap-row') : null;
    const desired = swapRow ? [first, swapRow, second] : [first, second];
    const current = Array.from(listEl.children);
    // Only touch the DOM when order is wrong: re-inserting a node mid-drag kills desktop range-slider drags.
    if (desired.some((node, i) => current[i] !== node)) {
      desired.forEach(node => listEl.appendChild(node));
    }
  }
  if (coffeeBadgeEl) coffeeBadgeEl.textContent = waterFirst ? '2nd' : '1st';
  if (waterBadgeEl) waterBadgeEl.textContent = waterFirst ? '1st' : '2nd';
}

function setCustomStageOrder(seq) {
  state.customSequence = seq === 'water-first' ? 'water-first' : 'coffee-first';
  syncCustomRecipeUI();
}

function setPresetStageOrder(drinkKey, seq) {
  if (!state.presetTweaks[drinkKey]) resetPresetTweak(drinkKey);
  state.presetTweaks[drinkKey].seq = seq === 'water-first' ? 'water-first' : 'coffee-first';
  const card = Array.from(el.presetDrinkCards || []).find(c => c.dataset && c.dataset.drink === drinkKey);
  if (card) syncPresetCardUI(card, drinkKey);
}

function bindLongPressReorder(container, itemSelector, options = {}) {
  if (!container || (container.dataset && container.dataset.dragBound === '1')) return;
  if (container.dataset) container.dataset.dragBound = '1';

  let dragSession = null;

  const cleanup = (commit) => {
    if (!dragSession) return;
    clearTimeout(dragSession.timer);
    const { card, fromIdx, active } = dragSession;
    dragSession = null;

    card.classList.remove('is-dragging');
    container.classList.remove('is-reordering');

    if (active) {
      const ordered = Array.from(container.querySelectorAll(itemSelector));
      const toIdx = ordered.indexOf(card);
      if (options.onCommit) {
        if (commit) options.onCommit({ card, fromIdx, toIdx, ordered });
      } else if (commit && toIdx !== -1 && toIdx !== fromIdx) {
        moveRecipeFromTo(fromIdx, toIdx);
      } else {
        renderLibrary();
        renderFavoritesOnHome();
      }
    }
  };

  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button, input, a, select, .recipe-temp-pill')) return;
    const card = e.target.closest(itemSelector);
    if (!card || !container.contains(card)) return;

    const fromIdx = options.onCommit
      ? Array.from(container.querySelectorAll(itemSelector)).indexOf(card)
      : parseInt(card.dataset.idx, 10);
    if (Number.isNaN(fromIdx) || fromIdx < 0) return;

    const onHandle = Boolean(e.target.closest('.recipe-drag-handle'));
    dragSession = {
      card,
      fromIdx,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      timer: setTimeout(() => {
        if (!dragSession || dragSession.pointerId !== e.pointerId) return;
        dragSession.active = true;
        card.classList.add('is-dragging');
        container.classList.add('is-reordering');
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(25);
        }
        try {
          card.setPointerCapture?.(e.pointerId);
        } catch (_) {}
      }, onHandle ? 150 : 300)
    };
  });

  container.addEventListener('pointermove', (e) => {
    if (!dragSession || e.pointerId !== dragSession.pointerId) return;

    if (!dragSession.active) {
      if (Math.hypot(e.clientX - dragSession.startX, e.clientY - dragSession.startY) > 10) {
        cleanup(false);
      }
      return;
    }

    if (typeof window !== 'undefined' && typeof window.scrollBy === 'function' && window.innerHeight) {
      if (e.clientY < 70) window.scrollBy(0, -10);
      else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 10);
    }

    const siblings = Array.from(container.querySelectorAll(itemSelector));
    const nextSibling = siblings.find((sib) => {
      if (sib === dragSession.card) return false;
      const rect = sib.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });

    if (nextSibling) {
      if (dragSession.card.nextElementSibling !== nextSibling) {
        container.insertBefore(dragSession.card, nextSibling);
      }
    } else if (siblings[siblings.length - 1] !== dragSession.card) {
      container.appendChild(dragSession.card);
    }
  });

  container.addEventListener('touchmove', (e) => {
    if (dragSession && dragSession.active) {
      e.preventDefault();
    }
  }, { passive: false });

  container.addEventListener('pointerup', (e) => {
    if (dragSession && e.pointerId === dragSession.pointerId) cleanup(true);
  });

  container.addEventListener('pointercancel', (e) => {
    if (dragSession && e.pointerId === dragSession.pointerId) cleanup(false);
  });

  container.addEventListener('contextmenu', (e) => {
    if (dragSession && dragSession.active) e.preventDefault();
  });
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

function syncCustomRecipeUI() {
  el.sliderCoffeeMl.value = state.customCoffeeMl;
  el.sliderWaterMl.value = state.customWaterMl;
  state.customSplitTemp = state.customCoffeeMl > 0 && state.customWaterMl > 0 && state.customCoffeeTemp !== state.customWaterTemp;
  state.customTemp = state.customCoffeeTemp;
  orderTwoStageElements(
    el.customStagesList,
    el.customStageCoffee,
    el.customStageWater,
    el.badgeCustomCoffeeOrder,
    el.badgeCustomWaterOrder,
    state.customSequence
  );
  if (el.seqButtonsCustom) el.seqButtonsCustom.forEach(b => b.classList.toggle('active', b.dataset.seq === state.customSequence));
  if (el.chkSplitTemp) el.chkSplitTemp.checked = state.customSplitTemp;
  if (el.singleTempGroup) el.singleTempGroup.classList.toggle('hidden', state.customSplitTemp);
  if (el.splitTempGroup) el.splitTempGroup.classList.toggle('hidden', !state.customSplitTemp);
  if (el.tempButtonsCustom) el.tempButtonsCustom.forEach(b => b.classList.toggle('active', parseInt(b.dataset.temp, 10) === state.customTemp));
  if (el.tempButtonsCoffee) el.tempButtonsCoffee.forEach(b => b.classList.toggle('active', parseInt(b.dataset.temp, 10) === state.customCoffeeTemp));
  if (el.tempButtonsWater) el.tempButtonsWater.forEach(b => b.classList.toggle('active', parseInt(b.dataset.temp, 10) === state.customWaterTemp));
  updateCustomRecipeSummary();
}

function editRecipeInCustomTab(idx) {
  const r = state.savedRecipes[idx];
  if (!r) return;

  if (r.kind === 'bloom') {
    state.bloomPhase1Ml = r.phase1Ml || 40;
    state.bloomWaitSec = r.waitSec || 60;
    state.bloomPhase2Ml = r.phase2Ml || 130;
    state.bloomTemp = r.temp !== undefined ? r.temp : 2;
    state.editingRecipeId = r.id;

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
  state.customCoffeeTemp = r.coffeeTemp !== undefined ? r.coffeeTemp : (r.temp !== undefined ? r.temp : 2);
  state.customWaterTemp = r.waterTemp !== undefined ? r.waterTemp : (r.temp !== undefined ? r.temp : 1);
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
  const isSplit = state.customCoffeeMl > 0 && state.customWaterMl > 0 && state.customCoffeeTemp !== state.customWaterTemp;
  state.customSplitTemp = isSplit;
  const defaultName = isSplit
    ? 'Split-Temp Americano'
    : (state.customCoffeeMl === 0 ? 'Hot Water Dispense' : `${state.customCoffeeMl}ml Coffee Recipe`);
  const name = inputName || defaultName;

  const newRecipe = {
    id: Date.now().toString(),
    name: name,
    kind: 'custom',
    coffeeMl: state.customCoffeeMl,
    waterMl: state.customWaterMl,
    splitTemp: isSplit,
    coffeeTemp: state.customCoffeeTemp,
    waterTemp: state.customWaterTemp,
    temp: state.customCoffeeMl === 0 ? state.customWaterTemp : state.customCoffeeTemp,
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
  const isSplit = state.customCoffeeMl > 0 && state.customWaterMl > 0 && state.customCoffeeTemp !== state.customWaterTemp;
  state.customSplitTemp = isSplit;
  existing.coffeeMl = state.customCoffeeMl;
  existing.waterMl = state.customWaterMl;
  existing.splitTemp = isSplit;
  existing.coffeeTemp = state.customCoffeeTemp;
  existing.waterTemp = state.customWaterTemp;
  existing.temp = state.customCoffeeMl === 0 ? state.customWaterTemp : state.customCoffeeTemp;
  existing.seq = state.customSequence;
  delete state.recipeTempOverrides[getRecipeTempKey(existing, idx)];

  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  showToast(`Updated "${existing.name}"!`);
}

function saveCurrentBloomRecipe() {
  const inputName = el.inputBloomRecipeName ? el.inputBloomRecipeName.value.trim() : '';
  const existingIdx = state.editingRecipeId
    ? state.savedRecipes.findIndex(r => r.id === state.editingRecipeId && r.kind === 'bloom')
    : -1;

  if (existingIdx !== -1) {
    const existing = state.savedRecipes[existingIdx];
    existing.name = inputName || existing.name;
    existing.phase1Ml = state.bloomPhase1Ml;
    existing.waitSec = state.bloomWaitSec;
    existing.phase2Ml = state.bloomPhase2Ml;
    existing.temp = state.bloomTemp;
    delete state.recipeTempOverrides[getRecipeTempKey(existing, existingIdx)];
    persistSavedRecipes();
    renderLibrary();
    renderFavoritesOnHome();
    showToast(`Updated "${existing.name}"`);
    return;
  }

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
  state.editingRecipeId = newRecipe.id;
  persistSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  showToast(`Saved "${newRecipe.name}"`);
}

function restoreCuratedFavorites() {
  if (confirm('Restore the official Nespresso app favorites + multi-stage cycles to your library?')) {
    state.savedRecipes = JSON.parse(JSON.stringify(DEFAULT_FAVORITE_RECIPES));
    state.recipeTempOverrides = {};
    persistSavedRecipes();
    renderLibrary();
    renderFavoritesOnHome();
    showToast('Restored Nespresso app favorites!');
  }
}

// Machine Dial Quick Profiles
const DIAL_PROFILE_FACTORY = { 0: 25, 1: 40, 2: 110, 3: 25, 4: 125, 5: 200 };
const DIAL_PROFILE_APP = { 0: 25, 1: 40, 2: 80, 3: 40, 4: 140, 5: 230 };

function dialMatchesProfile(dialMap, profileMap) {
  if (!dialMap || !profileMap) return false;
  for (let i = 0; i <= 5; i += 1) {
    if (dialMap[i] !== profileMap[i]) return false;
  }
  return true;
}

function syncDialProfileChipUI() {
  const dial = state.machineDialVolumes;
  if (el.btnProfileFactoryDefaults) {
    el.btnProfileFactoryDefaults.classList.toggle('active-chip', dialMatchesProfile(dial, DIAL_PROFILE_FACTORY));
  }
  if (el.btnProfileAppCalibration) {
    el.btnProfileAppCalibration.classList.toggle('active-chip', dialMatchesProfile(dial, DIAL_PROFILE_APP));
  }
}

function applyDialProfile(profileMap, activeBtn, toastText, persist = true) {
  for (let i = 0; i <= 5; i += 1) {
    if (typeof profileMap[i] === 'number') {
      applyMachineCupTargetVolume(i, profileMap[i], false);
    }
  }
  if (persist && state.machineDialVolumes) {
    try { localStorage.setItem(MACHINE_DIAL_STORAGE_KEY, JSON.stringify(state.machineDialVolumes)); } catch (_) {}
  }
  if (activeBtn) {
    [el.btnProfileFactoryDefaults, el.btnProfileAppCalibration].filter(Boolean).forEach((btn) => {
      btn.classList.toggle('active-chip', btn === activeBtn);
    });
  } else {
    syncDialProfileChipUI();
  }
  updateCupRangeHint();
  if (toastText) showToast(toastText);
}

function applyFactoryDefaultsProfile() {
  applyDialProfile(
    DIAL_PROFILE_FACTORY,
    el.btnProfileFactoryDefaults,
    'Profile: Factory Defaults (25 / 40 / 110 / 25 / 125 / 200)'
  );
}

function applyAppCalibrationProfile() {
  applyDialProfile(
    DIAL_PROFILE_APP,
    el.btnProfileAppCalibration,
    'Profile: App Calibration (25 / 40 / 80 / 40 / 140 / 230)'
  );
}

// 14b. Live LED Telematics Decoder & Interactive Descaling Guide
const WATER_HARDNESS_INFO = {
  0: { label: 'Level 0: Very Soft (<5 °fH / <3 °dH)', cups: 4000 },
  1: { label: 'Level 1: Soft (>7 °fH / >4 °dH)', cups: 3000 },
  2: { label: 'Level 2: Medium (>13 °fH / >7 °dH)', cups: 2000 },
  3: { label: 'Level 3: Hard (Default, >25 °fH / >14 °dH)', cups: 1500 },
  4: { label: 'Level 4: Very Hard (>38 °fH / >21 °dH)', cups: 1000 }
};

function describeLedTelematics({ stateCode, descalingNeeded, waterTankEmpty, capsuleContainerFull, sliderOpen, capsuleStockLow, errorPresent, obstacleDetected }) {
  if (stateCode === 8 || errorPresent || obstacleDetected) {
    return {
      level: 'err', blink: true, showDescale: !!descalingNeeded,
      title: obstacleDetected ? 'Maintenance LED Alert — Obstacle Detected' : 'Maintenance LED Alert — Hardware Error',
      desc: obstacleDetected
        ? 'Obstacle detected in slider or brewing unit. Open slider and clear chamber.'
        : 'Fault detected. Check capsule chamber/water tank or power-cycle machine.'
    };
  }
  if (stateCode === 10) {
    return {
      level: 'err', blink: true, showDescale: false,
      title: 'Maint LED ON • Brew OFF • Temp Fast Blink',
      desc: 'Machine overheating or below 0°C — wait a few minutes to stabilize.'
    };
  }
  if (stateCode === 6) {
    return {
      level: 'warn', blink: true, showDescale: true,
      title: 'Ristretto Blink • Maint LED Steady ON',
      desc: 'Descaling / Rinsing pump active. Press Brew anytime to pause.'
    };
  }
  if (stateCode === 3) {
    return {
      level: 'warn', blink: true, showDescale: true,
      title: 'Ristretto Blink • Maint LED Blinking',
      desc: waterTankEmpty
        ? 'Descaling paused — tank empty. Empty tray, rinse & refill 1.2 L fresh water, then press Brew.'
        : 'Descaling Mode Ready / Paused — press Brew on machine to start or resume.'
    };
  }
  if (stateCode === 5) {
    return {
      level: 'warn', blink: true, showDescale: true,
      title: 'Both Dials Flashing — Settings Mode Active',
      desc: 'Ristretto=Descale • Espresso=Empty System • Lungo=Reset • Americano=Hardness • Drop=Auto-Off • All=BT.'
    };
  }
  if (waterTankEmpty || capsuleContainerFull) {
    const reasons = [];
    if (waterTankEmpty) reasons.push('water tank is empty');
    if (capsuleContainerFull) reasons.push('capsule container is full');
    return {
      level: 'err', blink: false, showDescale: !!descalingNeeded,
      title: 'Brew OFF • Maintenance LED Steady ON',
      desc: `Action required: ${reasons.join(' and ')}.`
    };
  }
  if (descalingNeeded) {
    return {
      level: 'warn', blink: true, showDescale: true,
      title: 'Brew ON • Maintenance LED Slow Blinking',
      desc: 'Descaling is required (~20 min cycle with 2 Nespresso descaling units).'
    };
  }
  if (sliderOpen) {
    return {
      level: 'warn', blink: false, showDescale: false,
      title: 'Capsule Slider OPEN',
      desc: 'Slide closed before starting or scheduling any brew.'
    };
  }
  if (capsuleStockLow) {
    return {
      level: 'warn', blink: false, showDescale: false,
      title: 'Nespresso Front LED ON — Low Capsule Stock',
      desc: 'Remaining capsule stock is at or below the configured alert threshold.'
    };
  }
  if (stateCode === 1) {
    return {
      level: 'ok', blink: true, showDescale: false,
      title: 'Lights Blinking — Heating Up (~25–30s)',
      desc: 'Thermoblock warming; steady lights indicate ready.'
    };
  }
  if (stateCode === 4) {
    return {
      level: 'ok', blink: true, showDescale: false,
      title: 'Brewing in Progress',
      desc: 'Extraction active. Keep cup under outlet until complete.'
    };
  }
  if (stateCode === 7) {
    return {
      level: 'warn', blink: true, showDescale: false,
      title: 'Steaming Out / Emptying System',
      desc: 'Purging internal circuit (machine remains locked 10 min after emptying).'
    };
  }
  if (stateCode === 9) {
    return {
      level: 'ok', blink: false, showDescale: !!descalingNeeded,
      title: 'LEDs Off — Standby / OFF Mode',
      desc: 'Machine is OFF. Hold Brew 6s for Settings Mode or turn dial/press Brew to wake.'
    };
  }
  return {
    level: 'ok', blink: false, showDescale: false,
    title: 'Steady Lights — Machine is Ready',
    desc: 'All sensors normal. Ready to brew.'
  };
}

function updateLedTelematicsBanner(statusObj) {
  if (!el.ledTelematicsBanner) return;
  const info = describeLedTelematics(statusObj);
  el.ledTelematicsBanner.classList.remove('hidden', 'led-state-warn', 'led-state-err');
  if (info.level === 'warn') el.ledTelematicsBanner.classList.add('led-state-warn');
  if (info.level === 'err') el.ledTelematicsBanner.classList.add('led-state-err');

  el.ledBannerDot.className = `led-dot led-${info.level}${info.blink ? ' led-blink' : ''}`;
  el.ledBannerTitle.textContent = info.title;
  el.ledBannerDesc.textContent = info.desc;
  el.btnJumpToDescale.classList.toggle('hidden', !info.showDescale);
}

const DESCALE_STEPS_DATA = {
  1: {
    title: 'Step 1 of 8 — Empty Tray & Capsule Bin',
    bleTag: '06aa3a12: READY / STANDBY',
    brewLed: 'Brew LED: ON', brewClass: 'vis-led-on',
    maintLed: 'Maint: Slow Blink', maintClass: 'vis-led-warn vis-led-blink',
    bevDial: 'Any', bevBlink: false,
    tempDial: 'Any',
    outlet: 'Tray & Bin Emptied',
    tankLabel: 'Empty 0%', tankPct: 0, tankClass: '',
    todo: 'Remove and empty the drip tray and used capsule container, reinsert them, and push the capsule slider fully closed.',
    expect: 'Machine can be ON or OFF; if ON with descalingNeeded, Brew LED stays ON and Maintenance LED blinks slowly (Bit 5 = 1, Bit 46 = 1).'
  },
  2: {
    title: 'Step 2 of 8 — Mix Descaling Solution',
    bleTag: 'waterTankEmpty: 0',
    brewLed: 'Brew LED: ON', brewClass: 'vis-led-on',
    maintLed: 'Maint: Slow Blink', maintClass: 'vis-led-warn vis-led-blink',
    bevDial: 'Any', bevBlink: false,
    tempDial: 'Any',
    outlet: 'No Flow',
    tankLabel: 'Descaler MAX', tankPct: 100, tankClass: 'tank-acid',
    todo: 'Pour 2 pouches of Nespresso liquid descaler into the water tank, fill with potable water up to MAX (~1.1–1.2 L), and seat the tank.',
    expect: 'Water tank empty bit clears (0); tank is full of descaling solution ready to prime.'
  },
  3: {
    title: 'Step 3 of 8 — Place 1.2 L Container & Turn OFF',
    bleTag: 'state = 9 (POWER_SAVE)',
    brewLed: 'Brew LED: OFF', brewClass: '',
    maintLed: 'Maint LED: OFF', maintClass: '',
    bevDial: 'Any', bevBlink: false,
    tempDial: '0 (OFF) ←',
    outlet: 'Container >= 1.2 L',
    tankLabel: 'Descaler 100%', tankPct: 100, tankClass: 'tank-acid',
    todo: 'Place a container (minimum 1.2 L / 41 oz) under the coffee and hot water outlets. Turn the Temperature dial anti-clockwise to 0.',
    expect: 'Lights blink for 5 seconds, then all machine LEDs switch OFF into Standby (06aa3a12 state = 9 POWER_SAVE).'
  },
  4: {
    title: 'Step 4 of 8 — Enter Descaling Mode (Handshake)',
    bleTag: 'state = 5 -> 3 (DESCALING_READY)',
    brewLed: 'Hold 6s -> Confirm', brewClass: 'vis-led-blink',
    maintLed: 'Maint: Wait', maintClass: 'vis-led-warn',
    bevDial: '☕ Ristretto', bevBlink: true,
    tempDial: 'High (I) ✓',
    outlet: 'Ready >= 1.2 L',
    tankLabel: 'Descaler 100%', tankPct: 100, tankClass: 'tank-acid',
    todo: '1) Hold Brew 6s (both dials flash). 2) Select Ristretto + press Brew. 3) Turn Temp dial to High (I) + press Brew to confirm (Low O cancels).',
    expect: 'Both dials flash in Settings Mode (state = 5), then only Ristretto blinks (state = 3 DESCALING_READY). Once confirmed with High (I), mode is locked.'
  },
  5: {
    title: 'Step 5 of 8 — Run Descaling Pass (Acid)',
    bleTag: 'state = 6 (DESCALING)',
    brewLed: 'Press to Pause', brewClass: 'vis-led-on',
    maintLed: 'Maint: STEADY ON', maintClass: 'vis-led-warn',
    bevDial: '☕ Ristretto', bevBlink: true,
    tempDial: 'High (I)',
    outlet: '💧 Acid Flowing',
    tankLabel: 'Draining...', tankPct: 45, tankClass: 'tank-acid',
    todo: 'Press Brew to start. If machine pauses and Maintenance LED blinks, empty tray/container, replace, and press Brew until tank empties.',
    expect: 'Ristretto blinks and Maintenance LED stays steady ON (state = 6) as acid alternates between coffee and hot water spouts, then pauses with Maintenance LED blinking on empty tank.'
  },
  6: {
    title: 'Step 6 of 8 — Rinse Tank, Tray & Support',
    bleTag: 'state = 3 + waterEmpty = 1',
    brewLed: 'Paused', brewClass: 'vis-led-warn',
    maintLed: 'Maint: BLINKING', maintClass: 'vis-led-warn vis-led-blink',
    bevDial: '☕ Ristretto', bevBlink: true,
    tempDial: 'Locked',
    outlet: 'Wash & Empty',
    tankLabel: 'Rinse 0%', tankPct: 0, tankClass: '',
    todo: 'Remove the empty water tank, drip tray, and cup support. Rinse all three thoroughly with fresh tap water to remove acid residue.',
    expect: 'Machine waits in paused descaling state with Ristretto blinking and Maintenance LED blinking (state = 3, waterTankEmpty = 1).'
  },
  7: {
    title: 'Step 7 of 8 — Refill 1.2 L Fresh Potable Water',
    bleTag: 'state = 3 (DESCALING_READY)',
    brewLed: 'Ready for Rinse', brewClass: 'vis-led-blink',
    maintLed: 'Maint: BLINKING', maintClass: 'vis-led-warn vis-led-blink',
    bevDial: '☕ Ristretto', bevBlink: true,
    tempDial: 'Locked',
    outlet: 'Empty Cont. Placed',
    tankLabel: 'Fresh 1.2 L', tankPct: 100, tankClass: 'tank-fresh',
    todo: 'Fill the rinsed water tank with at least 1.2 L (41 oz) fresh potable water, seat it, and place the emptied container back under the outlet.',
    expect: 'waterTankEmpty clears (0); Ristretto icon keeps blinking while waiting for Brew press to start the final rinse.'
  },
  8: {
    title: 'Step 8 of 8 — Run Rinse Cycle & Auto-Off',
    bleTag: 'state = 6 -> 9 (POWER_SAVE)',
    brewLed: 'Rinsing -> OFF', brewClass: 'vis-led-on',
    maintLed: 'Steady -> OFF', maintClass: 'vis-led-on',
    bevDial: '☕ Ristretto', bevBlink: true,
    tempDial: 'Auto OFF',
    outlet: '💧 Clear Rinse',
    tankLabel: 'Fresh -> 0%', tankPct: 30, tankClass: 'tank-fresh',
    todo: 'Press Brew to start rinsing until the tank empties, wait for automatic shut-off, then empty the drip tray.',
    expect: 'Ristretto blinks and Maintenance LED stays steady ON during rinse, then machine turns OFF automatically (state = 9, descalingNeeded = 0). If Maint LED still blinks, < 1.2 L was added — repeat Steps 7–8.'
  }
};

function updateDescaleGuideUI() {
  if (!el.descaleSteps) return;
  el.descaleSteps.forEach(stepEl => {
    const num = parseInt(stepEl.dataset.step, 10);
    stepEl.classList.toggle('done-step', state.descaleDone ? true : num < state.descaleStep);
    stepEl.classList.toggle('active-step', !state.descaleDone && num === state.descaleStep);
  });
  if (el.badgeDescalePhase) {
    el.badgeDescalePhase.textContent = state.descaleDone ? 'Done ✓' : `Step ${state.descaleStep} / 8 (~20 min)`;
  }

  const info = DESCALE_STEPS_DATA[state.descaleStep] || DESCALE_STEPS_DATA[1];
  if (el.visSlider) {
    el.visSlider.textContent = state.sliderOpen ? 'Slider: OPEN ⚠️' : 'Slider: CLOSED 🔒';
    el.visSlider.className = `vis-deck-pill ${state.sliderOpen ? 'vis-led-warn' : 'vis-led-on'}`;
  }
  if (el.visBrewBtn) {
    el.visBrewBtn.textContent = state.descaleDone ? 'Brew LED: OFF' : info.brewLed;
    el.visBrewBtn.className = `vis-deck-pill ${state.descaleDone ? '' : info.brewClass}`.trim();
  }
  if (el.visMaintLed) {
    el.visMaintLed.textContent = state.descaleDone ? 'Maint LED: OFF ✓' : info.maintLed;
    el.visMaintLed.className = `vis-deck-pill ${state.descaleDone ? 'vis-led-on' : info.maintClass}`.trim();
  }
  if (el.visBevDial) {
    el.visBevDial.textContent = state.descaleDone ? '✓ Complete' : info.bevDial;
    el.visBevDial.className = `vis-dial-val${!state.descaleDone && info.bevBlink ? ' vis-dial-blink' : ''}`;
  }
  if (el.visTempDial) el.visTempDial.textContent = state.descaleDone ? '0 (OFF)' : info.tempDial;
  if (el.visOutlet) el.visOutlet.textContent = state.descaleDone ? 'Tray Clean ✓' : info.outlet;
  if (el.visTank) {
    el.visTank.style.height = `${state.descaleDone ? 0 : info.tankPct}%`;
    el.visTank.className = `vis-tank-fill ${state.descaleDone ? '' : info.tankClass}`.trim();
  }
  if (el.visTankLabel) el.visTankLabel.textContent = state.descaleDone ? 'Done 0%' : info.tankLabel;
  if (el.visStepTitle) el.visStepTitle.textContent = state.descaleDone ? 'Descaling Complete ✓' : info.title;
  if (el.visBleStateTag) el.visBleStateTag.textContent = state.descaleDone ? 'descalingNeeded = 0' : info.bleTag;
  if (el.visWhatToDo) el.visWhatToDo.textContent = state.descaleDone ? 'Empty the drip tray and discard rinse water. Machine is ready for normal coffee use.' : info.todo;
  if (el.visWhatToExpect) el.visWhatToExpect.textContent = state.descaleDone ? 'All LEDs OFF in standby; Maintenance LED descaling alert is cleared.' : info.expect;
}

function syncDescaleStepFromTelemetry(prevState, newState, waterTankEmpty, descalingNeeded) {
  if (newState === 5 && state.descaleStep < 4) {
    state.descaleStep = 4;
    state.descaleDone = false;
  } else if (newState === 3 && state.descaleStep < 4) {
    state.descaleStep = 4;
    state.descaleDone = false;
  } else if (newState === 6) {
    state.descaleStep = state.descaleStep >= 6 ? 8 : 5;
    state.descaleDone = false;
  } else if ((newState === 3 || prevState === 6) && waterTankEmpty && state.descaleStep === 5) {
    state.descaleStep = 6;
    showToast('Tank emptied! Rinse parts & refill 1.2 L fresh water (Steps 6–7).');
  } else if (prevState === 6 && newState === 9 && state.descaleStep >= 7 && !descalingNeeded) {
    state.descaleStep = 8;
    state.descaleDone = true;
    showToast('Descaling & Rinsing complete! Machine switched OFF.');
  }
  updateDescaleGuideUI();
}

function jumpToDescaleGuide() {
  switchTab('tab-machine');
  setTimeout(() => {
    if (el.cardDescalingGuide) el.cardDescalingGuide.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 50);
}

async function prepareDescaleViaBle() {
  state.descaleStep = 1;
  state.descaleDone = false;
  updateDescaleGuideUI();

  if (!state.isConnected) {
    const hLevel = parseInt(el.selectWaterHardness ? el.selectWaterHardness.value : '3', 10);
    const hInfo = WATER_HARDNESS_INFO[hLevel] || WATER_HARDNESS_INFO[3];
    if (el.descalePrepStatus) {
      el.descalePrepStatus.textContent = `Offline checklist ready • Configured hardness: ${hInfo.label} (${hInfo.cups} cups interval). Connect via BLE for live sensor checks & step tracking.`;
    }
    showToast('Checklist reset to Step 1 (Connect BLE for live tracking)');
    return;
  }

  try {
    // Clear any scheduled timer safely before starting maintenance (03 06 01 02)
    const stopPayload = new Uint8Array([0x03, 0x06, 0x01, 0x02]);
    log(`Pre-descale BLE prep: clearing timers (03 06 01 02)`, 'tx');
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, stopPayload).catch(() => {});
    await sleep(150);

    for (const uuid of [BLE_UUIDS.CHAR_MACHINE_STATUS, BLE_UUIDS.CHAR_USER_SETTINGS]) {
      const bytes = await readBleCharacteristic(uuid).catch(() => null);
      if (bytes) handleRawCharacteristicBytes(uuid, bytes);
      await sleep(100);
    }

    const hInfo = WATER_HARDNESS_INFO[state.waterHardnessLevel] || WATER_HARDNESS_INFO[3];
    const sliderTxt = state.sliderOpen ? 'OPEN ✗ (Close slider!)' : 'Closed ✓';
    const binTxt = state.capsuleContainerFull ? 'FULL ✗ (Empty bin!)' : 'OK ✓';
    const descaleTxt = state.descalingNeeded ? 'Needed ⚠️' : 'OK ✓';
    if (el.descalePrepStatus) {
      el.descalePrepStatus.textContent = `BLE Ready • Timers cleared • Slider: ${sliderTxt} • Bin: ${binTxt} • ${hInfo.label} (${hInfo.cups} cups) • Flag: ${descaleTxt}`;
    }
    showToast('Machine checked & timers cleared via BLE!');
  } catch (err) {
    log(`Pre-descale prep note: ${err.message}`, 'warn');
    showToast(`Prep check note: ${err.message}`);
  }
}

// 14c. In-App Official Manual Modal (Reader + Embedded PDF View)
let manualActiveSection = 'all';
let manualCurrentPage = 1;
let manualViewMode = 'reader';

function setManualMode(mode, page = manualCurrentPage) {
  manualViewMode = mode;
  manualCurrentPage = page || 1;
  const isPdf = mode === 'pdf';
  if (el.btnManualModeReader) el.btnManualModeReader.classList.toggle('active', !isPdf);
  if (el.btnManualModePdf) el.btnManualModePdf.classList.toggle('active', isPdf);
  if (el.manualReaderPane) el.manualReaderPane.classList.toggle('hidden', isPdf);
  if (el.manualPdfPane) el.manualPdfPane.classList.toggle('hidden', !isPdf);
  if (el.manualPdfPageTag) el.manualPdfPageTag.textContent = `Page ${manualCurrentPage}`;
  if (isPdf && el.manualPdfFrame) {
    el.manualPdfFrame.src = `documentation/NespressoExpertEN350G.pdf#page=${manualCurrentPage}`;
  }
}

function filterManualSections() {
  if (!el.manualSecCards) return;
  const query = (el.inputManualSearch ? el.inputManualSearch.value : '').trim().toLowerCase();
  el.manualSecCards.forEach(card => {
    const sec = card.dataset.manualSec || '';
    const secMatch = query ? true : (manualActiveSection === 'all' || sec === manualActiveSection);
    const textMatch = !query || card.textContent.toLowerCase().includes(query);
    card.classList.toggle('hidden', !(secMatch && textMatch));
  });
}

function openManualModal(targetSection = 'all', targetPage = 1) {
  if (!el.manualModal) return;
  manualActiveSection = targetSection;
  if (el.inputManualSearch) el.inputManualSearch.value = '';
  if (el.manualJumpChips) {
    el.manualJumpChips.forEach(chip => {
      chip.classList.toggle('active-chip', chip.dataset.sec === targetSection);
    });
  }
  setManualMode(manualViewMode, targetPage);
  filterManualSections();
  el.manualModal.classList.remove('hidden');
}

function closeManualModal() {
  if (el.manualModal) el.manualModal.classList.add('hidden');
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

function resetPresetTweak(drinkKey) {
  const def = PRESET_DRINK_DEFAULTS[drinkKey];
  if (!def) return;
  state.presetTweaks[drinkKey] = JSON.parse(JSON.stringify(def));
}

function isTwoStagePreset(def) {
  return Boolean(def && def.coffeeMl > 0 && def.waterMl > 0);
}

function getShortTempLabel(code) {
  return code === 1 ? '80°C' : (code === 2 ? '90°C' : '85°C');
}

function executePresetDrink(drinkKey, useTweaks = false) {
  const def = PRESET_DRINK_DEFAULTS[drinkKey];
  if (!def) return;
  const cfg = useTweaks ? (state.presetTweaks[drinkKey] || def) : def;

  if (isTwoStagePreset(def)) {
    const seq = cfg.seq || def.seq || 'coffee-first';
    const coffeeTemp = cfg.coffeeTemp !== undefined ? cfg.coffeeTemp : (cfg.temp !== undefined ? cfg.temp : 0);
    const waterTemp = cfg.waterTemp !== undefined ? cfg.waterTemp : (cfg.temp !== undefined ? cfg.temp : 0);
    state.selectedTemp = coffeeTemp;
    if (!useTweaks && def.sizeCode !== null) {
      return brewPreset(def.name, def.sizeCode, coffeeTemp);
    }
    return brewCustomRecipe(cfg.coffeeMl, cfg.waterMl, {
      seq,
      splitTemp: coffeeTemp !== waterTemp,
      temp: coffeeTemp,
      coffeeTemp,
      waterTemp
    });
  }

  if (cfg.temp === 0 || cfg.temp === 1 || cfg.temp === 2) {
    state.selectedTemp = cfg.temp;
  }
  const dialVol = drinkKey === 'hotwater' ? ((state.machineDialVolumes && state.machineDialVolumes[5]) || 200) : def.coffeeMl;
  const volChanged = drinkKey === 'hotwater'
    ? (cfg.waterMl !== dialVol)
    : (useTweaks && (cfg.coffeeMl !== def.coffeeMl || cfg.waterMl !== def.waterMl));
  if (!volChanged) {
    return brewPreset(def.name, def.sizeCode, cfg.temp);
  }
  return brewCustomRecipe(cfg.coffeeMl, cfg.waterMl, {
    seq: 'coffee-first',
    splitTemp: false,
    temp: cfg.temp,
    coffeeTemp: cfg.temp,
    waterTemp: cfg.temp
  });
}

function formatPresetActionText(def, cfg) {
  if (isTwoStagePreset(def)) {
    const cTemp = cfg.coffeeTemp !== undefined ? cfg.coffeeTemp : 0;
    const wTemp = cfg.waterTemp !== undefined ? cfg.waterTemp : 0;
    const cPart = `${cfg.coffeeMl}ml☕ ${getShortTempLabel(cTemp)}`;
    const wPart = `${cfg.waterMl}ml💧 ${getShortTempLabel(wTemp)}`;
    const ordered = cfg.seq === 'water-first' ? `${wPart} → ${cPart}` : `${cPart} → ${wPart}`;
    return `${def.actionLabel} (${ordered})`;
  }
  const parts = [];
  if (def.coffeeMl > 0) parts.push(`${cfg.coffeeMl}ml`);
  if (def.waterMl > 0) parts.push(`${cfg.waterMl}ml`);
  return `${def.actionLabel} (${parts.join(' + ')} • ${getTempLabel(cfg.temp)})`;
}

function getPresetVolumeTag(kind, ml) {
  const dial = state.machineDialVolumes || DIAL_PROFILE_FACTORY;
  if (kind === 'coffee') {
    if (ml === 15) return 'Min';
    if (ml === 130) return 'Max';
    if (ml === dial[0]) return 'Ristretto';
    if (ml === dial[1]) return 'Espresso';
    if (ml === dial[2]) return 'Lungo';
    if (ml === dial[3]) return 'Americano';
    return '';
  }
  if (kind === 'water') {
    if (ml === 25) return 'Min';
    if (ml === 300) return 'Max';
    if (ml === dial[5]) return 'Hot Water';
    if (ml === dial[4]) return 'Americano';
    if (ml === 160) return 'XL';
    return '';
  }
  return '';
}

function formatPresetVolumeLabel(kind, ml) {
  const tag = getPresetVolumeTag(kind, ml);
  return tag ? `(${tag}) ${ml} ml` : `${ml} ml`;
}

function syncPresetCardUI(card, drinkKey) {
  const def = PRESET_DRINK_DEFAULTS[drinkKey];
  const cfg = state.presetTweaks[drinkKey] || def;
  if (!card || !def) return;

  const cSlider = card.querySelector('.preset-coffee-slider');
  const cVal = card.querySelector('.preset-coffee-val');
  if (cSlider) cSlider.value = cfg.coffeeMl;
  if (cVal) cVal.textContent = formatPresetVolumeLabel('coffee', cfg.coffeeMl);

  const wSlider = card.querySelector('.preset-water-slider');
  const wVal = card.querySelector('.preset-water-val');
  if (wSlider) wSlider.value = cfg.waterMl;
  if (wVal) wVal.textContent = formatPresetVolumeLabel('water', cfg.waterMl);

  if (isTwoStagePreset(def)) {
    const iconEl = card.querySelector('.drink-icon');
    if (iconEl) {
      iconEl.textContent = cfg.seq === 'water-first' ? '💧☕' : '☕💧';
    }
    const volEl = card.querySelector('.drink-vol');
    if (volEl) {
      if (drinkKey === 'americano') {
        volEl.textContent = cfg.seq === 'water-first'
          ? `Rotary Dial Preset (${def.waterMl}ml + ${def.coffeeMl}ml)`
          : `Rotary Dial Preset (${def.coffeeMl}ml + ${def.waterMl}ml)`;
      } else {
        const cDesc = `${cfg.coffeeMl}ml Coffee (${getTempLabel(cfg.coffeeTemp).replace('~', '')})`;
        const wDesc = `${cfg.waterMl}ml Water (${getTempLabel(cfg.waterTemp).replace('~', '')})`;
        volEl.textContent = cfg.seq === 'water-first' ? `${wDesc} → ${cDesc}` : `${cDesc} → ${wDesc}`;
      }
    }

    const stagesList = card.querySelector('.preset-stages-list');
    const coffeeStage = card.querySelector('.preset-stage-item[data-stage="coffee"]');
    const waterStage = card.querySelector('.preset-stage-item[data-stage="water"]');
    const cBadge = card.querySelector('[data-stage-badge="coffee"]');
    const wBadge = card.querySelector('[data-stage-badge="water"]');
    orderTwoStageElements(stagesList, coffeeStage, waterStage, cBadge, wBadge, cfg.seq || 'coffee-first');

    card.querySelectorAll('.preset-coffee-temp-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.temp, 10) === cfg.coffeeTemp);
    });
    card.querySelectorAll('.preset-water-temp-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.temp, 10) === cfg.waterTemp);
    });
  } else {
    const subtitleEl = card.querySelector('.drink-vol');
    if (subtitleEl && (drinkKey === 'ristretto' || drinkKey === 'espresso' || drinkKey === 'lungo')) {
      subtitleEl.textContent = `Rotary Dial Preset (${def.coffeeMl} ml)`;
    }
    card.querySelectorAll('.preset-temp-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.temp, 10) === cfg.temp);
    });
  }

  const brewBtn = card.querySelector('.btn-preset-brew-tweaked');
  if (brewBtn) brewBtn.textContent = formatPresetActionText(def, cfg);
}

function renderStageTempButtonsHtml(btnClass, selectedTemp) {
  const classes = btnClass === 'preset-temp-btn' ? 'preset-temp-btn' : `preset-temp-btn ${btnClass}`;
  return [
    { mode: 1, label: 'Warm ~80°C' },
    { mode: 0, label: 'Hot ~85°C' },
    { mode: 2, label: 'Max ~90°C' }
  ].map(t => `<button type="button" class="${classes}${selectedTemp === t.mode ? ' active' : ''}" data-temp="${t.mode}">${t.label}</button>`).join('');
}

function initPresetDrinkCards() {
  if (!el.presetDrinkCards) return;
  el.presetDrinkCards.forEach(card => {
    const drinkKey = card.dataset.drink;
    const def = PRESET_DRINK_DEFAULTS[drinkKey];
    if (!def) return;
    if (!state.presetTweaks[drinkKey]) resetPresetTweak(drinkKey);

    const panel = card.querySelector('.drink-expand-panel');
    const mainRow = card.querySelector('.drink-card-main');
    const quickBtn = card.querySelector('.btn-preset-quick');

    if (panel) {
      const cfg = state.presetTweaks[drinkKey];
      if (isTwoStagePreset(def)) {
        const cStageHtml = `
          <div class="preset-stage-item" data-stage="coffee">
            <div class="preset-stage-body">
              <div class="slider-header" style="margin-bottom:0;">
                <span class="form-label"><span class="stage-order-badge" data-stage-badge="coffee">1st</span> ☕ Coffee Stage</span>
                <span class="slider-badge preset-coffee-val">${formatPresetVolumeLabel('coffee', cfg.coffeeMl)}</span>
              </div>
              <input type="range" class="styled-slider preset-coffee-slider" min="15" max="130" step="5" value="${cfg.coffeeMl}">
              <div class="preset-temp-row">
                <span class="form-label" style="display:block; margin-bottom:6px;">Brew Temperature</span>
                <div class="temp-toggle-group compact">
                  ${renderStageTempButtonsHtml('preset-coffee-temp-btn', cfg.coffeeTemp)}
                </div>
              </div>
            </div>
          </div>`;
        const swapRowHtml = `
          <div class="stage-swap-row">
            <button type="button" class="btn-xs btn-swap-stages btn-preset-swap-stages">⇅ Swap Stage Order (1st ↔ 2nd)</button>
          </div>`;
        const wStageHtml = `
          <div class="preset-stage-item" data-stage="water">
            <div class="preset-stage-body">
              <div class="slider-header" style="margin-bottom:0;">
                <span class="form-label"><span class="stage-order-badge" data-stage-badge="water">2nd</span> 💧 Water Stage</span>
                <span class="slider-badge preset-water-val">${formatPresetVolumeLabel('water', cfg.waterMl)}</span>
              </div>
              <input type="range" class="styled-slider preset-water-slider" min="25" max="300" step="5" value="${cfg.waterMl}">
              <div class="preset-temp-row">
                <span class="form-label" style="display:block; margin-bottom:6px;">Brew Temperature</span>
                <div class="temp-toggle-group compact">
                  ${renderStageTempButtonsHtml('preset-water-temp-btn', cfg.waterTemp)}
                </div>
              </div>
            </div>
          </div>`;

        panel.innerHTML = `
          <div class="preset-stages-list">${cfg.seq === 'water-first' ? (wStageHtml + swapRowHtml + cStageHtml) : (cStageHtml + swapRowHtml + wStageHtml)}</div>
          <small class="field-hint">Tap <strong>Swap Stage Order</strong> to flip Coffee vs Water first. Distinct temps auto-run 2 stages.</small>
          <div class="drink-expand-actions">
            <button type="button" class="btn-sm btn-preset-reset">Reset Default</button>
            <button type="button" class="btn btn-connect btn-preset-brew-tweaked" style="padding:7px 14px; font-size:12px;">${formatPresetActionText(def, cfg)}</button>
          </div>`;

        const swapBtn = panel.querySelector('.btn-preset-swap-stages');
        if (swapBtn) {
          swapBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextSeq = state.presetTweaks[drinkKey].seq === 'water-first' ? 'coffee-first' : 'water-first';
            setPresetStageOrder(drinkKey, nextSeq);
          });
        }

        panel.querySelectorAll('.preset-coffee-temp-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.presetTweaks[drinkKey].coffeeTemp = parseInt(btn.dataset.temp, 10);
            syncPresetCardUI(card, drinkKey);
          });
        });

        panel.querySelectorAll('.preset-water-temp-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.presetTweaks[drinkKey].waterTemp = parseInt(btn.dataset.temp, 10);
            syncPresetCardUI(card, drinkKey);
          });
        });
      } else {
        panel.innerHTML = `
          ${def.coffeeMl > 0 ? `
          <div class="preset-slider-row">
            <div class="slider-header" style="margin-bottom:4px;">
              <span class="form-label">☕ Coffee Volume</span>
              <span class="slider-badge preset-coffee-val">${formatPresetVolumeLabel('coffee', cfg.coffeeMl)}</span>
            </div>
            <input type="range" class="styled-slider preset-coffee-slider" min="15" max="130" step="5" value="${cfg.coffeeMl}">
          </div>` : ''}
          ${def.waterMl > 0 ? `
          <div class="preset-slider-row">
            <div class="slider-header" style="margin-bottom:4px;">
              <span class="form-label">💧 Water Volume</span>
              <span class="slider-badge preset-water-val">${formatPresetVolumeLabel('water', cfg.waterMl)}</span>
            </div>
            <input type="range" class="styled-slider preset-water-slider" min="25" max="300" step="5" value="${cfg.waterMl}">
          </div>` : ''}
          <div class="preset-temp-row">
            <span class="form-label" style="display:block; margin-bottom:6px;">Brew Temperature</span>
            <div class="temp-toggle-group compact">
              ${renderStageTempButtonsHtml('preset-temp-btn', cfg.temp)}
            </div>
          </div>
          <div class="drink-expand-actions">
            <button type="button" class="btn-sm btn-preset-reset">Reset Default</button>
            <button type="button" class="btn btn-connect btn-preset-brew-tweaked" style="padding:7px 14px; font-size:12px;">${formatPresetActionText(def, cfg)}</button>
          </div>`;

        panel.querySelectorAll('.preset-temp-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mode = parseInt(btn.dataset.temp, 10);
            state.presetTweaks[drinkKey].temp = mode;
            state.selectedTemp = mode;
            syncPresetCardUI(card, drinkKey);
          });
        });
      }

      syncPresetCardUI(card, drinkKey);

      const cSlider = panel.querySelector('.preset-coffee-slider');
      if (cSlider) {
        cSlider.addEventListener('input', () => {
          state.presetTweaks[drinkKey].coffeeMl = parseInt(cSlider.value, 10);
          syncPresetCardUI(card, drinkKey);
        });
      }

      const wSlider = panel.querySelector('.preset-water-slider');
      if (wSlider) {
        wSlider.addEventListener('input', () => {
          state.presetTweaks[drinkKey].waterMl = parseInt(wSlider.value, 10);
          syncPresetCardUI(card, drinkKey);
        });
      }

      const resetBtn = panel.querySelector('.btn-preset-reset');
      if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          resetPresetTweak(drinkKey);
          syncPresetCardUI(card, drinkKey);
        });
      }

      const brewTweakedBtn = panel.querySelector('.btn-preset-brew-tweaked');
      if (brewTweakedBtn) {
        brewTweakedBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          executePresetDrink(drinkKey, true);
        });
      }
    }

    if (quickBtn) {
      quickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        executePresetDrink(drinkKey, card.classList.contains('expanded'));
      });
    }

    if (mainRow && panel) {
      mainRow.addEventListener('click', (e) => {
        if (e.target.closest('.btn-preset-quick')) return;
        const willExpand = !card.classList.contains('expanded');
        el.presetDrinkCards.forEach(other => {
          if (other !== card) {
            other.classList.remove('expanded');
            const otherPanel = other.querySelector('.drink-expand-panel');
            if (otherPanel) otherPanel.classList.add('hidden');
          }
        });
        card.classList.toggle('expanded', willExpand);
        panel.classList.toggle('hidden', !willExpand);
        state.expandedPresetDrink = willExpand ? drinkKey : null;
      });
    }
  });
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

  // Tab 1: Presets & Schedule (expandable drink cards with per-drink volume & temperature)
  initPresetDrinkCards();

  el.btnScheduleBrew.addEventListener('click', scheduleHardwareBrew);
  el.btnReadSchedule.addEventListener('click', readScheduledBrew);
  el.btnCancelSchedule.addEventListener('click', emergencyStop);

  // Tab 2: Custom Recipe & Two-Phase Stage Builder
  if (el.btnSwapCustomStages) {
    el.btnSwapCustomStages.addEventListener('click', () => {
      setCustomStageOrder(state.customSequence === 'water-first' ? 'coffee-first' : 'water-first');
    });
  }

  el.btnLoadGreatAmericano.addEventListener('click', () => {
    state.customCoffeeMl = 40;
    state.customWaterMl = 160;
    state.customCoffeeTemp = 2;
    state.customWaterTemp = 1;
    state.customSplitTemp = true;
    setCustomStageOrder('water-first');
    showToast('Loaded Great Americano XL (160ml @ Warm → 40ml @ Max)');
  });

  el.seqButtonsCustom.forEach(btn => {
    btn.addEventListener('click', () => setCustomStageOrder(btn.dataset.seq));
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
      state.customCoffeeTemp = parseInt(btn.dataset.temp, 10);
      syncCustomRecipeUI();
    });
  });

  el.tempButtonsWater.forEach(btn => {
    btn.addEventListener('click', () => {
      state.customWaterTemp = parseInt(btn.dataset.temp, 10);
      syncCustomRecipeUI();
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
    state.editingRecipeId = null;
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
  if (el.btnTopUpCoffee) el.btnTopUpCoffee.addEventListener('click', () => triggerPostBrewTopUp('coffee'));
  if (el.btnTopUpWater) el.btnTopUpWater.addEventListener('click', () => triggerPostBrewTopUp('water'));
  if (el.btnDismissPostBrew) el.btnDismissPostBrew.addEventListener('click', dismissPostBrewModal);

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
  if (el.btnReadStock) el.btnReadStock.addEventListener('click', readCapsuleStock);
  if (el.btnWriteStock) el.btnWriteStock.addEventListener('click', writeCapsuleStock);
  if (el.btnDisableStock) el.btnDisableStock.addEventListener('click', disableCapsuleStock);
  if (el.btnReadStockThreshold) el.btnReadStockThreshold.addEventListener('click', readStockThreshold);
  if (el.btnWriteStockThreshold) el.btnWriteStockThreshold.addEventListener('click', writeStockThreshold);
  if (el.btnReadErrorSlot) el.btnReadErrorSlot.addEventListener('click', readErrorLogSlot);
  if (el.btnStartSystemRinse) el.btnStartSystemRinse.addEventListener('click', startSystemRinseWorkflow);
  if (el.btnStopSystemRinse) el.btnStopSystemRinse.addEventListener('click', stopSystemRinseWorkflow);
  el.btnBleFactoryReset.addEventListener('click', sendBleFactoryReset);

  // LED Telematics Banner & Descaling Guide
  if (el.btnJumpToDescale) el.btnJumpToDescale.addEventListener('click', jumpToDescaleGuide);
  if (el.btnBlePrepDescale) el.btnBlePrepDescale.addEventListener('click', prepareDescaleViaBle);
  if (el.btnDescalePrevStep) {
    el.btnDescalePrevStep.addEventListener('click', () => {
      state.descaleDone = false;
      state.descaleStep = Math.max(1, state.descaleStep - 1);
      updateDescaleGuideUI();
    });
  }
  if (el.btnDescaleNextStep) {
    el.btnDescaleNextStep.addEventListener('click', () => {
      if (state.descaleStep >= 8) state.descaleDone = true;
      else state.descaleStep = Math.min(8, state.descaleStep + 1);
      updateDescaleGuideUI();
    });
  }
  if (el.btnDescaleResetSteps) {
    el.btnDescaleResetSteps.addEventListener('click', () => {
      state.descaleStep = 1;
      state.descaleDone = false;
      updateDescaleGuideUI();
    });
  }
  if (el.descaleSteps) {
    el.descaleSteps.forEach(stepEl => {
      stepEl.addEventListener('click', () => {
        state.descaleStep = parseInt(stepEl.dataset.step, 10);
        state.descaleDone = false;
        updateDescaleGuideUI();
      });
    });
  }

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

  // Manual Modal
  if (el.btnManual) el.btnManual.addEventListener('click', () => openManualModal('all', 1));
  if (el.btnOpenManualDescale) el.btnOpenManualDescale.addEventListener('click', () => openManualModal('descaling', 19));
  if (el.btnCloseManual) el.btnCloseManual.addEventListener('click', closeManualModal);
  if (el.btnManualModeReader) el.btnManualModeReader.addEventListener('click', () => setManualMode('reader'));
  if (el.btnManualModePdf) el.btnManualModePdf.addEventListener('click', () => setManualMode('pdf'));
  if (el.inputManualSearch) el.inputManualSearch.addEventListener('input', filterManualSections);
  if (el.manualJumpChips) {
    el.manualJumpChips.forEach(chip => {
      chip.addEventListener('click', () => {
        manualActiveSection = chip.dataset.sec || 'all';
        manualCurrentPage = parseInt(chip.dataset.page || '1', 10);
        if (el.inputManualSearch) el.inputManualSearch.value = '';
        el.manualJumpChips.forEach(c => c.classList.toggle('active-chip', c === chip));
        if (manualViewMode === 'pdf') setManualMode('pdf', manualCurrentPage);
        filterManualSections();
      });
    });
  }

  // Logs Drawer
  el.btnLogs.addEventListener('click', () => el.logsDrawer.classList.remove('hidden'));
  el.btnCloseLogs.addEventListener('click', () => el.logsDrawer.classList.add('hidden'));
  if (el.btnCopyLogs) {
    el.btnCopyLogs.addEventListener('click', copyLogsToClipboard);
  }
  el.btnClearLogs.addEventListener('click', () => {
    el.logConsole.innerHTML = '';
    logCount = 0;
    el.logCounter.textContent = '0 events';
  });

  [el.settingsModal, el.logsDrawer, el.manualModal].filter(Boolean).forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });
}

// 17. Service Worker Registration & Version Propagation
function applyAppVersion() {
  if (el.badgeAppVersion) el.badgeAppVersion.textContent = `v${APP_VERSION}`;
  if (el.initLogEntry) el.initLogEntry.textContent = `[System] Notpresso Expert v${APP_VERSION} ready to connect to EN 350.G`;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`, { updateViaCache: 'none' }).catch(() => {});
  }
}

let logoHoldInterval = null;
let logoHoldRemaining = 0;

async function forceAppCacheUpdate() {
  if (el.badgeAppVersion) el.badgeAppVersion.textContent = '↻ Updating...';
  if (el.logoHoldCountdown) el.logoHoldCountdown.textContent = '↻';
  showToast('Clearing app cache & Service Worker — reloading...');
  try {
    if ('serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistrations === 'function') {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (_) {}
  const basePath = (window.location && window.location.pathname) ? window.location.pathname : './';
  const targetUrl = `${basePath}?refresh=${Date.now()}`;
  if (window.location && typeof window.location.replace === 'function') {
    window.location.replace(targetUrl);
  } else if (window.location && typeof window.location.reload === 'function') {
    window.location.reload();
  }
}

function startLogoHoldRefresh(e) {
  if (e && e.button !== undefined && e.button !== 0) return;
  if (logoHoldInterval) clearInterval(logoHoldInterval);
  logoHoldRemaining = LOGO_HOLD_REFRESH_SEC;
  if (el.btnLogoRefresh) el.btnLogoRefresh.classList.add('is-holding');
  if (el.logoHoldCountdown) {
    el.logoHoldCountdown.textContent = `${LOGO_HOLD_REFRESH_SEC}s`;
    el.logoHoldCountdown.classList.remove('hidden');
  }
  if (el.badgeAppVersion) el.badgeAppVersion.textContent = `↻ ${LOGO_HOLD_REFRESH_SEC}s`;

  logoHoldInterval = setInterval(() => {
    logoHoldRemaining -= 1;
    if (logoHoldRemaining > 0) {
      if (el.logoHoldCountdown) el.logoHoldCountdown.textContent = `${logoHoldRemaining}s`;
      if (el.badgeAppVersion) el.badgeAppVersion.textContent = `↻ ${logoHoldRemaining}s`;
    } else {
      clearInterval(logoHoldInterval);
      logoHoldInterval = null;
      forceAppCacheUpdate();
    }
  }, 1000);
}

function cancelLogoHoldRefresh() {
  if (!logoHoldInterval) return;
  clearInterval(logoHoldInterval);
  logoHoldInterval = null;
  logoHoldRemaining = 0;
  if (el.btnLogoRefresh) el.btnLogoRefresh.classList.remove('is-holding');
  if (el.logoHoldCountdown) el.logoHoldCountdown.classList.add('hidden');
  if (el.badgeAppVersion) el.badgeAppVersion.textContent = `v${APP_VERSION}`;
}

function initLogoHoldRefresh() {
  if (!el.btnLogoRefresh) return;
  el.btnLogoRefresh.title = `Hold ${LOGO_HOLD_REFRESH_SEC}s to force app & cache update`;
  if (el.logoHoldCountdown) el.logoHoldCountdown.textContent = `${LOGO_HOLD_REFRESH_SEC}s`;
  el.btnLogoRefresh.addEventListener('contextmenu', (e) => e.preventDefault());
  el.btnLogoRefresh.addEventListener('pointerdown', startLogoHoldRefresh);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => {
    el.btnLogoRefresh.addEventListener(ev, cancelLogoHoldRefresh);
  });
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
  applyAppVersion();
  initLogoHoldRefresh();
  const hasSavedDial = loadMachineDialVolumes();
  if (!hasSavedDial) {
    applyDialProfile(DIAL_PROFILE_APP, el.btnProfileAppCalibration, '', false);
  }
  initListeners();
  loadSavedRecipes();
  renderLibrary();
  renderFavoritesOnHome();
  syncCustomRecipeUI();
  updateCupRangeHint();
  syncDialProfileChipUI();
  updateDescaleGuideUI();
  registerServiceWorker();
  log(`Notpresso Expert v${APP_VERSION} initialized (AuthKey: ${getStoredAuthKey()}).`, 'info');
});
