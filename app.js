/**
 * ============================================================================
 * Notpresso Expert - Bluetooth Low Energy Controller for Nespresso Expert EN 350.G
 * Compatible with Samsung Galaxy S24 Ultra (Chrome on Android / OneUI) & Web Bluetooth
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

// 1. Bluetooth Low Energy UUID Definitions (Eugster/Frismag Nespresso Expert)
const BLE_UUIDS = {
  // Services
  SERVICE_DEVICE_AUTH: '06aa1910-f22a-11e3-9daa-0002a5d5c51b',
  SERVICE_STATUS_CTRL: '06aa1920-f22a-11e3-9daa-0002a5d5c51b',
  SERVICE_ERROR:       '06aa1930-f22a-11e3-9daa-0002a5d5c51b',

  // Characteristics
  CHAR_MACHINE_STATUS: '06aa3a12-f22a-11e3-9daa-0002a5d5c51b', // Read / Notify
  CHAR_CAPSULES:       '06aa3a15-f22a-11e3-9daa-0002a5d5c51b', // Read / Notify
  CHAR_AUTH:           '06aa3a41-f22a-11e3-9daa-0002a5d5c51b', // Write 8-byte CMID/AuthKey
  CHAR_COMMAND:        '06aa3a42-f22a-11e3-9daa-0002a5d5c51b', // Write Brew & Recipe Packets
  CHAR_AUTH_TYPE:      '06aa3a51-f22a-11e3-9daa-0002a5d5c51b', // Read: 2 = Final/Authenticated
  CHAR_TX_LEVEL:       '06aa3a61-f22a-11e3-9daa-0002a5d5c51b', // Write [0x01] to request pairing
};

// Machine State Enums (decoded from Byte 1 of CHAR_MACHINE_STATUS)
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

// Default Paired CMID / AuthKey fallback
const DEFAULT_AUTH_KEY = '82C15F832A864437';

// 2. Application State
const state = {
  device: null,
  server: null,
  isConnected: false,
  isScanning: false,
  
  // Cached GATT Characteristics
  charAuth: null,
  charCommand: null,
  charMachineStatus: null,
  charAuthType: null,
  charTxLevel: null,
  charCapsules: null,

  // Machine Telemetry
  machineState: 0,
  pairingState: 'NONE',
  capsuleCount: null,
  
  // Current Selections
  selectedTemp: 1, // 0: Medium (83°C), 1: Hot (86°C), 2: Extra Hot (89°C)
  customCoffeeMl: 40,
  customWaterMl: 80,
  customTemp: 1,

  // Active Brew Tracking
  isBrewing: false,
  brewDurationSec: 30,
  brewStartTime: null,
  brewInterval: null,

  // Saved Custom Recipes
  savedRecipes: [],
};

// DOM Elements
const el = {
  btnConnect: document.getElementById('btnConnect'),
  btnConnectText: document.getElementById('btnConnectText'),
  connDot: document.getElementById('connDot'),
  connStatusText: document.getElementById('connStatusText'),
  deviceSubtext: document.getElementById('deviceSubtext'),
  telemetryRow: document.getElementById('telemetryRow'),
  chipMachineState: document.getElementById('chipMachineState'),
  chipPairingState: document.getElementById('chipPairingState'),
  chipCapsules: document.getElementById('chipCapsules'),
  
  // Tabs
  navTabs: document.querySelectorAll('.nav-tab'),
  tabPanes: document.querySelectorAll('.tab-pane'),

  // Presets & Temperature
  tempButtons: document.querySelectorAll('.temp-btn'),
  drinkCards: document.querySelectorAll('.drink-card'),

  // Custom Recipe
  tempButtonsCustom: document.querySelectorAll('.temp-btn-custom'),
  sliderCoffeeMl: document.getElementById('sliderCoffeeMl'),
  sliderWaterMl: document.getElementById('sliderWaterMl'),
  valCoffeeMl: document.getElementById('valCoffeeMl'),
  valWaterMl: document.getElementById('valWaterMl'),
  valTotalMl: document.getElementById('valTotalMl'),
  valRatio: document.getElementById('valRatio'),
  btnBrewCustom: document.getElementById('btnBrewCustom'),
  btnSaveCustom: document.getElementById('btnSaveCustom'),

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
  btnSaveAuthKey: document.getElementById('btnSaveAuthKey'),

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
  const clean = key.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  localStorage.setItem('notpresso_auth_key', clean);
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
    // Default initial starter recipes
    state.savedRecipes = [
      { id: '1', name: 'Morning Wakeup Lungo', coffeeMl: 60, waterMl: 70, temp: 2 },
      { id: '2', name: 'Barista Americano', coffeeMl: 35, waterMl: 110, temp: 1 },
      { id: '3', name: 'Intense Double Ristretto', coffeeMl: 50, waterMl: 0, temp: 1 }
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
  }, 3200);
}

// 5. Bluetooth Connection & GATT Handling
async function connectBle() {
  if (state.isConnected) {
    await disconnectBle();
    return;
  }

  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not supported in this browser. Please open in Google Chrome or Samsung Internet on Android.');
    log('Web Bluetooth unsupported.', 'err');
    return;
  }

  try {
    state.isScanning = true;
    updateConnectionUI();
    log('Opening Bluetooth discovery dialog...');

    // Request Nespresso Device
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
      ]
    });

    state.device = device;
    log(`Selected peripheral: ${device.name || device.id}`, 'info');

    device.addEventListener('gattserverdisconnected', onDisconnected);

    log('Connecting to GATT server...');
    const server = await device.gatt.connect();
    state.server = server;
    log('Connected to GATT. Discovering services...', 'info');

    // Discover Services
    const authService = await server.getPrimaryService(BLE_UUIDS.SERVICE_DEVICE_AUTH);
    const ctrlService = await server.getPrimaryService(BLE_UUIDS.SERVICE_STATUS_CTRL);

    // Cache Characteristics
    state.charAuth = await authService.getCharacteristic(BLE_UUIDS.CHAR_AUTH);
    state.charCommand = await ctrlService.getCharacteristic(BLE_UUIDS.CHAR_COMMAND);

    try {
      state.charMachineStatus = await ctrlService.getCharacteristic(BLE_UUIDS.CHAR_MACHINE_STATUS);
    } catch (_) { log('Notice: Status characteristic missing.', 'warn'); }

    try {
      state.charAuthType = await authService.getCharacteristic(BLE_UUIDS.CHAR_AUTH_TYPE);
    } catch (_) {}

    try {
      state.charTxLevel = await authService.getCharacteristic(BLE_UUIDS.CHAR_TX_LEVEL);
    } catch (_) {}

    try {
      state.charCapsules = await ctrlService.getCharacteristic(BLE_UUIDS.CHAR_CAPSULES);
    } catch (_) {}

    // Subscribe to Status notifications before handshake so CCCD is open
    if (state.charMachineStatus) {
      try {
        await state.charMachineStatus.startNotifications();
        state.charMachineStatus.addEventListener('characteristicvaluechanged', handleMachineStatusNotification);
        log('Active Machine Status notifications enabled.', 'rx');
      } catch (subErr) {
        log(`Status notifications subscription note: ${subErr.message}`, 'warn');
      }
    }

    log('GATT Characteristics cached. Initializing Authentication & Handshake...', 'info');
    await performAuthHandshake();

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

async function performAuthHandshake() {
  const authKeyHex = getStoredAuthKey();
  const authBytes = hexToBytes(authKeyHex);

  if (authBytes.length === 8) {
    // Ensure high bit is set for CMID (starts with 8 or 9)
    authBytes[0] |= 0x80;
  }
  const formattedKey = bytesToHex(authBytes).replace(/\s+/g, '');
  log(`Using Auth Key (CMID): ${formattedKey}`, 'info');

  // Check initial pairing state if status char is available
  let isFinalPairing = false;
  if (state.charMachineStatus) {
    try {
      const statusData = await state.charMachineStatus.readValue();
      const b0 = statusData.getUint8(0);
      const pairingCode = (b0 & 0x60) >> 5; // 0=None, 1=Temp, 2=Final
      log(`Machine initial pairing status: ${pairingCode} (0=None, 1=Temp, 2=Final)`, 'info');
      if (pairingCode === 2) {
        isFinalPairing = true;
      }
    } catch (e) {
      log(`Initial status read note: ${e.message}`, 'warn');
    }
  }

  // If not confirmed final, send TX Level signal [0x01] to announce pairing handshake
  if (!isFinalPairing && state.charTxLevel) {
    try {
      log('Writing TX Level Request [0x01] for pairing...', 'tx');
      await safeWriteValue(state.charTxLevel, new Uint8Array([0x01]));
      await sleep(200);
    } catch (txErr) {
      log(`TX Level write note: ${txErr.message}`, 'warn');
    }
  }

  // Write Auth Key (CMID) to 06aa3a41
  log(`Writing 8-byte Auth Key to charAuth: ${bytesToHex(authBytes)}`, 'tx');
  await safeWriteValue(state.charAuth, authBytes);
  log('Auth Key written to machine.', 'info');
  await sleep(200);

  // Verify Auth Type
  if (state.charAuthType) {
    try {
      const typeVal = await state.charAuthType.readValue();
      const code = typeVal.getUint8(0);
      log(`Auth Type confirmation: ${code === 2 ? 'FINAL (Authenticated)' : code}`, 'rx');
      state.pairingState = (code === 2) ? 'FINAL' : 'AUTHENTICATED';
    } catch (authTypeErr) {
      log(`Auth Type check note: ${authTypeErr.message}`, 'warn');
    }
  }

  // Read current machine status to initialize UI state
  if (state.charMachineStatus) {
    try {
      const initialVal = await state.charMachineStatus.readValue();
      handleMachineStatusData(initialVal);
    } catch (_) {}
  }
}

function handleMachineStatusNotification(event) {
  handleMachineStatusData(event.target.value);
}

function handleMachineStatusData(dataView) {
  if (!dataView || dataView.byteLength < 2) return;
  const b0 = dataView.getUint8(0);
  const b1 = dataView.getUint8(1);

  const pairingCode = (b0 & 0x60) >> 5;
  const stateCode = b1 & 0x0F;

  const mState = MACHINE_STATES[stateCode] || { label: `State ${stateCode}`, isBusy: false };
  state.machineState = stateCode;
  state.pairingState = (pairingCode === 2) ? 'FINAL' : ((pairingCode === 1) ? 'TEMP' : 'ACTIVE');

  log(`[Status] State: ${mState.label} (${stateCode}), Security: ${state.pairingState}`, 'rx');

  el.chipMachineState.textContent = mState.label;
  el.chipPairingState.textContent = state.pairingState;

  // Auto handle active brewing overlay
  if (mState.isBusy && !state.isBrewing) {
    startBrewTracking('Extraction in Progress', 30);
  } else if (!mState.isBusy && state.isBrewing) {
    finishBrewTracking();
  }
}

async function disconnectBle() {
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
  state.charAuthType = null;
  state.charTxLevel = null;
  state.charCapsules = null;

  updateConnectionUI();
  log('Disconnected from device.', 'warn');
  showToast('Machine disconnected');
}

function updateConnectionUI() {
  if (state.isConnected) {
    el.connDot.className = 'status-dot connected';
    el.connStatusText.textContent = state.device ? (state.device.name || 'Connected') : 'Connected';
    el.deviceSubtext.textContent = 'GATT Session Active & Authenticated';
    el.btnConnect.className = 'btn btn-outline';
    el.btnConnectText.textContent = 'Disconnect';
    el.telemetryRow.classList.remove('hidden');
  } else if (state.isScanning) {
    el.connDot.className = 'status-dot scanning';
    el.connStatusText.textContent = 'Scanning...';
    el.deviceSubtext.textContent = 'Select your Expert EN 350 in the browser prompt';
    el.btnConnectText.textContent = 'Scanning...';
    el.telemetryRow.classList.add('hidden');
  } else {
    el.connDot.className = 'status-dot disconnected';
    el.connStatusText.textContent = 'Disconnected';
    el.deviceSubtext.textContent = 'Click Connect to scan for Expert EN 350';
    el.btnConnect.className = 'btn btn-connect';
    el.btnConnectText.textContent = 'Connect';
    el.telemetryRow.classList.add('hidden');
  }
}

// 6. Brew Command Dispatchers
async function brewPreset(drinkName, sizeCode, tempCode) {
  if (!state.isConnected || !state.charCommand) {
    showToast('Please connect to the machine first!');
    return;
  }

  // Packet: [0x03, 0x05, 0x07, 0x04, 0x00, 0x00, 0x00, 0x00, tempByte, sizeByte]
  const payload = new Uint8Array([
    0x03, 0x05, 0x07, 0x04,
    0x00, 0x00, 0x00, 0x00,
    tempCode & 0xFF,
    sizeCode & 0xFF
  ]);

  log(`Triggering ${drinkName} (Size: ${sizeCode}, Temp: ${tempCode}). Payload: ${bytesToHex(payload)}`, 'tx');

  try {
    await safeWriteValue(state.charCommand, payload);
    log('Brew command sent successfully!', 'info');
    startBrewTracking(`Brewing ${drinkName}`, calculateBrewDuration(sizeCode));
  } catch (err) {
    log(`Failed to trigger brew: ${err.message}`, 'err');
    showToast(`Brew error: ${err.message}`);
  }
}

async function brewCustomRecipe(coffeeMl, waterMl, tempCode) {
  if (!state.isConnected || !state.charCommand) {
    showToast('Please connect to the machine first!');
    return;
  }

  // Step 1: Recipe definition packet (0x01, 0x10, 0x08, 0x00, 0x00, 0x01, coffee_hi, coffee_lo, 0x02, water_hi, water_lo)
  const coffeeHi = (coffeeMl >> 8) & 0xFF;
  const coffeeLo = coffeeMl & 0xFF;
  const waterHi = (waterMl >> 8) & 0xFF;
  const waterLo = waterMl & 0xFF;

  const recipePayload = new Uint8Array([
    0x01, 0x10, 0x08, 0x00, 0x00,
    0x01, coffeeHi, coffeeLo,
    0x02, waterHi, waterLo
  ]);

  log(`Step 1: Flashing Custom Recipe [Coffee: ${coffeeMl}ml, Water: ${waterMl}ml]: ${bytesToHex(recipePayload)}`, 'tx');

  try {
    await safeWriteValue(state.charCommand, recipePayload);
    log('Custom Recipe parameters accepted. Dispatching execution trigger...', 'info');

    // Step 2: Short delay before execution packet
    await sleep(250);

    // Step 3: Trigger recipe execution (Type: 0x07 = Custom Recipe)
    const execPayload = new Uint8Array([
      0x03, 0x05, 0x07, 0x04,
      0x00, 0x00, 0x00, 0x00,
      tempCode & 0xFF,
      0x07 // Recipe mode
    ]);

    log(`Step 2: Triggering Recipe Execution: ${bytesToHex(execPayload)}`, 'tx');
    await safeWriteValue(state.charCommand, execPayload);

    const estDuration = Math.max(25, Math.round((coffeeMl + waterMl) * 0.35));
    startBrewTracking(`Brewing Custom Recipe (${coffeeMl}ml + ${waterMl}ml)`, estDuration);
  } catch (err) {
    log(`Custom recipe error: ${err.message}`, 'err');
    showToast(`Error: ${err.message}`);
  }
}

async function emergencyStop() {
  if (!state.charCommand) return;
  // Emergency stop payload: [0x01, 0x00]
  const stopPayload = new Uint8Array([0x01, 0x00]);
  log(`Sending Emergency STOP: ${bytesToHex(stopPayload)}`, 'tx');
  try {
    await safeWriteValue(state.charCommand, stopPayload);
    log('Emergency STOP dispatched.', 'warn');
    finishBrewTracking();
    showToast('Brewing cancelled.');
  } catch (err) {
    log(`Stop error: ${err.message}`, 'err');
  }
}

// 7. Brewing Progress Overlay Tracking
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
    case 0: return 18; // Ristretto 25ml
    case 1: return 25; // Espresso 40ml
    case 2: return 40; // Lungo 110ml
    case 5: return 50; // Americano 150ml
    case 4: return 45; // Hot water 200ml
    default: return 30;
  }
}

// 8. Custom Recipe Builder UI Updates
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

// 9. Saved Recipes Library UI
function renderLibrary() {
  el.libraryList.innerHTML = '';
  el.libraryCount.textContent = `${state.savedRecipes.length} items`;

  if (state.savedRecipes.length === 0) {
    el.libraryList.innerHTML = '<div class="alert alert-warning">No saved recipes. Craft one in the Custom Recipe tab!</div>';
    return;
  }

  state.savedRecipes.forEach((recipe, idx) => {
    const item = document.createElement('div');
    item.className = 'recipe-item';

    const tempLabel = recipe.temp === 2 ? 'Extra Hot (89°)' : (recipe.temp === 1 ? 'Hot (86°)' : 'Medium (83°)');
    const totalMl = recipe.coffeeMl + recipe.waterMl;

    item.innerHTML = `
      <div>
        <div class="recipe-meta-name">${escapeHtml(recipe.name)}</div>
        <div class="recipe-meta-details">${recipe.coffeeMl}ml coffee + ${recipe.waterMl}ml water (${totalMl}ml total) • ${tempLabel}</div>
      </div>
      <div class="recipe-actions">
        <button class="btn btn-connect btn-brew-saved" data-idx="${idx}">Brew</button>
        <button class="icon-btn btn-del-saved" data-idx="${idx}" title="Delete">🗑️</button>
      </div>
    `;

    el.libraryList.appendChild(item);
  });

  // Attach dynamic handlers
  document.querySelectorAll('.btn-brew-saved').forEach(b => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const r = state.savedRecipes[idx];
      if (r) brewCustomRecipe(r.coffeeMl, r.waterMl, r.temp);
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
    temp: state.customTemp
  };

  state.savedRecipes.unshift(newRecipe);
  persistSavedRecipes();
  renderLibrary();
  showToast(`Saved "${newRecipe.name}"`);
}

// 10. Helper Functions
function hexToBytes(hex) {
  const clean = hex.replace(/[^A-Fa-f0-9]/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}

// 11. Event Listeners Initialization
function initListeners() {
  // BLE Connection
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
    brewCustomRecipe(state.customCoffeeMl, state.customWaterMl, state.customTemp);
  });
  el.btnSaveCustom.addEventListener('click', saveCurrentCustomRecipe);

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
    const key = el.inputAuthKey.value.trim();
    if (key.length !== 16) {
      alert('The Auth Key must be exactly 16 hexadecimal characters (e.g. 82C15F832A864437).');
      return;
    }
    setStoredAuthKey(key);
    el.settingsModal.classList.add('hidden');
    showToast('Auth Key saved!');
    log(`Saved Auth Key: ${key}`, 'info');
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

  // Close modals on clicking backdrop
  [el.settingsModal, el.logsDrawer].forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });
}

// 12. Register Service Worker for PWA
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
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
  log('Notpresso Expert Controller initialized.', 'info');
});
