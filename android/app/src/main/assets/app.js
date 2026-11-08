/**
 * ============================================================================
 * Notpresso Expert - BLE Controller for Nespresso Expert EN 350.G
 * Supports BOTH:
 *   1. Native Android APK Bridge (window.AndroidBle on Samsung S24 Ultra OneUI 9)
 *   2. Web Bluetooth API (navigator.bluetooth fallback)
 *
 * Protocol Reverse-Engineered from Official Nespresso Android 3.28.0 APK
 * (classes3.dex PairingKey & classes5.dex com.nestle.connecteddevices.nespresso)
 *
 * Acknowledgments & Inspiration:
 * - Rosselman/barista-studio (UI architecture, theme aesthetic, CMID handshake)
 * - Peter Gullberg / brewbutton (01 10 recipe packets, custom ml extraction)
 * - Farmin Farzin / farminf (BLE packet reverse engineering & HCI snoop analysis)
 * - Florian Salomon / fsalomon (GATT profile mapping & JS implementation)
 * - Uri Shaked / urish (Web Bluetooth reverse engineering methodology)
 * - bulldog5046 (Home Assistant integration & 25-pairing EEPROM limit discovery)
 * ============================================================================
 */

const APP_VERSION = '0.2.0';

// 1. Bluetooth Low Energy UUID Definitions (Verified from classes5.dex)
const BLE_UUIDS = {
  // Services
  SERVICE_DEVICE_AUTH: '06aa1910-f22a-11e3-9daa-0002a5d5c51b', // MachineProperties / Auth / Onboarding
  SERVICE_STATUS_CTRL: '06aa1920-f22a-11e3-9daa-0002a5d5c51b', // BrewOperations / Monitoring / FactoryReset
  SERVICE_ERROR:       '06aa1930-f22a-11e3-9daa-0002a5d5c51b', // ErrorRetrieval
  SERVICE_CUP_SIZES:   '06aa1940-f22a-11e3-9daa-0002a5d5c51b', // CupSizeOperations

  // Service 06aa1910 Characteristics
  CHAR_MACHINE_INFO:   '06aa3a21-f22a-11e3-9daa-0002a5d5c51b', // Read 14 bytes (HW, Bootloader, MainFW, ConnFW, MAC)
  CHAR_SERIAL:         '06aa3a31-f22a-11e3-9daa-0002a5d5c51b', // Read 19 bytes US-ASCII Serial Number
  CHAR_AUTH:           '06aa3a41-f22a-11e3-9daa-0002a5d5c51b', // Write 8-byte PairingKey (MUST start with 0x8X)
  CHAR_AUTH_TYPE:      '06aa3a51-f22a-11e3-9daa-0002a5d5c51b', // Read 1 byte: 0/1 = ABSENT, 2 = PRESENT
  CHAR_TX_LEVEL:       '06aa3a61-f22a-11e3-9daa-0002a5d5c51b', // Write [0x01] (TxLevel.LOW_LEVEL) for onboarding

  // Service 06aa1920 Characteristics
  CHAR_MACHINE_STATUS: '06aa3a12-f22a-11e3-9daa-0002a5d5c51b', // Read / Notify 8 bytes
  CHAR_CAPSULES:       '06aa3a15-f22a-11e3-9daa-0002a5d5c51b', // Read / Notify 2 bytes
  CHAR_SLIDER:         '06aa3a22-f22a-11e3-9daa-0002a5d5c51b', // Read / Notify 1 byte: 0x00=Closed, 0x02=Open
  CHAR_SCHEDULE:       '06aa3a32-f22a-11e3-9daa-0002a5d5c51b', // Read 6 bytes programmed brew
  CHAR_COMMAND:        '06aa3a42-f22a-11e3-9daa-0002a5d5c51b', // Write Brew, Recipe, Cancel, FactoryReset
  CHAR_CMD_RESPONSE:   '06aa3a52-f22a-11e3-9daa-0002a5d5c51b', // Read / Notify up to 20 bytes CommandResponse

  // Service 06aa1940 Characteristics (Physical Dial Cup Size Programming)
  CHAR_CUP_TARGET:     '06aa3a14-f22a-11e3-9daa-0002a5d5c51b', // Write 2 bytes big-endian target (0..5)
  CHAR_CUP_VOLUME:     '06aa3a24-f22a-11e3-9daa-0002a5d5c51b', // Read / Write 4 bytes [volHi, volLo, 0xFF, 0xFF]
};

// Machine State Enums
const MACHINE_STATES = {
  0: { label: 'Standby', isBusy: false },
  1: { label: 'Ready', isBusy: false },
  2: { label: 'Brewing', isBusy: true },
  3: { label: 'Settings', isBusy: false },
  4: { label: 'Error', isBusy: false },
  5: { label: 'Overheated', isBusy: false },
  6: { label: 'First Setup', isBusy: false },
  7: { label: 'Paused', isBusy: false },
};

const DEFAULT_AUTH_KEY = '82C15F832A864437';

/**
 * Exact implementation of com.nespresso.mobile.core.bean.machine.PairingKey.getBufferFromByteArray(byte[])
 * from Nespresso 3.28.0 classes3.dex (codeOff=0x37bd98).
 *
 * Takes a 16-byte array (from a 32-char UUID/MD5 hex string), shifts nibbles right by 4 bits,
 * and forces the high nibble of byte 0 to 0x8 (0x80..0x8F).
 */
function nespressoBufferFrom16Bytes(raw16) {
  const out = new Uint8Array(8);
  out[0] = ((raw16[0] & 0xF0) >>> 4) | 0x80;
  for (let i = 1; i < 8; i++) {
    out[i] = ((raw16[i - 1] & 0x0F) << 4) | ((raw16[i] & 0xF0) >>> 4);
  }
  return out;
}

/**
 * Generates a brand-new valid 8-byte (16-hex-char) Nespresso BLE PairingKey
 * using the exact PairingKey.create() + getBufferFromByteArray() algorithm.
 */
function generateValidNespressoKeyHex() {
  const raw16 = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(raw16);
  } else {
    for (let i = 0; i < 16; i++) raw16[i] = Math.floor(Math.random() * 256);
  }
  const key8 = nespressoBufferFrom16Bytes(raw16);
  return Array.from(key8).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Normalizes a user-supplied key:
 * - If 32 hex chars (from Nespresso SQLite DB MyMachine.mPairingKey), converts via nespressoBufferFrom16Bytes().
 * - If 16 hex chars, ensures it is uppercase hex (and warns if high nibble != 8).
 */
function normalizeAuthKeyInput(rawInput) {
  const clean = (rawInput || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  if (clean.length === 32) {
    const raw16 = hexToBytes(clean);
    const key8 = nespressoBufferFrom16Bytes(raw16);
    const converted = Array.from(key8).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    log(`Converted 32-char Nespresso DB pairingKey -> 16-char BLE wire key: ${converted}`, 'info');
    return converted;
  }
  return clean;
}

// 2. Application State
const state = {
  isNativeAndroid: typeof window.AndroidBle !== 'undefined',
  device: null,
  server: null,
  isConnected: false,
  isScanning: false,

  // Cached Web Bluetooth GATT Characteristics
  charAuth: null,
  charCommand: null,
  charCmdResponse: null,
  charMachineStatus: null,
  charSlider: null,
  charAuthType: null,
  charTxLevel: null,
  charMachineInfo: null,
  charSerial: null,
  charCupTarget: null,
  charCupVolume: null,

  // Machine Telemetry
  machineState: 0,
  sliderOpen: false,
  pairingKeyStateByte: null, // 0/1 = ABSENT, 2 = PRESENT
  pairingState: '--',
  serialNumber: '--',
  firmwareVersion: '--',

  // Current Selections (Verified TemperatureConversion: 0=Medium, 1=Low/Warm, 2=High/VeryHot)
  selectedTemp: 0,
  customCoffeeMl: 40,
  customWaterMl: 80,
  customTemp: 0,
  customSequence: 'coffee-first',

  // Active Brew Tracking
  isBrewing: false,
  brewDurationSec: 30,
  brewStartTime: null,
  brewInterval: null,

  // Discovered Native BLE Devices
  discoveredDevices: new Map(),

  // Saved Custom Recipes
  savedRecipes: [],
};

// DOM Elements
const el = {
  envSubtitle: document.getElementById('envSubtitle'),
  btnConnect: document.getElementById('btnConnect'),
  btnConnectText: document.getElementById('btnConnectText'),
  connDot: document.getElementById('connDot'),
  connStatusText: document.getElementById('connStatusText'),
  deviceSubtext: document.getElementById('deviceSubtext'),
  telemetryRow: document.getElementById('telemetryRow'),
  chipMachineState: document.getElementById('chipMachineState'),
  chipSliderState: document.getElementById('chipSliderState'),
  chipPairingState: document.getElementById('chipPairingState'),

  // Tabs
  navTabs: document.querySelectorAll('.nav-tab'),
  tabPanes: document.querySelectorAll('.tab-pane'),

  // Presets & Temperature
  tempButtons: document.querySelectorAll('.temp-btn'),
  drinkCards: document.querySelectorAll('.drink-card'),

  // Custom Recipe
  tempButtonsCustom: document.querySelectorAll('.temp-btn-custom'),
  seqButtonsCustom: document.querySelectorAll('.seq-btn-custom'),
  sliderCoffeeMl: document.getElementById('sliderCoffeeMl'),
  sliderWaterMl: document.getElementById('sliderWaterMl'),
  valCoffeeMl: document.getElementById('valCoffeeMl'),
  valWaterMl: document.getElementById('valWaterMl'),
  valTotalMl: document.getElementById('valTotalMl'),
  valRatio: document.getElementById('valRatio'),
  btnBrewCustom: document.getElementById('btnBrewCustom'),
  btnSaveCustom: document.getElementById('btnSaveCustom'),

  // Machine & Dial Tab
  selectCupTarget: document.getElementById('selectCupTarget'),
  inputCupVolume: document.getElementById('inputCupVolume'),
  valCupTargetMl: document.getElementById('valCupTargetMl'),
  btnReadCupSize: document.getElementById('btnReadCupSize'),
  btnWriteCupSize: document.getElementById('btnWriteCupSize'),
  valSerial: document.getElementById('valSerial'),
  valFirmware: document.getElementById('valFirmware'),
  btnOpenOnboarding: document.getElementById('btnOpenOnboarding'),
  btnBleFactoryReset: document.getElementById('btnBleFactoryReset'),

  // Library
  libraryList: document.getElementById('libraryList'),
  libraryCount: document.getElementById('libraryCount'),

  // Modals & Panels
  brewModal: document.getElementById('brewModal'),
  brewModalTitle: document.getElementById('brewModalTitle'),
  brewModalSub: document.getElementById('brewModalSub'),
  brewProgressBar: document.getElementById('brewProgressBar'),
  btnStopBrew: document.getElementById('btnStopBrew'),

  btnSettings: document.getElementById('btnSettings'),
  settingsModal: document.getElementById('settingsModal'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  inputAuthKey: document.getElementById('inputAuthKey'),
  authKeyHint: document.getElementById('authKeyHint'),
  btnSaveAuthKey: document.getElementById('btnSaveAuthKey'),
  btnPairNewDevice: document.getElementById('btnPairNewDevice'),

  scannerModal: document.getElementById('scannerModal'),
  btnCloseScanner: document.getElementById('btnCloseScanner'),
  scannerStatusText: document.getElementById('scannerStatusText'),
  scannerDeviceList: document.getElementById('scannerDeviceList'),
  btnRescanBle: document.getElementById('btnRescanBle'),

  btnLogs: document.getElementById('btnLogs'),
  logsDrawer: document.getElementById('logsDrawer'),
  btnCloseLogs: document.getElementById('btnCloseLogs'),
  logConsole: document.getElementById('logConsole'),
  btnClearLogs: document.getElementById('btnClearLogs'),
  logCounter: document.getElementById('logCounter'),

  toast: document.getElementById('toast'),
};

// 3. Storage & Timing Utilities
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function safeWriteValue(characteristic, data) {
  if (!characteristic) throw new Error('Characteristic is null');
  if (characteristic.writeValueWithResponse) {
    try {
      await characteristic.writeValueWithResponse(data);
      return;
    } catch (_) {}
  }
  await characteristic.writeValue(data);
}

function getStoredAuthKey() {
  const k = localStorage.getItem('notpresso_auth_key');
  return (k && k.trim().length === 16) ? k.trim().toUpperCase() : DEFAULT_AUTH_KEY;
}

function setStoredAuthKey(key) {
  const clean = normalizeAuthKeyInput(key);
  if (clean.length === 16) {
    localStorage.setItem('notpresso_auth_key', clean);
    if (state.isNativeAndroid && window.AndroidBle.setAuthKey) {
      window.AndroidBle.setAuthKey(clean);
    }
  }
  return clean;
}

function loadSavedRecipes() {
  const raw = localStorage.getItem('notpresso_saved_recipes');
  if (raw) {
    try {
      state.savedRecipes = JSON.parse(raw);
    } catch (_) {
      state.savedRecipes = [];
    }
  } else {
    state.savedRecipes = [
      { id: '1', name: 'Morning Wakeup Lungo', coffeeMl: 60, waterMl: 70, temp: 2, seq: 'coffee-first' },
      { id: '2', name: 'Barista Long Black', coffeeMl: 40, waterMl: 100, temp: 0, seq: 'water-first' },
      { id: '3', name: 'Intense Double Ristretto', coffeeMl: 50, waterMl: 0, temp: 0, seq: 'coffee-first' }
    ];
    persistSavedRecipes();
  }
}

function persistSavedRecipes() {
  localStorage.setItem('notpresso_saved_recipes', JSON.stringify(state.savedRecipes));
}

// 4. Logging & UI Feedback
let logCount = 0;
function log(msg, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${time}] ${msg}`;
  el.logConsole.appendChild(entry);
  el.logConsole.scrollTop = el.logConsole.scrollHeight;
  logCount++;
  el.logCounter.textContent = `${logCount} events`;
  console.log(`[Notpresso] ${msg}`);
}

function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.toast.classList.add('hidden');
  }, 3400);
}

// 5. Unified BLE Write / Read Abstraction (Supports Native Android APK + Web Bluetooth)
async function writeBleCharacteristic(uuid, uint8Array) {
  const hex = bytesToHexNoSpaces(uint8Array);
  if (state.isNativeAndroid) {
    const ok = window.AndroidBle.writeCharacteristic(uuid, hex);
    if (!ok) throw new Error(`Native GATT write queue failed for ${uuid}`);
    await sleep(180);
    return;
  }
  const ch = getWebCharacteristic(uuid);
  if (!ch) throw new Error(`Characteristic ${uuid} not available`);
  await safeWriteValue(ch, uint8Array);
}

async function readBleCharacteristic(uuid) {
  if (state.isNativeAndroid) {
    const hex = window.AndroidBle.readCharacteristicSync(uuid);
    if (!hex) return null;
    return hexToBytes(hex);
  }
  const ch = getWebCharacteristic(uuid);
  if (!ch) return null;
  const dv = await ch.readValue();
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

function getWebCharacteristic(uuid) {
  switch (uuid) {
    case BLE_UUIDS.CHAR_AUTH: return state.charAuth;
    case BLE_UUIDS.CHAR_COMMAND: return state.charCommand;
    case BLE_UUIDS.CHAR_CMD_RESPONSE: return state.charCmdResponse;
    case BLE_UUIDS.CHAR_MACHINE_STATUS: return state.charMachineStatus;
    case BLE_UUIDS.CHAR_SLIDER: return state.charSlider;
    case BLE_UUIDS.CHAR_AUTH_TYPE: return state.charAuthType;
    case BLE_UUIDS.CHAR_TX_LEVEL: return state.charTxLevel;
    case BLE_UUIDS.CHAR_MACHINE_INFO: return state.charMachineInfo;
    case BLE_UUIDS.CHAR_SERIAL: return state.charSerial;
    case BLE_UUIDS.CHAR_CUP_TARGET: return state.charCupTarget;
    case BLE_UUIDS.CHAR_CUP_VOLUME: return state.charCupVolume;
    default: return null;
  }
}

// 6. Native Android Bridge Callbacks (Invoked from MainActivity.java on UI Thread)
window.onNativeBleEvent = function(eventType, payloadJson) {
  try {
    const data = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    switch (eventType) {
      case 'log':
        log(data.msg, data.level || 'info');
        break;
      case 'toast':
        showToast(data.msg);
        break;
      case 'scanResult':
        handleNativeScanResult(data);
        break;
      case 'connected':
        state.isConnected = true;
        state.isScanning = false;
        state.device = { name: data.name || data.address };
        el.scannerModal.classList.add('hidden');
        updateConnectionUI();
        showToast(`Connected to ${data.name || data.address}`);
        break;
      case 'disconnected':
        onDisconnected();
        break;
      case 'charChanged':
        handleRawCharacteristicBytes(data.uuid.toLowerCase(), hexToBytes(data.hex));
        break;
      case 'keyGenerated':
        setStoredAuthKey(data.key);
        el.inputAuthKey.value = data.key;
        showToast(`Paired with new key: ${data.key}`);
        break;
    }
  } catch (e) {
    console.error('onNativeBleEvent error:', e);
  }
};

function handleNativeScanResult(dev) {
  state.discoveredDevices.set(dev.address, dev);
  renderScannerDeviceList();
}

function renderScannerDeviceList() {
  el.scannerDeviceList.innerHTML = '';
  if (state.discoveredDevices.size === 0) {
    el.scannerDeviceList.innerHTML = '<div class="alert alert-warning">Searching for Expert EN 350.G... Make sure the machine is plugged in and awake.</div>';
    return;
  }
  state.discoveredDevices.forEach((dev) => {
    const item = document.createElement('div');
    item.className = 'recipe-item';
    const badge = dev.bonded ? 'Bonded' : `${dev.rssi || '--'} dBm`;
    item.innerHTML = `
      <div>
        <div class="recipe-meta-name">☕ ${escapeHtml(dev.name || 'Nespresso Expert')}</div>
        <div class="recipe-meta-details">${escapeHtml(dev.address)} • ${badge}</div>
      </div>
      <div class="recipe-actions">
        <button class="btn btn-connect" data-addr="${escapeHtml(dev.address)}">Connect</button>
      </div>
    `;
    item.querySelector('button').addEventListener('click', () => {
      el.scannerStatusText.textContent = `Connecting to ${dev.name || dev.address}...`;
      window.AndroidBle.connectDevice(dev.address, getStoredAuthKey());
    });
    el.scannerDeviceList.appendChild(item);
  });
}

// 7. Bluetooth Connection & Onboarding Handshake
async function connectBle() {
  if (state.isConnected) {
    await disconnectBle();
    return;
  }

  // Native Android APK path
  if (state.isNativeAndroid) {
    state.discoveredDevices.clear();
    renderScannerDeviceList();
    el.scannerStatusText.textContent = 'Scanning via Android Native BluetoothLeScanner...';
    el.scannerModal.classList.remove('hidden');
    state.isScanning = true;
    updateConnectionUI();
    window.AndroidBle.startScan();
    return;
  }

  // Web Bluetooth fallback path
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not supported in this browser. Install the standalone Notpresso Android APK or use Chrome on Android.');
    log('Web Bluetooth unsupported.', 'err');
    return;
  }

  try {
    state.isScanning = true;
    updateConnectionUI();
    log('Opening Bluetooth discovery dialog...');

    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'Expert' },
        { namePrefix: 'Prodigio' },
        { namePrefix: 'Nespresso' },
        { namePrefix: 'EN350' },
        { namePrefix: 'EN 350' },
      ],
      optionalServices: [
        BLE_UUIDS.SERVICE_DEVICE_AUTH,
        BLE_UUIDS.SERVICE_STATUS_CTRL,
        BLE_UUIDS.SERVICE_ERROR,
        BLE_UUIDS.SERVICE_CUP_SIZES,
      ]
    });

    state.device = device;
    log(`Selected peripheral: ${device.name || device.id}`, 'info');
    device.addEventListener('gattserverdisconnected', onDisconnected);

    log('Connecting to GATT server...');
    const server = await device.gatt.connect();
    state.server = server;
    log('Connected to GATT. Discovering services...', 'info');

    const authService = await server.getPrimaryService(BLE_UUIDS.SERVICE_DEVICE_AUTH);
    const ctrlService = await server.getPrimaryService(BLE_UUIDS.SERVICE_STATUS_CTRL);

    state.charAuth = await authService.getCharacteristic(BLE_UUIDS.CHAR_AUTH);
    state.charCommand = await ctrlService.getCharacteristic(BLE_UUIDS.CHAR_COMMAND);

    try { state.charAuthType = await authService.getCharacteristic(BLE_UUIDS.CHAR_AUTH_TYPE); } catch (_) {}
    try { state.charTxLevel = await authService.getCharacteristic(BLE_UUIDS.CHAR_TX_LEVEL); } catch (_) {}
    try { state.charMachineInfo = await authService.getCharacteristic(BLE_UUIDS.CHAR_MACHINE_INFO); } catch (_) {}
    try { state.charSerial = await authService.getCharacteristic(BLE_UUIDS.CHAR_SERIAL); } catch (_) {}

    try { state.charMachineStatus = await ctrlService.getCharacteristic(BLE_UUIDS.CHAR_MACHINE_STATUS); } catch (_) {}
    try { state.charSlider = await ctrlService.getCharacteristic(BLE_UUIDS.CHAR_SLIDER); } catch (_) {}
    try { state.charCmdResponse = await ctrlService.getCharacteristic(BLE_UUIDS.CHAR_CMD_RESPONSE); } catch (_) {}

    try {
      const cupService = await server.getPrimaryService(BLE_UUIDS.SERVICE_CUP_SIZES);
      state.charCupTarget = await cupService.getCharacteristic(BLE_UUIDS.CHAR_CUP_TARGET);
      state.charCupVolume = await cupService.getCharacteristic(BLE_UUIDS.CHAR_CUP_VOLUME);
    } catch (_) {}

    // Subscribe to Status notifications before handshake so CCCD is open
    if (state.charMachineStatus) {
      try {
        await state.charMachineStatus.startNotifications();
        state.charMachineStatus.addEventListener('characteristicvaluechanged', e => {
          handleRawCharacteristicBytes(BLE_UUIDS.CHAR_MACHINE_STATUS, new Uint8Array(e.target.value.buffer));
        });
        log('Active Machine Status notifications enabled.', 'rx');
      } catch (subErr) {
        log(`Status notifications subscription note: ${subErr.message}`, 'warn');
      }
    }

    log('GATT Characteristics cached. Initializing Authentication & Handshake...', 'info');
    await performAuthHandshake(false);

    if (state.charSlider) {
      try {
        await state.charSlider.startNotifications();
        state.charSlider.addEventListener('characteristicvaluechanged', e => {
          handleRawCharacteristicBytes(BLE_UUIDS.CHAR_SLIDER, new Uint8Array(e.target.value.buffer));
        });
        const sl = await readBleCharacteristic(BLE_UUIDS.CHAR_SLIDER);
        if (sl) handleRawCharacteristicBytes(BLE_UUIDS.CHAR_SLIDER, sl);
      } catch (_) {}
    }

    if (state.charCmdResponse) {
      try {
        await state.charCmdResponse.startNotifications();
        state.charCmdResponse.addEventListener('characteristicvaluechanged', e => {
          handleRawCharacteristicBytes(BLE_UUIDS.CHAR_CMD_RESPONSE, new Uint8Array(e.target.value.buffer));
        });
      } catch (_) {}
    }

    // Read Serial & Firmware info
    try {
      const ser = await readBleCharacteristic(BLE_UUIDS.CHAR_SERIAL);
      if (ser) handleRawCharacteristicBytes(BLE_UUIDS.CHAR_SERIAL, ser);
      const info = await readBleCharacteristic(BLE_UUIDS.CHAR_MACHINE_INFO);
      if (info) handleRawCharacteristicBytes(BLE_UUIDS.CHAR_MACHINE_INFO, info);
    } catch (_) {}

    state.isConnected = true;
    state.isScanning = false;
    updateConnectionUI();
    showToast('Connected to Nespresso Expert!');
  } catch (err) {
    state.isScanning = false;
    log(`Connection failed: ${err.message}`, 'err');
    if (err.message && (err.message.includes('disconnected') || err.message.includes('GATT'))) {
      log('Pairing tip: If this is the first time connecting, put machine in pairing mode: Machine Off -> Hold Brew button 6s (dials flash) -> Turn dial to Lungo -> Press Brew button once (Lungo flashes).', 'warn');
    }
    updateConnectionUI();
    showToast(`Error: ${err.message}`);
  }
}

/**
 * Implements exact AuthenticationAdapter.lambda$buildNewAuthenticate$4 (classes5.dex, codeOff=0x31c178)
 * and OnboardingAdapter.pair (classes5.dex, codeOff=0x31d55c).
 */
async function performAuthHandshake(forceGenerateNewKey = false) {
  // 1. Read PairingKeyState from 06aa3a51 (0/1 = ABSENT, 2 = PRESENT)
  let keyState = null;
  try {
    const stateBytes = await readBleCharacteristic(BLE_UUIDS.CHAR_AUTH_TYPE);
    if (stateBytes && stateBytes.length >= 1) {
      keyState = stateBytes[0];
      state.pairingKeyStateByte = keyState;
      const label = (keyState === 2) ? 'PRESENT (2 - Paired)' : `ABSENT (${keyState} - Unpaired)`;
      log(`[06aa3a51] PairingKeyState = ${label}`, 'rx');
      el.chipPairingState.textContent = (keyState === 2) ? 'PAIRED (2)' : `UNPAIRED (${keyState})`;
    }
  } catch (e) {
    log(`Initial PairingKeyState read note: ${e.message}`, 'warn');
  }

  let authKeyHex = getStoredAuthKey();

  // Check initial pairing state via status char as well
  let isFinalPairing = (keyState === 2 && !forceGenerateNewKey);
  if (state.charMachineStatus && keyState === null) {
    try {
      const statusBytes = await readBleCharacteristic(BLE_UUIDS.CHAR_MACHINE_STATUS);
      if (statusBytes && statusBytes.length >= 1) {
        const pairingCode = (statusBytes[0] & 0x60) >> 5;
        log(`Machine initial pairing status: ${pairingCode} (0=None, 1=Temp, 2=Final)`, 'info');
        if (pairingCode === 2 && !forceGenerateNewKey) {
          isFinalPairing = true;
        }
      }
    } catch (e) {
      log(`Initial status read note: ${e.message}`, 'warn');
    }
  }

  // If machine has NO key stored (ABSENT: 0 or 1) or user requested new pairing:
  if (!isFinalPairing || keyState === 0 || keyState === 1 || forceGenerateNewKey) {
    if (keyState === 2 && forceGenerateNewKey) {
      log('Notice: Machine PairingKeyState is 2 (PRESENT). If the machine rejects the new key, perform the 10-second physical factory reset first!', 'warn');
    }
    if (forceGenerateNewKey || ((keyState === 0 || keyState === 1) && authKeyHex === DEFAULT_AUTH_KEY)) {
      authKeyHex = generateValidNespressoKeyHex();
      setStoredAuthKey(authKeyHex);
      el.inputAuthKey.value = authKeyHex;
      log(`Generated new 0x8X PairingKey via PairingKey.getBufferFromByteArray: ${authKeyHex}`, 'info');
    }

    // Step A of OnboardingAdapter.pair: write [0x01] (TxLevel.LOW_LEVEL) to 06aa3a61
    log('Writing TX Level Request [0x01] to 06aa3a61 for pairing...', 'tx');
    try {
      await writeBleCharacteristic(BLE_UUIDS.CHAR_TX_LEVEL, new Uint8Array([0x01]));
      await sleep(200);
    } catch (e) {
      log(`TX Level write note: ${e.message}`, 'warn');
    }
  }

  const authBytes = hexToBytes(authKeyHex);
  if (authBytes.length === 8) {
    // Ensure high nibble is 0x8 (0x80..0x8F) per PairingKey.getBufferFromByteArray
    authBytes[0] = (authBytes[0] & 0x0F) | 0x80;
  }

  log(`Writing 8-byte Credentials to 06aa3a41: ${bytesToHex(authBytes)}`, 'tx');
  await writeBleCharacteristic(BLE_UUIDS.CHAR_AUTH, authBytes);
  log('Auth Key written to machine.', 'info');
  await sleep(200);

  // Verify PairingKeyState after writing key
  try {
    const verifyBytes = await readBleCharacteristic(BLE_UUIDS.CHAR_AUTH_TYPE);
    if (verifyBytes && verifyBytes.length >= 1) {
      const code = verifyBytes[0];
      state.pairingKeyStateByte = code;
      log(`[06aa3a51] Post-auth PairingKeyState: ${code === 2 ? '2 (PRESENT / Authenticated)' : code}`, 'rx');
      el.chipPairingState.textContent = (code === 2) ? 'AUTH OK (2)' : `STATE ${code}`;
    }
  } catch (authTypeErr) {
    log(`Auth Type check note: ${authTypeErr.message}`, 'warn');
  }

  // Read current machine status to initialize UI state
  try {
    const initialVal = await readBleCharacteristic(BLE_UUIDS.CHAR_MACHINE_STATUS);
    if (initialVal) handleRawCharacteristicBytes(BLE_UUIDS.CHAR_MACHINE_STATUS, initialVal);
  } catch (_) {}
}

function handleRawCharacteristicBytes(uuid, bytes) {
  if (!bytes || bytes.length === 0) return;

  if (uuid === BLE_UUIDS.CHAR_MACHINE_STATUS && bytes.length >= 2) {
    const b0 = bytes[0];
    const b1 = bytes[1];
    const stateCode = b1 & 0x0F;
    const mState = MACHINE_STATES[stateCode] || { label: `State ${stateCode}`, isBusy: false };
    state.machineState = stateCode;

    // Decode warning bits from bytes[0..3]
    const warnings = [];
    if (b0 & 0x01) warnings.push('Water Empty');
    if (b0 & 0x04) warnings.push('Descale Needed');
    if (b0 & 0x20) warnings.push('Capsule Full');

    const statusLabel = warnings.length > 0 ? `${mState.label} (${warnings.join(', ')})` : mState.label;
    el.chipMachineState.textContent = statusLabel;
    log(`[06aa3a12 Status] ${bytesToHex(bytes)} -> ${statusLabel}`, 'rx');

    if (mState.isBusy && !state.isBrewing) {
      startBrewTracking('Extraction in Progress', 30);
    } else if (!mState.isBusy && state.isBrewing) {
      finishBrewTracking();
    }
  } else if (uuid === BLE_UUIDS.CHAR_SLIDER) {
    const isOpen = bytes[0] !== 0;
    state.sliderOpen = isOpen;
    el.chipSliderState.textContent = isOpen ? 'Open' : 'Closed';
    log(`[06aa3a22 Slider] ${isOpen ? 'OPEN (Insert Capsule)' : 'CLOSED (Ready)'}`, 'rx');
  } else if (uuid === BLE_UUIDS.CHAR_AUTH_TYPE) {
    const code = bytes[0];
    state.pairingKeyStateByte = code;
    el.chipPairingState.textContent = (code === 2) ? 'PAIRED (2)' : `UNPAIRED (${code})`;
    log(`[06aa3a51 PairingKeyState] ${code} (${code === 2 ? 'PRESENT' : 'ABSENT'})`, 'rx');
  } else if (uuid === BLE_UUIDS.CHAR_CMD_RESPONSE) {
    decodeCommandResponse(bytes);
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
  } else if (uuid === BLE_UUIDS.CHAR_CUP_VOLUME && bytes.length >= 2) {
    const vol = ((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF);
    if (vol > 0 && vol <= 500) {
      el.inputCupVolume.value = vol;
      el.valCupTargetMl.textContent = `${vol} ml`;
      showToast(`Dial volume read: ${vol} ml`);
    }
    log(`[06aa3a24 CupVolume] ${vol} ml (${bytesToHex(bytes)})`, 'rx');
  }
}

/**
 * Decodes 06aa3a52 CommandResponse according to CommandResponseBuilder (classes5.dex, codeOff=0x321254)
 */
function decodeCommandResponse(bytes) {
  const hex = bytesToHex(bytes);
  const b0 = bytes[0];
  if ((b0 & 0xC0) === 0x80 || (b0 & 0xF0) === 0x80) {
    log(`[06aa3a52 CommandResponse] OK / DONE (${hex})`, 'rx');
  } else if ((b0 & 0xC0) === 0xC0 && bytes.length >= 4) {
    const errHi = bytes[2];
    const errLo = bytes[3];
    let reason = `Code ${errHi.toString(16)}:${errLo.toString(16)}`;
    if (errHi === 0x24 && errLo === 0x03) reason = 'Slider is OPEN — please close the slider!';
    else if (errHi === 0x24 && errLo === 0x06) reason = 'Capsule not changed — open & close slider to insert a fresh capsule!';
    else if (errHi === 0x24 && errLo === 0x02) reason = 'Capsule container is full!';
    else if (errHi === 0x24 && errLo === 0x07) reason = 'Descaling lockout active!';
    log(`[06aa3a52 Command Rejected] ${reason} (${hex})`, 'err');
    showToast(reason);
  } else {
    log(`[06aa3a52 CommandResponse] ${hex}`, 'rx');
  }
}

async function disconnectBle() {
  if (state.isNativeAndroid) {
    window.AndroidBle.disconnect();
    onDisconnected();
    return;
  }
  if (state.device && state.device.gatt.connected) {
    log('Disconnecting from machine...', 'info');
    state.device.gatt.disconnect();
  }
  onDisconnected();
}

function onDisconnected() {
  state.isConnected = false;
  state.isScanning = false;
  state.charAuth = null;
  state.charCommand = null;
  state.charMachineStatus = null;
  updateConnectionUI();
  log('Disconnected from device.', 'warn');
}

function updateConnectionUI() {
  if (state.isConnected) {
    el.connDot.className = 'status-dot connected';
    el.connStatusText.textContent = state.device ? (state.device.name || 'Connected') : 'Connected';
    el.deviceSubtext.textContent = state.isNativeAndroid ? 'Native Android GATT Connected' : 'Web Bluetooth GATT Connected';
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

// 8. Brew Command Dispatchers (Verified from BrewByteConversion & BrewOperationsAdapter in classes5.dex)
async function brewPreset(drinkName, sizeCode, tempCode) {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }

  // BrewByteConversion.getProgrammedBrewPayload: [0x03, 0x05, 0x07, 0x04, 0x00, 0x00, 0x00, 0x00, tempByte, drinkByte]
  const payload = new Uint8Array([
    0x03, 0x05, 0x07, 0x04,
    0x00, 0x00, 0x00, 0x00,
    tempCode & 0xFF,
    sizeCode & 0xFF
  ]);

  log(`Triggering ${drinkName} (Drink: 0x0${sizeCode}, Temp: 0x0${tempCode}): ${bytesToHex(payload)}`, 'tx');

  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, payload);
    log('Brew command sent successfully!', 'info');
    startBrewTracking(`Brewing ${drinkName}`, calculateBrewDuration(sizeCode));
  } catch (err) {
    log(`Failed to trigger brew: ${err.message}`, 'err');
    showToast(`Brew error: ${err.message}`);
  }
}

async function brewCustomRecipe(coffeeMl, waterMl, tempCode, sequence = 'coffee-first') {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }

  const coffeeHi = (coffeeMl >> 8) & 0xFF;
  const coffeeLo = coffeeMl & 0xFF;
  const waterHi = (waterMl >> 8) & 0xFF;
  const waterLo = waterMl & 0xFF;

  // BrewByteConversion.getSetRecipePayload (classes5.dex, codeOff=0x31fe50):
  // [0x01, 0x10, 0x08, 0x00, 0x00, ing1Type, ing1Hi, ing1Lo, ing2Type, ing2Hi, ing2Lo]
  // Ingredient: 0x01 = COFFEE, 0x02 = WATER
  const recipePayload = (sequence === 'water-first' && waterMl > 0)
    ? new Uint8Array([0x01, 0x10, 0x08, 0x00, 0x00, 0x02, waterHi, waterLo, 0x01, coffeeHi, coffeeLo])
    : new Uint8Array([0x01, 0x10, 0x08, 0x00, 0x00, 0x01, coffeeHi, coffeeLo, 0x02, waterHi, waterLo]);

  log(`Step 1 (writeRecipe): [Coffee ${coffeeMl}ml, Water ${waterMl}ml, ${sequence}]: ${bytesToHex(recipePayload)}`, 'tx');

  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, recipePayload);
    await sleep(250);

    // Step 2 (writeBrewWithTemperatureNow): Drink byte 0x07 = Custom Recipe
    const execPayload = new Uint8Array([
      0x03, 0x05, 0x07, 0x04,
      0x00, 0x00, 0x00, 0x00,
      tempCode & 0xFF,
      0x07
    ]);

    log(`Step 2 (writeBrewNow 0x07): ${bytesToHex(execPayload)}`, 'tx');
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, execPayload);

    const estDuration = Math.max(20, Math.round((coffeeMl + waterMl) * 0.35));
    startBrewTracking(`Brewing Custom (${coffeeMl}ml + ${waterMl}ml)`, estDuration);
  } catch (err) {
    log(`Custom recipe error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

/**
 * Verified from BrewOperationsAdapter.ABORT_ACTION_PAYLOAD (classes5.dex, codeOff=0x31dfdc):
 * 4 bytes: [0x03, 0x06, 0x01, 0x02]
 */
async function emergencyStop() {
  const stopPayload = new Uint8Array([0x03, 0x06, 0x01, 0x02]);
  log(`Sending Abort Brew (ABORT_ACTION_PAYLOAD): ${bytesToHex(stopPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_COMMAND, stopPayload);
    finishBrewTracking();
    showToast('Brewing cancelled.');
  } catch (err) {
    log(`Cancel error: ${err.message}`, 'err');
  }
}

/**
 * Verified from FactoryResetAdapter.PAYLOAD (classes5.dex, codeOff=0x31cc90):
 * 3 bytes: [0x03, 0x07, 0x00] written to 06aa3a42
 */
async function sendBleFactoryReset() {
  if (!state.isConnected) {
    showToast('Connect to the machine first (or use the physical dial reset in Settings).');
    return;
  }
  if (!confirm('Send BLE Factory Reset [03 07 00] to the Nespresso Expert? This clears the stored pairing key and resets cup volumes to factory defaults.')) {
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

/**
 * Verified from CupSizeOperationsAdapter (classes5.dex, codeOff=0x31e640):
 * Service 06aa1940:
 *   1. Write 2-byte big-endian target index (0..5) to 06aa3a14
 *   2. Read or Write 4 bytes [volHi, volLo, 0xFF, 0xFF] on 06aa3a24
 */
async function readDialCupSize() {
  if (!state.isConnected) {
    showToast('Please connect to the machine first!');
    return;
  }
  const targetIdx = parseInt(el.selectCupTarget.value, 10);
  const targetPayload = new Uint8Array([(targetIdx >> 8) & 0xFF, targetIdx & 0xFF]);
  log(`Selecting Cup Size Target ${targetIdx} on 06aa3a14: ${bytesToHex(targetPayload)}`, 'tx');
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

  log(`Programming Dial Target ${targetIdx} -> ${volMl} ml: target=${bytesToHex(targetPayload)}, vol=${bytesToHex(volPayload)}`, 'tx');
  try {
    await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_TARGET, targetPayload);
    await sleep(200);
    await writeBleCharacteristic(BLE_UUIDS.CHAR_CUP_VOLUME, volPayload);
    showToast(`Saved ${volMl} ml to dial position!`);
  } catch (err) {
    log(`Cup size write error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

// 9. Brewing Progress Overlay Tracking
function startBrewTracking(title, durationSec) {
  state.isBrewing = true;
  state.brewDurationSec = durationSec;
  state.brewStartTime = Date.now();

  el.brewModalTitle.textContent = title;
  el.brewModal.classList.remove('hidden');
  el.brewProgressBar.style.width = '0%';

  clearInterval(state.brewInterval);
  state.brewInterval = setInterval(() => {
    const elapsedSec = (Date.now() - state.brewStartTime) / 1000;
    const progress = Math.min(100, Math.round((elapsedSec / state.brewDurationSec) * 100));
    el.brewProgressBar.style.width = `${progress}%`;

    if (elapsedSec >= state.brewDurationSec) {
      finishBrewTracking();
    }
  }, 250);
}

function finishBrewTracking() {
  state.isBrewing = false;
  clearInterval(state.brewInterval);
  el.brewProgressBar.style.width = '100%';
  setTimeout(() => {
    el.brewModal.classList.add('hidden');
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

// 10. Custom Recipe Builder UI Updates
function updateCustomRecipeSummary() {
  const coffee = parseInt(el.sliderCoffeeMl.value, 10);
  const water = parseInt(el.sliderWaterMl.value, 10);
  state.customCoffeeMl = coffee;
  state.customWaterMl = water;

  el.valCoffeeMl.textContent = `${coffee} ml`;
  el.valWaterMl.textContent = `${water} ml`;

  const total = coffee + water;
  el.valTotalMl.textContent = `${total} ml`;

  if (water === 0) {
    el.valRatio.textContent = 'Pure Espresso';
  } else {
    const ratio = (water / coffee).toFixed(1);
    el.valRatio.textContent = `1 : ${ratio}`;
  }
}

// 11. Saved Recipes Library UI
function renderLibrary() {
  el.libraryList.innerHTML = '';
  el.libraryCount.textContent = `${state.savedRecipes.length} items`;

  if (state.savedRecipes.length === 0) {
    el.libraryList.innerHTML = '<div class="alert alert-warning">No saved recipes. Craft one in the Custom tab!</div>';
    return;
  }

  state.savedRecipes.forEach((recipe, idx) => {
    const item = document.createElement('div');
    item.className = 'recipe-item';

    const tempLabel = recipe.temp === 2 ? 'Very Hot (90°)' : (recipe.temp === 1 ? 'Warm (80°)' : 'Medium (85°)');
    const seqLabel = recipe.seq === 'water-first' ? 'Water→Coffee' : 'Coffee→Water';
    const totalMl = recipe.coffeeMl + recipe.waterMl;

    item.innerHTML = `
      <div>
        <div class="recipe-meta-name">${escapeHtml(recipe.name)}</div>
        <div class="recipe-meta-details">${recipe.coffeeMl}ml coffee + ${recipe.waterMl}ml water (${totalMl}ml) • ${tempLabel} • ${seqLabel}</div>
      </div>
      <div class="recipe-actions">
        <button class="btn btn-connect btn-brew-saved" data-idx="${idx}">Brew</button>
        <button class="icon-btn btn-del-saved" data-idx="${idx}" title="Delete">🗑️</button>
      </div>
    `;

    el.libraryList.appendChild(item);
  });

  document.querySelectorAll('.btn-brew-saved').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const r = state.savedRecipes[idx];
      if (r) brewCustomRecipe(r.coffeeMl, r.waterMl, r.temp, r.seq || 'coffee-first');
    });
  });

  document.querySelectorAll('.btn-del-saved').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      state.savedRecipes.splice(idx, 1);
      persistSavedRecipes();
      renderLibrary();
      showToast('Recipe deleted');
    });
  });
}

function saveCurrentCustomRecipe() {
  const name = prompt('Enter a name for this recipe:', 'My Custom Brew');
  if (!name || !name.trim()) return;

  const newRecipe = {
    id: Date.now().toString(),
    name: name.trim(),
    coffeeMl: state.customCoffeeMl,
    waterMl: state.customWaterMl,
    temp: state.customTemp,
    seq: state.customSequence
  };

  state.savedRecipes.unshift(newRecipe);
  persistSavedRecipes();
  renderLibrary();
  showToast(`Saved "${newRecipe.name}"`);
}

// 12. Helper Functions
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

// 13. Event Listeners Initialization
function initListeners() {
  if (state.isNativeAndroid) {
    el.envSubtitle.textContent = 'EN 350.G Native Android APK (OneUI 9)';
    window.AndroidBle.setAuthKey(getStoredAuthKey());
  }

  el.btnConnect.addEventListener('click', connectBle);

  // Tabs
  el.navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      el.navTabs.forEach(t => t.classList.remove('active'));
      el.tabPanes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.dataset.tab;
      document.getElementById(targetId).classList.add('active');
    });
  });

  // Temperature selection (Presets tab)
  el.tempButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tempButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedTemp = parseInt(btn.dataset.temp, 10);
    });
  });

  // Temperature selection (Custom tab)
  el.tempButtonsCustom.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tempButtonsCustom.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.customTemp = parseInt(btn.dataset.temp, 10);
    });
  });

  // Pour sequence selection (Custom tab)
  el.seqButtonsCustom.forEach(btn => {
    btn.addEventListener('click', () => {
      el.seqButtonsCustom.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.customSequence = btn.dataset.seq;
    });
  });

  // Drink preset buttons
  el.drinkCards.forEach(card => {
    card.addEventListener('click', () => {
      const drinkName = card.querySelector('.drink-name').textContent;
      const sizeCode = parseInt(card.dataset.size, 10);
      brewPreset(drinkName, sizeCode, state.selectedTemp);
    });
  });

  // Custom Recipe Sliders
  el.sliderCoffeeMl.addEventListener('input', updateCustomRecipeSummary);
  el.sliderWaterMl.addEventListener('input', updateCustomRecipeSummary);

  // Custom Recipe Actions
  el.btnBrewCustom.addEventListener('click', () => {
    brewCustomRecipe(state.customCoffeeMl, state.customWaterMl, state.customTemp, state.customSequence);
  });
  el.btnSaveCustom.addEventListener('click', saveCurrentCustomRecipe);

  // Machine & Dial Tab
  el.inputCupVolume.addEventListener('input', () => {
    el.valCupTargetMl.textContent = `${el.inputCupVolume.value} ml`;
  });
  el.btnReadCupSize.addEventListener('click', readDialCupSize);
  el.btnWriteCupSize.addEventListener('click', writeDialCupSize);
  el.btnOpenOnboarding.addEventListener('click', () => {
    el.inputAuthKey.value = getStoredAuthKey();
    el.settingsModal.classList.remove('hidden');
  });
  el.btnBleFactoryReset.addEventListener('click', sendBleFactoryReset);

  // Emergency Stop
  el.btnStopBrew.addEventListener('click', emergencyStop);

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
      alert('Please enter either a 16-character BLE Auth Key (starting with 8) OR a 32-character Nespresso database pairingKey.');
      return;
    }
    const saved = setStoredAuthKey(cleanHex);
    el.inputAuthKey.value = saved;
    el.settingsModal.classList.add('hidden');
    showToast(`Saved Auth Key: ${saved}`);
    log(`Saved Auth Key: ${saved}`, 'info');
  });

  // Generate & Pair New Key button
  el.btnPairNewDevice.addEventListener('click', async () => {
    const newKey = generateValidNespressoKeyHex();
    setStoredAuthKey(newKey);
    el.inputAuthKey.value = newKey;
    log(`Generated new Nespresso 0x8X PairingKey: ${newKey}`, 'info');

    if (state.isNativeAndroid && state.isConnected) {
      window.AndroidBle.pairWithNewKey(newKey);
      showToast(`Sent onboarding sequence with key ${newKey}`);
      return;
    }
    if (state.isConnected) {
      try {
        await performAuthHandshake(true);
        showToast(`Onboarding complete! Key: ${newKey}`);
      } catch (e) {
        log(`Onboarding error: ${e.message}`, 'err');
        showToast(`Pair failed: ${e.message}`);
      }
    } else {
      showToast(`Generated ${newKey}! Now tap Connect to pair.`);
    }
  });

  // Native Scanner Modal
  el.btnCloseScanner.addEventListener('click', () => {
    if (state.isNativeAndroid) window.AndroidBle.stopScan();
    state.isScanning = false;
    updateConnectionUI();
    el.scannerModal.classList.add('hidden');
  });
  el.btnRescanBle.addEventListener('click', () => {
    if (state.isNativeAndroid) {
      state.discoveredDevices.clear();
      renderScannerDeviceList();
      window.AndroidBle.startScan();
    }
  });

  // Logs Drawer
  el.btnLogs.addEventListener('click', () => {
    el.logsDrawer.classList.remove('hidden');
  });
  el.btnCloseLogs.addEventListener('click', () => {
    el.logsDrawer.classList.add('hidden');
  });
  el.btnClearLogs.addEventListener('click', () => {
    el.logConsole.innerHTML = '';
    logCount = 0;
    el.logCounter.textContent = '0 events';
  });

  [el.settingsModal, el.logsDrawer, el.scannerModal].forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });
}

// 14. Register Service Worker for PWA
function registerServiceWorker() {
  if (!state.isNativeAndroid && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.log('SW registration note:', err);
    });
  }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
  initListeners();
  loadSavedRecipes();
  renderLibrary();
  updateCustomRecipeSummary();
  registerServiceWorker();
  log(`Notpresso Expert v${APP_VERSION} initialized (${state.isNativeAndroid ? 'Native Android APK Mode' : 'Web Bluetooth Mode'}).`, 'info');
});
