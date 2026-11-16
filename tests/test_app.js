#!/usr/bin/env node
/**
 * Notpresso Expert — Automated Unit & Regression Test Suite
 *
 * Covers BLE protocol codecs, 48-bit telemetry decoding, payload framing,
 * multi-stage / post-brew / rinse state machines, Service Worker caching,
 * and every historical bug fix so UI overhauls cannot silently regress behavior.
 *
 * Run: node tests/test_app.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const DOC_PAIRING = fs.readFileSync(
  path.join(ROOT_DIR, 'documentation/02-pairing-and-authentication-internals.md'),
  'utf8'
);

function parseAttributes(attrStr) {
  const attrs = {};
  const re = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1];
    const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : '');
    attrs[key] = val;
  }
  return attrs;
}

function createMockElement(tagName = 'div', attrs = {}) {
  const listeners = new Map();
  const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
  const dataset = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      dataset[camel] = v;
    }
  }

  const elem = {
    tagName: tagName.toUpperCase(),
    id: attrs.id || '',
    type: attrs.type || '',
    _value: attrs.value !== undefined ? String(attrs.value) : '',
    get value() {
      return this._value;
    },
    set value(v) {
      this._value = v === null || v === undefined ? '' : String(v);
    },
    min: attrs.min || '',
    max: attrs.max || '',
    checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
    disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
    hidden: false,
    textContent: attrs.textContent || '',
    _innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    dataset,
    children: [],
    options: [],
    _selectedIndex: 0,
    parentNode: null,
    classList: {
      add(...names) { names.filter(Boolean).forEach(n => classes.add(n)); },
      remove(...names) { names.filter(Boolean).forEach(n => classes.delete(n)); },
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) { classes.delete(name); return false; }
          classes.add(name);
          return true;
        }
        if (force) classes.add(name);
        else classes.delete(name);
        return !!force;
      },
      contains(name) { return classes.has(name); }
    },
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val) {
      classes.clear();
      String(val || '').split(/\s+/).filter(Boolean).forEach(n => classes.add(n));
    },
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(val) {
      this._innerHTML = String(val);
      if (val === '') {
        this.children = [];
      } else {
        this.children = [];
        if (this._innerHTML.includes('preset-stages-list')) {
          const stagesList = createMockElement('div', { class: 'preset-stages-list' });
          const cStage = createMockElement('div', { class: 'preset-stage-item', 'data-stage': 'coffee' });
          cStage.appendChild(createMockElement('span', { class: 'stage-order-badge', 'data-stage-badge': 'coffee', textContent: '1st' }));
          cStage.appendChild(createMockElement('input', { class: 'preset-coffee-slider' }));
          cStage.appendChild(createMockElement('span', { class: 'preset-coffee-val' }));
          ['1', '0', '2'].forEach(t => cStage.appendChild(createMockElement('button', { class: 'preset-temp-btn preset-coffee-temp-btn', 'data-temp': t })));

          const swapRow = createMockElement('div', { class: 'stage-swap-row' });
          swapRow.appendChild(createMockElement('button', { class: 'btn-xs btn-swap-stages btn-preset-swap-stages' }));

          const wStage = createMockElement('div', { class: 'preset-stage-item', 'data-stage': 'water' });
          wStage.appendChild(createMockElement('span', { class: 'stage-order-badge', 'data-stage-badge': 'water', textContent: '2nd' }));
          wStage.appendChild(createMockElement('input', { class: 'preset-water-slider' }));
          wStage.appendChild(createMockElement('span', { class: 'preset-water-val' }));
          ['1', '0', '2'].forEach(t => wStage.appendChild(createMockElement('button', { class: 'preset-temp-btn preset-water-temp-btn', 'data-temp': t })));

          const wIdx = this._innerHTML.indexOf('data-stage="water"');
          const cIdx = this._innerHTML.indexOf('data-stage="coffee"');
          if (wIdx !== -1 && cIdx !== -1 && wIdx < cIdx) {
            stagesList.appendChild(wStage);
            stagesList.appendChild(swapRow);
            stagesList.appendChild(cStage);
          } else {
            stagesList.appendChild(cStage);
            stagesList.appendChild(swapRow);
            stagesList.appendChild(wStage);
          }
          this.appendChild(stagesList);
        } else {
          for (const cls of ['preset-coffee-slider', 'preset-coffee-val', 'preset-water-slider', 'preset-water-val']) {
            if (this._innerHTML.includes(cls)) this.appendChild(createMockElement('div', { class: cls }));
          }
          const tempBtnRe = /class="[^"]*preset-temp-btn[^"]*"[^>]*data-temp="([^"]*)"/g;
          let tm;
          while ((tm = tempBtnRe.exec(this._innerHTML)) !== null) {
            this.appendChild(createMockElement('button', { class: 'preset-temp-btn', 'data-temp': tm[1] }));
          }
        }
        for (const cls of ['btn-preset-brew-tweaked', 'btn-preset-reset']) {
          if (this._innerHTML.includes(cls)) this.appendChild(createMockElement('button', { class: cls }));
        }
      }
    },
    get firstElementChild() {
      return this.children[0] || null;
    },
    get selectedIndex() {
      if (this.options.length > 0) {
        const idx = this.options.findIndex(o => o.value === this.value);
        return idx >= 0 ? idx : this._selectedIndex;
      }
      return this._selectedIndex;
    },
    set selectedIndex(idx) {
      this._selectedIndex = idx;
      if (this.options[idx]) this.value = this.options[idx].value;
    },
    appendChild(child) {
      this.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter(c => c !== child);
    },
    insertBefore(child, ref) {
      this.removeChild(child);
      const idx = ref ? this.children.indexOf(ref) : -1;
      child.parentNode = this;
      if (idx === -1) this.children.push(child);
      else this.children.splice(idx, 0, child);
      return child;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    async dispatchEvent(type, extra = {}) {
      const ev = {
        type,
        target: extra.target || elem,
        currentTarget: elem,
        stopPropagation() {},
        preventDefault() {},
        ...extra
      };
      for (const fn of (listeners.get(type) || [])) {
        await fn(ev);
      }
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const results = [];
      const parts = sel.split(',').map(s => s.trim());
      const walk = (node) => {
        for (const ch of (node.children || [])) {
          if (parts.some(p => matchesSimpleSelector(ch, p))) results.push(ch);
          walk(ch);
        }
      };
      walk(elem);
      return results;
    },
    closest(sel) {
      const parts = sel.split(',').map(s => s.trim());
      let cur = elem;
      while (cur) {
        if (parts.some(p => matchesSimpleSelector(cur, p))) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    scrollIntoView() {},
    setPointerCapture() {}
  };
  return elem;
}

function matchesAttribute(el, bracket) {
  const raw = bracket.replace(/\]$/, '');
  const eqIdx = raw.indexOf('=');
  const key = eqIdx === -1 ? raw : raw.slice(0, eqIdx);
  const expected = eqIdx === -1 ? null : raw.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '');
  const camel = key.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const val = el.dataset && el.dataset[camel];
  return eqIdx === -1 ? val !== undefined : val === expected;
}

function matchesSimpleSelector(el, sel) {
  const token = sel.split(/\s+/).pop();
  if (token.startsWith('[')) return matchesAttribute(el, token.slice(1));
  if (token.startsWith('.')) {
    const [cls, bracket] = token.slice(1).split('[');
    if (!el.classList || !el.classList.contains(cls)) return false;
    return bracket ? matchesAttribute(el, bracket) : true;
  }
  if (token.startsWith('#')) return el.id === token.slice(1);
  return el.tagName === token.toUpperCase();
}

function createAppHarness(options = {}) {
  const byId = new Map();
  const rootGroups = new Map();

  // Extract all id="..." tags from index.html
  const tagRe = /<(input|select|button|div|span|p|small|main|h2|h3|h4|iframe|details)([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(INDEX_HTML)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttributes(m[2]);
    if (!attrs.id) continue;
    const elem = createMockElement(tag, attrs);
    if (tag === 'input' && !attrs.value) elem.value = '0';
    byId.set(attrs.id, elem);
  }

  // Extract <select> options cleanly so selectCupTarget / selectWaterHardness work realistically
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(INDEX_HTML)) !== null) {
    const selAttrs = parseAttributes(m[1]);
    const body = m[2];
    const selEl = byId.get(selAttrs.id) || createMockElement('select', selAttrs);
    selEl.options = [];
    const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let om;
    let firstSelected = null;
    while ((om = optRe.exec(body)) !== null) {
      const oAttrs = parseAttributes(om[1]);
      const optEl = createMockElement('option', {
        ...oAttrs,
        textContent: om[2].replace(/<[^>]+>/g, '').trim()
      });
      selEl.appendChild(optEl);
      selEl.options.push(optEl);
      if (Object.prototype.hasOwnProperty.call(oAttrs, 'selected')) {
        firstSelected = optEl.value;
      }
    }
    if (selEl.options.length > 0) {
      selEl.value = firstSelected !== null ? firstSelected : selEl.options[0].value;
    }
    if (selAttrs.id) byId.set(selAttrs.id, selEl);
  }

  // Hydrate parent-child stage list in Custom tab & repeatable selector collections needed by app.js
  if (byId.has('customStagesList') && byId.has('customStageCoffee') && byId.has('customStageWater')) {
    byId.get('customStagesList').appendChild(byId.get('customStageCoffee'));
    if (byId.has('customStageSwapRow') && byId.has('btnSwapCustomStages')) {
      byId.get('customStageSwapRow').appendChild(byId.get('btnSwapCustomStages'));
      byId.get('customStagesList').appendChild(byId.get('customStageSwapRow'));
    }
    byId.get('customStagesList').appendChild(byId.get('customStageWater'));
  }
  rootGroups.set('.nav-tab', ['tab-presets', 'tab-custom', 'tab-bloom', 'tab-library', 'tab-machine'].map(
    (tab, i) => createMockElement('button', { class: `nav-tab${i === 0 ? ' active' : ''}`, 'data-tab': tab })
  ));
  rootGroups.set('.tab-pane', ['tab-presets', 'tab-custom', 'tab-bloom', 'tab-library', 'tab-machine'].map(
    (id, i) => createMockElement('main', { id, class: `tab-pane${i === 0 ? ' active' : ''}` })
  ));
  rootGroups.set('.drink-card[data-drink]', ['hot-water', 'ristretto', 'espresso', 'lungo', 'americano', 'great-americano'].map(
    (drink) => {
      const card = createMockElement('div', { class: 'drink-card', 'data-drink': drink });
      const mainRow = createMockElement('div', { class: 'drink-card-main' });
      mainRow.appendChild(createMockElement('div', { class: 'drink-icon' }));
      mainRow.appendChild(createMockElement('div', { class: 'drink-vol' }));
      card.appendChild(mainRow);
      card.appendChild(createMockElement('button', { class: 'btn-preset-quick' }));
      card.appendChild(createMockElement('div', { class: 'drink-expand-panel' }));
      return card;
    }
  ));
  rootGroups.set('.temp-btn-coffee', ['1', '0', '2'].map(
    t => createMockElement('button', { class: 'temp-btn-coffee', 'data-temp': t })
  ));
  rootGroups.set('.temp-btn-water', ['1', '0', '2'].map(
    t => createMockElement('button', { class: 'temp-btn-water', 'data-temp': t })
  ));
  rootGroups.set('.temp-btn-bloom', ['1', '0', '2'].map(
    t => createMockElement('button', { class: 'temp-btn-bloom', 'data-temp': t })
  ));
  rootGroups.set('#descaleStepsList .descale-step', Array.from({ length: 8 }, (_, i) => {
    const step = createMockElement('div', { class: 'descale-step', 'data-step': String(i + 1) });
    const title = createMockElement('strong', {});
    title.textContent = `Step ${i + 1}`;
    step.appendChild(title);
    const small = createMockElement('small', {});
    small.textContent = `Instruction ${i + 1}`;
    step.appendChild(small);
    return step;
  }));
  rootGroups.set('#manualReaderPane .manual-sec-card', ['prep', 'descaling', 'hardness'].map(
    s => createMockElement('div', { class: 'manual-sec-card', 'data-manual-sec': s, textContent: s })
  ));
  rootGroups.set('.manual-jump-chip', ['all', 'descaling'].map(
    s => createMockElement('button', { class: 'manual-jump-chip', 'data-sec': s, 'data-page': '1' })
  ));

  const storage = new Map();
  if (options.initialStorage) {
    for (const [k, v] of Object.entries(options.initialStorage)) storage.set(k, v);
  }

  const windowListeners = new Map();
  let intervalIdSeq = 0;
  const activeIntervals = new Map();
  const pendingTimeouts = [];

  const documentMock = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, createMockElement('div', { id }));
      return byId.get(id);
    },
    querySelectorAll(sel) {
      if (rootGroups.has(sel)) return rootGroups.get(sel);
      return [];
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    createElement(tag) {
      return createMockElement(tag);
    },
    addEventListener() {}
  };

  const context = {
    console,
    Date,
    Math,
    Uint8Array,
    Array,
    Map,
    Set,
    JSON,
    Promise,
    Error,
    parseInt,
    Number,
    Boolean,
    String,
    RegExp,
    crypto: globalThis.crypto,
    alert() {},
    confirm: () => (options.confirmResult !== undefined ? options.confirmResult : true),
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    setInterval(fn, ms) {
      const id = ++intervalIdSeq;
      activeIntervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      activeIntervals.delete(id);
    },
    navigator: options.navigator || {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: documentMock,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    window: null
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(APP_JS, context);

  // Trigger DOMContentLoaded boot listener unless caller opts out
  if (!options.skipBoot) {
    for (const fn of (windowListeners.get('DOMContentLoaded') || [])) fn();
  }

  return {
    ctx: context,
    storage,
    doc: documentMock,
    rootGroups,
    activeIntervals,
    pendingTimeouts,
    eval(code) {
      return vm.runInContext(code, context);
    },
    getState() {
      return vm.runInContext('state', context);
    },
    getEl() {
      return vm.runInContext('el', context);
    }
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// =========================================================================
// SUITE 1: BLE Protocol Codecs, Bitfields & Payload Builders
// =========================================================================

test('Suite 1: Key normalization & 4-bit nibble-shift codec matches DB hash', () => {
  const { ctx } = createAppHarness();
  assert.equal(ctx.convertDbHash32ToBleKey16('02c15f832a8644375a264bd1fb3fb1e8'), '802C15F832A86443');
  assert.equal(ctx.normalizeAuthKeyInput('a1b2c3d4e5f6071899aabbccddeeff00'), '8A1B2C3D4E5F6071');
  assert.equal(ctx.normalizeAuthKeyInput('12:34:56:78:9a:bc:de:f0'), '823456789ABCDEF0');
  assert.equal(ctx.normalizeAuthKeyInput('bad'), '82C15F832A864437');
  const gen = ctx.generateValidNespressoKeyHex();
  assert.match(gen, /^8[0-9A-F]{15}$/);
});

test('Suite 1: Big-endian selectBit and getBitBoolean match Android BitField spec', () => {
  const { ctx } = createAppHarness();
  // Byte 0: 0b0101_0100 (0x54) -> bits 1=1, 3=1, 5=1
  // Byte 1: 0b0100_0100 (0x44) -> bit 9=1 (tray full), bits 12..15 = 4 (Brewing)
  // Byte 2: 0b1000_0000 (0x80) -> bit 16 = 1 (stockLow)
  const buf = new Uint8Array([0x54, 0x44, 0x80, 0x00, 0x00, 0x01]);
  assert.equal(ctx.selectBit(buf, 1, 2), 2);
  assert.equal(ctx.getBitBoolean(buf, 3), true);
  assert.equal(ctx.getBitBoolean(buf, 5), true);
  assert.equal(ctx.getBitBoolean(buf, 7), false);
  assert.equal(ctx.getBitBoolean(buf, 9), true);
  assert.equal(ctx.selectBit(buf, 12, 15), 4);
  assert.equal(ctx.getBitBoolean(buf, 16), true);
  assert.equal(ctx.getBitBoolean(buf, 47), true);
});

test('Suite 1: buildSetRecipePayload and buildProgrammedBrewPayload frame bytes cleanly', () => {
  const { ctx } = createAppHarness();
  assert.equal(ctx.bytesToHexNoSpaces(ctx.buildSetRecipePayload(40, 0, 'coffee-first')), '0110080000010028000000');
  assert.equal(ctx.bytesToHexNoSpaces(ctx.buildSetRecipePayload(0, 200, 'coffee-first')), '01100800000200C8000000');
  assert.equal(ctx.bytesToHexNoSpaces(ctx.buildSetRecipePayload(40, 160, 'coffee-first')), '01100800000100280200A0');
  assert.equal(ctx.bytesToHexNoSpaces(ctx.buildSetRecipePayload(40, 160, 'water-first')), '01100800000200A0010028');
  assert.equal(ctx.bytesToHexNoSpaces(ctx.buildProgrammedBrewPayload(0x05, 0x02, 900)), '03050704000003840205');
});

test('Suite 1: ZeroOrRangeValue snappers and fault/threshold decoders', () => {
  const { ctx } = createAppHarness();
  assert.equal(ctx.snapCoffeeVolume(0), 0);
  assert.equal(ctx.snapCoffeeVolume(7), 0);
  assert.equal(ctx.snapCoffeeVolume(8), 15);
  assert.equal(ctx.snapCoffeeVolume(160), 130);
  assert.equal(ctx.snapWaterVolume(12), 0);
  assert.equal(ctx.snapWaterVolume(13), 25);
  assert.equal(ctx.snapWaterVolume(350), 300);

  assert.equal(ctx.parseStockThresholdBytes(new Uint8Array([0x01, 0x2C])), 300);
  assert.deepEqual(
    { ...ctx.parseFaultRecordBytes(new Uint8Array([0x09, 0x40, 0x1F]), 3) },
    { slot: 3, errNum: 9, errCat: 4, category: 'FATAL', errSub: 0x1f, isEmpty: false, summary: 'Slot 3: #9 FATAL (sub 0x1f)' }
  );
  assert.equal(ctx.parseFaultRecordBytes(new Uint8Array([0x00, 0x00, 0x00]), 1).isEmpty, true);
  assert.equal(ctx.escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

// =========================================================================
// SUITE 2: Historical Bug-Fix Regression Tests
// =========================================================================

test('Regression [4acb892]: Auth handshake sends TxPower 0x01/0x00 only on onboarding', async () => {
  const h = createAppHarness();
  const state = h.getState();
  const txs = [];
  let keyStateResp = 0; // ABSENT -> needs onboarding
  h.ctx.readBleCharacteristic = async (uuid) => {
    if (uuid === h.eval('BLE_UUIDS.CHAR_AUTH_TYPE')) return new Uint8Array([keyStateResp]);
    return null;
  };
  h.ctx.writeBleCharacteristic = async (uuid, bytes) => {
    txs.push({ uuid: uuid.substring(4, 8), hex: h.ctx.bytesToHexNoSpaces(bytes) });
  };
  h.ctx.setStoredAuthKey('023456789ABCDEF1');

  await h.ctx.performAuthHandshake(false);
  assert.deepEqual(txs, [
    { uuid: '3a61', hex: '01' },
    { uuid: '3a41', hex: '823456789ABCDEF1' },
    { uuid: '3a61', hex: '00' }
  ]);

  txs.length = 0;
  keyStateResp = 2; // PRESENT -> session auth only
  await h.ctx.performAuthHandshake(false);
  assert.equal(state.pairingKeyStateByte, 2);
  assert.deepEqual(txs, [{ uuid: '3a41', hex: '823456789ABCDEF1' }]);
});

test('Regression [#3 / 58ea3d8]: Command rejection clears modal/workflow immediately and bit 47 decodes obstacle', () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const el = h.getEl();
  state.activeWorkflow = { type: 'two-stage-split', stage: 1 };
  el.brewModal.classList.remove('hidden');

  // 20-byte response: bytes[3]=0x24 (CONDITIONS_NOT_FULFILLED), bytes[4]=0x08 (Slider OPEN)
  const rej = new Uint8Array(20);
  rej[3] = 0x24;
  rej[4] = 0x08;
  h.ctx.decodeCommandResponse(rej);

  assert.equal(state.activeWorkflow, null);
  assert.equal(el.brewModal.classList.contains('hidden'), true);
  assert.equal(el.postBrewBox.classList.contains('hidden'), true);
  assert.equal(el.ledTelematicsBanner.classList.contains('led-state-err'), true);
  assert.match(el.ledBannerDesc.textContent, /slider is OPEN/i);

  // Bit 47 = 0x01 on byte 5 -> obstacleDetected
  h.ctx.handleRawCharacteristicBytes(
    h.eval('BLE_UUIDS.CHAR_MACHINE_STATUS'),
    new Uint8Array([0x04, 0x02, 0x00, 0x00, 0x00, 0x01])
  );
  assert.equal(state.obstacleDetected, true);
  assert.match(el.chipMachineState.textContent, /Obstacle/);
  assert.equal(
    h.ctx.describeLedTelematics({ stateCode: 2, obstacleDetected: true }).title,
    'Maintenance LED Alert — Obstacle Detected'
  );
});

test('Regression [#4 / d3d62dd]: syncCustomRecipeUI works and bloom edits update in-place', () => {
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();

  // Custom recipe edit
  const customIdx = state.savedRecipes.findIndex(r => r.kind === 'custom' && r.splitTemp);
  assert.ok(customIdx >= 0);
  const customId = state.savedRecipes[customIdx].id;
  h.ctx.editRecipeInCustomTab(customIdx);
  assert.equal(state.editingRecipeId, customId);
  assert.equal(state.customSplitTemp, true);
  assert.equal(el.tempButtonsCoffee.find(b => b.classList.contains('active')).dataset.temp, '2');
  assert.equal(el.tempButtonsWater.find(b => b.classList.contains('active')).dataset.temp, '1');
  assert.equal(el.btnUpdateCustom.classList.contains('hidden'), false);

  // Bloom recipe edit + save updates existing entry in place
  const bloomIdx = state.savedRecipes.findIndex(r => r.kind === 'bloom');
  assert.ok(bloomIdx >= 0);
  const countBefore = state.savedRecipes.length;
  const bloomId = state.savedRecipes[bloomIdx].id;
  h.ctx.editRecipeInCustomTab(bloomIdx);
  assert.equal(state.editingRecipeId, bloomId);
  el.inputBloomRecipeName.value = 'Updated Clean Macro';
  h.ctx.saveCurrentBloomRecipe();
  assert.equal(state.savedRecipes.length, countBefore);
  assert.equal(state.savedRecipes.find(r => r.id === bloomId).name, 'Updated Clean Macro');
});

test('Regression [#5 / #19]: Stage 2 waits through HEATING_UP->READY until BREWING->READY and respects +35s buffer', async () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const txs = [];
  h.ctx.writeBleCharacteristic = async (uuid, bytes) => {
    txs.push(h.ctx.bytesToHexNoSpaces(bytes));
  };
  state.activeWorkflow = {
    type: 'two-stage-split',
    stage: 1,
    stage2Triggered: false,
    stage2: { coffeeMl: 0, waterMl: 160, temp: 1, label: 'Stage 2/2: 160ml Water' }
  };

  // Real machine heat transition 1 (Heating Up) -> 2 (Ready) -> 4 (Brewing) must NOT trigger Stage 2 early
  await h.ctx.handleWorkflowStatusUpdate(1, 2, false);
  assert.notEqual(state.activeWorkflow, null);
  assert.equal(txs.length, 0, 'Must NOT trigger Stage 2 on HEATING_UP -> READY before brewing');

  await h.ctx.handleWorkflowStatusUpdate(2, 4, false);
  assert.equal(txs.length, 0);
  assert.equal(state.activeWorkflow.sawBrewing, true);

  // Only after BREWING (4) -> READY (2) finishes Stage 1 does Stage 2 fire
  await h.ctx.handleWorkflowStatusUpdate(4, 2, false);
  assert.equal(state.activeWorkflow, null);
  assert.equal(txs.length, 2);
  assert.equal(txs[1], '03050704000000000107'); // stage 2 warm water

  // Verify startBrewTracking interval applies +35s workflow buffer & waits while machine isBusy
  h.ctx.startBrewTracking('Test Stage 1', 'sub', 20);
  state.activeWorkflow = {
    type: 'two-stage-split',
    stage: 1,
    stage2Triggered: false,
    stage2: { coffeeMl: 0, waterMl: 160, temp: 1, label: 'Stage 2/2' }
  };
  state.machineState = 4; // Brewing (isBusy=true)
  state.brewStartTime = Date.now() - 100_000;
  txs.length = 0;
  const intervalEntry = Array.from(h.activeIntervals.values()).pop();
  await intervalEntry.fn();
  assert.equal(txs.length, 0, 'Must NOT trigger Stage 2 while machineState=4 isBusy');
  state.machineState = 2; // Ready
  state.brewStartTime = Date.now() - 30_000; // elapsed 30s < 20 + 35s buffer
  await intervalEntry.fn();
  assert.equal(txs.length, 0, 'Must NOT trigger Stage 2 before brewDurationSec + 35s buffer');
});

test('Regression [#7 / d6a608d]: resumePhase2Extraction dispatches phase2Ml - phase1Ml (min 15 ml) on water-pause', async () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const txs = [];
  h.ctx.writeBleCharacteristic = async (uuid, bytes) => {
    txs.push(h.ctx.bytesToHexNoSpaces(bytes));
  };

  // Water-pause soak: 130 - 40 = 90 ml (0x5A)
  state.activeWorkflow = { type: 'water-pause-soak', phase1Ml: 40, phase2Ml: 130, tempCode: 2 };
  await h.ctx.resumePhase2Extraction();
  assert.equal(txs[0], '011008000001005A000000');

  // Clamped minimum 15 ml (0x0F) when phase2Ml - phase1Ml < 15
  txs.length = 0;
  state.activeWorkflow = { type: 'water-pause-soak', phase1Ml: 50, phase2Ml: 55, tempCode: 0 };
  await h.ctx.resumePhase2Extraction();
  assert.equal(txs[0], '011008000001000F000000');

  // Two-stage bloom sends full phase2Ml (130 ml = 0x82)
  txs.length = 0;
  state.activeWorkflow = { type: 'two-stage-bloom', phase1Ml: 40, phase2Ml: 130, tempCode: 2 };
  await h.ctx.resumePhase2Extraction();
  assert.equal(txs[0], '0110080000010082000000');
});

test('Regression [#8 / 196b4b9]: Selecting dial target resets input to default and profiles update defaults', () => {
  const h = createAppHarness();
  const el = h.getEl();

  el.selectCupTarget.value = '2'; // Lungo: App calibration default = 80
  h.ctx.updateCupRangeHint(true);
  assert.equal(el.inputCupVolume.value, '80');
  assert.equal(el.valCupTargetMl.textContent, '80 ml');

  h.ctx.applyFactoryDefaultsProfile();
  assert.equal(el.inputCupVolume.value, '110');
  assert.equal(el.valCupTargetMl.textContent, '110 ml');

  h.ctx.applyAppCalibrationProfile();
  assert.equal(el.inputCupVolume.value, '80');
});

test('Regression [#1 / ce781af]: Slider updates UI/descale visual, preserves detailed schedule, disconnect cleans modal', () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const el = h.getEl();

  // Slider open (0x00)
  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_SLIDER'), new Uint8Array([0x00]));
  assert.equal(state.sliderOpen, true);
  assert.equal(el.chipSliderState.textContent, 'Open');
  assert.match(el.visSlider.textContent, /OPEN/);

  // Detailed schedule from 06aa3a32 must NOT be overwritten by 06aa3a12 schedActive=true
  h.ctx.handleRawCharacteristicBytes(
    h.eval('BLE_UUIDS.CHAR_SCHEDULE'),
    new Uint8Array([0x00, 0x00, 0x03, 0x84, 0x00, 0x01]) // 900s = 15m
  );
  assert.match(el.badgeScheduleStatus.textContent, /15m/);
  // Set bit 27 (Byte 3 bit 3 => 0x10) on CHAR_MACHINE_STATUS
  h.ctx.handleRawCharacteristicBytes(
    h.eval('BLE_UUIDS.CHAR_MACHINE_STATUS'),
    new Uint8Array([0x00, 0x02, 0x00, 0x10, 0x00, 0x00])
  );
  assert.match(el.badgeScheduleStatus.textContent, /15m/);

  // onDisconnected clears active brew/rinse/modal state
  state.isBrewing = true;
  state.activeWorkflow = { type: 'system-rinse', stepIndex: 1 };
  el.brewModal.classList.remove('hidden');
  h.ctx.onDisconnected();
  assert.equal(state.isConnected, false);
  assert.equal(state.isBrewing, false);
  assert.equal(state.activeWorkflow, null);
  assert.equal(el.brewModal.classList.contains('hidden'), true);
  assert.equal(el.badgeRinseStatus.textContent, 'Idle (5 Shots)');
});

test('Regression [#9 / b366de4]: enqueueGattOp serializes FIFO across rejections & connectBle awaits telemetry', async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(r => { releaseFirst = r; });

  const mockChar = (label) => ({
    async writeValueWithResponse() {
      events.push(`start:${label}`);
      if (label === 'w1') await firstGate;
      if (label === 'wFail') throw new Error('gatt-err');
      events.push(`end:${label}`);
    },
    async readValue() {
      events.push(`read:${label}`);
      return { buffer: new Uint8Array([2]).buffer };
    },
    async startNotifications() {},
    addEventListener() {}
  });

  const mockSvc = {
    async getCharacteristic(u) { return mockChar(u.substring(4, 8)); }
  };
  const mockDevice = {
    name: 'Expert-Mock',
    addEventListener() {},
    gatt: {
      async connect() {
        return { async getPrimaryService() { return mockSvc; } };
      }
    }
  };

  const h = createAppHarness({
    navigator: { bluetooth: { requestDevice: async () => mockDevice } }
  });
  const state = h.getState();

  state.characteristics.set('06aa0001', mockChar('w1'));
  state.characteristics.set('06aa0002', mockChar('wFail'));
  state.characteristics.set('06aa0003', mockChar('r3'));

  const p1 = h.ctx.writeBleCharacteristic('06aa0001', new Uint8Array([1]));
  const p2 = h.ctx.writeBleCharacteristic('06aa0002', new Uint8Array([2])).catch(() => 'caught');
  const p3 = h.ctx.readBleCharacteristic('06aa0003');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(events, ['start:w1']);
  releaseFirst();
  await p1;
  assert.equal(await p2, 'caught');
  const r3 = await p3;
  assert.equal(r3[0], 2);
  assert.deepEqual(events, ['start:w1', 'end:w1', 'start:wFail', 'read:r3']);

  // Verify connectBle awaits readInitialTelemetry before resolving
  let telemetryDone = false;
  const origRead = h.ctx.readInitialTelemetry;
  h.ctx.readInitialTelemetry = async () => {
    await new Promise(r => setTimeout(r, 5));
    telemetryDone = true;
  };
  await h.ctx.connectBle();
  assert.equal(telemetryDone, true, 'connectBle must await readInitialTelemetry');
  h.ctx.readInitialTelemetry = origRead;
});

test('Regression [#10 & #12]: No flutter_src / dead stubs; delegated listeners don’t duplicate; SW fallback checks navigate', async () => {
  assert.equal(fs.existsSync(path.join(ROOT_DIR, 'flutter_src')), false);
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();
  assert.equal('isNativeAndroid' in state, false);
  assert.equal('envSubtitle' in el, false);

  h.ctx.renderLibrary();
  h.ctx.renderLibrary();
  h.ctx.renderFavoritesOnHome();
  h.ctx.renderFavoritesOnHome();
  assert.equal(el.libraryList.dataset.actionsBound, '1');
  assert.equal(el.libraryList.dataset.dragBound, '1');
  assert.equal(el.homeFavoritesList.dataset.actionsBound, '1');
  assert.equal(el.homeFavoritesList.dataset.dragBound, '1');

  // Verify Service Worker offline fallback behavior
  const swListeners = {};
  const swCtx = {
    self: { addEventListener: (ev, fn) => { swListeners[ev] = fn; } },
    caches: { match: async (req) => (req === './index.html' ? { ok: true, kind: 'html' } : undefined) },
    fetch: async () => { throw new Error('offline'); },
    Response: { error: () => ({ ok: false, kind: 'net-err' }) }
  };
  vm.createContext(swCtx);
  vm.runInContext(SW_JS, swCtx);

  let pNav;
  await swListeners.fetch({ request: { mode: 'navigate' }, respondWith: p => { pNav = p; } });
  assert.equal((await pNav).kind, 'html');
  let pAsset;
  await swListeners.fetch({ request: { mode: 'no-cors' }, respondWith: p => { pAsset = p; } });
  assert.equal((await pAsset).kind, 'net-err');
});

test('Regression [#14]: Default water hardness Level 3 (Hard) and Manual p. 15 factory reset steps', () => {
  const h = createAppHarness();
  assert.equal(h.getState().waterHardnessLevel, 3);
  assert.equal(h.getEl().selectWaterHardness.value, '3');
  assert.equal(h.eval('WATER_HARDNESS_INFO')[3].cups, 1500);
  assert.match(INDEX_HTML, /<option value="3" selected>Level 3 \(Hard/);
  assert.match(DOC_PAIRING, /Brewing button for 6 seconds[\s\S]*?Lungo[\s\S]*?Temperature dial to maximum/);
});

// =========================================================================
// SUITE 3: Core Feature & Workflow Tests (#13, #2, #16, #15, v0.5.0-v0.6.0)
// =========================================================================

test('Feature [#13]: Capsule stock counter R/W, clamp 0..1000, and 0xFFFF disable', async () => {
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();
  const txs = [];
  state.isConnected = true;
  h.ctx.writeBleCharacteristic = async (u, b) => txs.push({ u: u.substring(4, 8), hex: h.ctx.bytesToHexNoSpaces(b) });

  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_STOCK'), new Uint8Array([0x00, 0x20])); // 32 caps
  assert.equal(state.capsuleStock, 32);
  assert.equal(el.valStockCounter.textContent, '32 caps');
  assert.equal(el.badgeStockStatus.textContent, '32 left');
  assert.equal(el.inputStockCount.value, '32');
  assert.equal(el.stockPanel.classList.contains('is-disabled'), false);

  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_STOCK'), new Uint8Array([0x00, 0x00]));
  assert.equal(state.capsuleStock, 0);
  assert.equal(el.valStockCounter.textContent, '0 caps (LED ON)');
  assert.equal(el.badgeStockStatus.textContent, '0 left • LED ON');
  assert.equal(el.inputStockCount.value, '0');

  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_STOCK'), new Uint8Array([0xFF, 0xFF]));
  assert.equal(state.capsuleStock, null);
  assert.equal(el.valStockCounter.textContent, 'Disabled');
  assert.equal(el.badgeStockStatus.textContent, 'Tracking Off');
  assert.equal(el.inputStockCount.value, '');
  assert.equal(el.stockPanel.classList.contains('is-disabled'), true);

  el.inputStockCount.value = '1500'; // Should clamp to 1000 (0x03E8)
  await h.ctx.writeCapsuleStock();
  assert.equal(el.inputStockCount.value, '1000');
  assert.equal(el.badgeStockStatus.textContent, '1000 left');

  await h.ctx.disableCapsuleStock();
  assert.equal(el.badgeStockStatus.textContent, 'Tracking Off');
  assert.equal(el.inputStockCount.value, '');

  // Threshold 0xFFFF parses cleanly as disabled (null / Alert Off) & low-stock marks badge
  assert.equal(h.ctx.parseStockThresholdBytes(new Uint8Array([0xFF, 0xFF])), null);
  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_STOCK_THRESHOLD'), new Uint8Array([0xFF, 0xFF]));
  assert.equal(el.valStockThreshold.textContent, 'Off');
  assert.equal(el.badgeThresholdStatus.textContent, 'Alert Off');
  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_STOCK_THRESHOLD'), new Uint8Array([0x00, 0x1E])); // 30
  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_STOCK'), new Uint8Array([0x00, 0x0F])); // 15 <= 30
  assert.equal(el.badgeThresholdStatus.textContent, 'Alert ≤ 30');
  assert.equal(el.badgeStockStatus.textContent, '15 left • Low Alert');
  assert.equal(el.badgeStockStatus.classList.contains('stock-low'), true);

  assert.deepEqual(txs, [
    { u: '3a15', hex: '03E8' },
    { u: '3a15', hex: 'FFFF' }
  ]);
});

test('Feature [#2]: Low-stock threshold (06aa3a25) & Fault History (06aa1930)', async () => {
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();
  const log = [];
  state.isConnected = true;
  h.ctx.writeBleCharacteristic = async (u, b) => {
    log.push(`tx:${u.substring(4, 8)}:${h.ctx.bytesToHexNoSpaces(b)}`);
  };
  h.ctx.readBleCharacteristic = async (u) => {
    log.push(`rx:${u.substring(4, 8)}`);
    return new Uint8Array([0x07, 0x30, 0x02]);
  };

  el.inputStockThreshold.value = '15';
  await h.ctx.writeStockThreshold();
  el.selectErrorSlot.value = '4';
  await h.ctx.readErrorLogSlot();

  assert.deepEqual(log, ['tx:3a25:000F', 'tx:3a13:04', 'rx:3a23']);
  assert.equal(state.capsuleStockThreshold, 15);
  assert.equal(state.lastErrorRecord.summary, 'Slot 4: #7 ERROR (sub 0x02)');
});

test('Feature [#16]: 5-Shot System Rinse validates slider, executes 3x Lungo + 2x Hot Water, supports stop', async () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const el = h.getEl();
  const txs = [];
  state.isConnected = true;
  h.ctx.writeBleCharacteristic = async (u, b) => txs.push(h.ctx.bytesToHexNoSpaces(b));

  // Must refuse when slider is open
  state.sliderOpen = true;
  await h.ctx.startSystemRinseWorkflow();
  assert.equal(txs.length, 0);
  assert.equal(state.activeWorkflow, null);

  // Run full 5 shots when closed
  state.sliderOpen = false;
  await h.ctx.startSystemRinseWorkflow();
  assert.equal(el.btnStartSystemRinse.disabled, true);
  assert.equal(el.btnStopSystemRinse.disabled, false);

  for (let i = 0; i < 5; i++) {
    await h.ctx.handleWorkflowStatusUpdate(4, 2, false);
  }

  assert.deepEqual(txs, [
    '03050704000000000002',
    '03050704000000000002',
    '03050704000000000002',
    '03050704000000000004',
    '03050704000000000004'
  ]);
  assert.equal(state.activeWorkflow, null);
  assert.equal(el.badgeRinseStatus.textContent, 'Complete ✓');
  assert.equal(el.btnStartSystemRinse.disabled, false);

  // Stop mid-rinse sends abort frame 03 06 01 02
  txs.length = 0;
  await h.ctx.startSystemRinseWorkflow();
  await h.ctx.stopSystemRinseWorkflow();
  assert.equal(txs.at(-1), '03060102');
  assert.equal(el.badgeRinseStatus.textContent, 'Stopped');
});

test('Feature [#15]: 10s post-brew auto-eject countdown & 1-tap top-up (+15ml Coffee / +25ml Water)', async () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const el = h.getEl();
  const txs = [];
  state.isConnected = true;
  h.ctx.writeBleCharacteristic = async (u, b) => txs.push(h.ctx.bytesToHexNoSpaces(b));

  await h.ctx.brewPreset('Espresso', 1, 2); // Max temp 0x02
  h.ctx.finishBrewTracking();
  assert.equal(state.postBrewRemainingSec, 10);
  assert.equal(el.postBrewBox.classList.contains('hidden'), false);
  assert.equal(el.btnStopBrew.classList.contains('hidden'), true);

  // Tick timer down to 0
  const postTimer = Array.from(h.activeIntervals.values()).pop();
  for (let s = 0; s < 10; s++) postTimer.fn();
  assert.equal(state.postBrewRemainingSec, 0);
  assert.equal(el.brewModal.classList.contains('hidden'), true);

  // +Coffee and +Water top-ups inherit locked temperature 0x02
  txs.length = 0;
  await h.ctx.triggerPostBrewTopUp('coffee');
  assert.equal(txs[0], '011008000001000F000000');
  assert.equal(txs[1], '03050704000000000207');

  txs.length = 0;
  await h.ctx.triggerPostBrewTopUp('water');
  assert.equal(txs[0], '0110080000020019000000');
  assert.equal(txs[1], '03050704000000000207');
});

test('Features [v0.5.0–v0.6.0]: Per-cup temp overrides, recipe reorder, and expandable preset tweaks', async () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const txs = [];
  state.isConnected = true;
  h.ctx.writeBleCharacteristic = async (u, b) => txs.push(h.ctx.bytesToHexNoSpaces(b));

  // Find Great Americano split recipe in savedRecipes and override its cup temp to Warm (1)
  const splitIdx = state.savedRecipes.findIndex(r => r.splitTemp === true);
  assert.ok(splitIdx >= 0);
  const key = h.ctx.getRecipeTempKey(state.savedRecipes[splitIdx], splitIdx);
  state.recipeTempOverrides[key] = 1; // Override Split -> Warm ~80°C single stage
  await h.ctx.executeSavedRecipe(splitIdx);
  assert.equal(state.activeWorkflow, null, 'Temp override to 80°C runs single-stage instead of 2-stage split');
  assert.equal(txs[1], '03050704000000000107');

  // Reorder savedRecipes and verify persistence
  const firstId = state.savedRecipes[0].id;
  assert.equal(h.ctx.moveRecipeFromTo(0, 2), true);
  assert.equal(state.savedRecipes[2].id, firstId);
  const stored = JSON.parse(h.storage.get('notpresso_saved_recipes_v3'));
  assert.equal(stored[2].id, firstId);

  // Expandable preset: collapsed button uses factory volume (03 05 ... 01), tweaked volume uses custom (01 10 08 ...)
  txs.length = 0;
  await h.ctx.executePresetDrink('espresso', false);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].slice(-2), '01');

  txs.length = 0;
  state.presetTweaks.espresso.coffeeMl = 55;
  state.presetTweaks.espresso.temp = 2;
  await h.ctx.executePresetDrink('espresso', true);
  assert.equal(txs.length, 2);
  assert.equal(txs[0], '0110080000010037000000');
  assert.equal(txs[1], '03050704000000000207');
});

test('Structural Contract: UI layout & required IDs intact for overhaul readiness', () => {
  const tabMachineIdx = INDEX_HTML.indexOf('<main id="tab-machine"');
  const diagIdx = INDEX_HTML.indexOf('Machine Diagnostics & Maintenance');
  const dialIdx = INDEX_HTML.indexOf('Physical Rotary Dial Cup Sizes');
  const settingsIdx = INDEX_HTML.indexOf('<div id="settingsModal"');
  const factoryBtnIdx = INDEX_HTML.indexOf('btnBleFactoryReset');
  assert.ok(tabMachineIdx < diagIdx && diagIdx < dialIdx, 'Diagnostics card sits first in #tab-machine');
  assert.ok(settingsIdx < factoryBtnIdx, 'Factory reset sits inside #settingsModal');
  assert.equal(INDEX_HTML.includes('btnOpenOnboarding'), false);

  const h = createAppHarness();
  const ver = h.eval('APP_VERSION');
  assert.match(ver, /^\d+\.\d+\.\d+$/);
  assert.equal(h.getEl().badgeAppVersion.textContent, `v${ver}`);
  assert.ok(INDEX_HTML.indexOf('id="badgeAppVersion"') < INDEX_HTML.indexOf('</header>'), 'Version badge sits in main header');
  assert.equal(INDEX_HTML.includes(ver), false, 'index.html must not hardcode APP_VERSION');
  assert.equal(SW_JS.includes(ver), false, 'sw.js must not hardcode APP_VERSION');
});

test('Feature [v0.12.0 / v0.13.7]: Configurable logo long-press countdown & forceAppCacheUpdate purges SW and caches', async () => {
  let unregistered = 0;
  const deletedCaches = [];
  let replacedUrl = null;

  const h = createAppHarness({
    navigator: {
      serviceWorker: {
        register: async () => {},
        getRegistrations: async () => [{ unregister: async () => { unregistered++; return true; } }]
      }
    }
  });
  h.ctx.caches = {
    keys: async () => ['notpresso-v0.11.0', 'notpresso-v0.12.0'],
    delete: async (k) => { deletedCaches.push(k); return true; }
  };
  h.ctx.location = {
    pathname: '/my-notpresso/',
    replace: (u) => { replacedUrl = u; }
  };

  const el = h.getEl();
  const ver = h.eval('APP_VERSION');
  const holdSec = h.eval('LOGO_HOLD_REFRESH_SEC');
  assert.ok(Number.isInteger(holdSec) && holdSec > 0, 'LOGO_HOLD_REFRESH_SEC must be a positive integer');
  assert.equal(el.btnLogoRefresh.title, `Hold ${holdSec}s to force app & cache update`);

  // Start hold -> shows configured countdown, early release restores badge
  h.ctx.startLogoHoldRefresh({ button: 0 });
  assert.equal(el.btnLogoRefresh.classList.contains('is-holding'), true);
  assert.equal(el.logoHoldCountdown.classList.contains('hidden'), false);
  assert.equal(el.logoHoldCountdown.textContent, `${holdSec}s`);
  assert.equal(el.badgeAppVersion.textContent, `↻ ${holdSec}s`);

  h.ctx.cancelLogoHoldRefresh();
  assert.equal(el.btnLogoRefresh.classList.contains('is-holding'), false);
  assert.equal(el.logoHoldCountdown.classList.contains('hidden'), true);
  assert.equal(el.badgeAppVersion.textContent, `v${ver}`);

  // Hold full LOGO_HOLD_REFRESH_SEC -> ticks (N-1)..1s without early reload, then purges SW & caches
  h.ctx.startLogoHoldRefresh({ button: 0 });
  const holdTimer = Array.from(h.activeIntervals.values()).pop();
  assert.equal(holdTimer.ms, 1000);
  for (let rem = holdSec - 1; rem >= 1; rem -= 1) {
    holdTimer.fn();
    assert.equal(el.logoHoldCountdown.textContent, `${rem}s`);
    assert.equal(el.badgeAppVersion.textContent, `↻ ${rem}s`);
    assert.equal(replacedUrl, null, 'Must not reload before LOGO_HOLD_REFRESH_SEC elapses');
  }
  holdTimer.fn();
  await new Promise(r => setTimeout(r, 0));

  assert.equal(unregistered, 1);
  assert.deepEqual(deletedCaches, ['notpresso-v0.11.0', 'notpresso-v0.12.0']);
  assert.match(replacedUrl, /^\/my-notpresso\/\?refresh=\d+$/);
});

test('Feature [#18]: Two-phase brew per-stage 3x temperatures and stage order swap (coffee-first vs water-first)', async () => {
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();
  const txs = [];
  state.isConnected = true;
  h.ctx.writeBleCharacteristic = async (u, b) => txs.push(h.ctx.bytesToHexNoSpaces(b));

  // Preset defaults & card unification (v0.13.2): Hot Water 250ml@Max, XL water-first, no Split-Temp pill/highlight
  const defaults = h.eval('PRESET_DRINK_DEFAULTS');
  assert.equal(defaults.hotwater.waterMl, 250);
  assert.equal(defaults.hotwater.temp, 2);
  assert.equal(defaults['great-americano'].seq, 'water-first');
  assert.equal(defaults['great-americano'].waterTemp, 1);
  assert.equal(defaults['great-americano'].coffeeTemp, 2);
  assert.equal(defaults['great-americano'].actionLabel, 'Brew');
  assert.equal(INDEX_HTML.includes('class="mini-pill">Split-Temp'), false);
  assert.equal(INDEX_HTML.includes('id="btnGreatAmericanoPreset" class="drink-card highlight-card"'), false);

  txs.length = 0;
  await h.ctx.executePresetDrink('hotwater', false);
  assert.equal(txs[0], '01100800000200FA000000');
  assert.equal(txs[1], '03050704000000000207');

  // Machine dial target volumes (3 & 4) sync directly into Americano preset defaults & subtitle
  const ameCard = h.rootGroups.get('.drink-card[data-drink]').find(c => c.dataset.drink === 'americano');
  h.ctx.applyMachineCupTargetVolume(3, 35);
  h.ctx.applyMachineCupTargetVolume(4, 150);
  assert.equal(defaults.americano.coffeeMl, 35);
  assert.equal(defaults.americano.waterMl, 150);
  assert.equal(state.presetTweaks.americano.coffeeMl, 35);
  assert.equal(state.presetTweaks.americano.waterMl, 150);
  assert.match(ameCard.querySelector('.drink-vol').textContent, /35ml \+ 150ml/);
  h.ctx.applyMachineCupTargetVolume(3, 25);
  h.ctx.applyMachineCupTargetVolume(4, 125);

  // Two-phase preset panels (Americano & Great Americano XL) have consistent Brew Temperature UI, swap button, and no drag handle
  const gxlCard = h.rootGroups.get('.drink-card[data-drink]').find(c => c.dataset.drink === 'great-americano');
  const amePanel = ameCard.querySelector('.drink-expand-panel');
  const gxlPanel = gxlCard.querySelector('.drink-expand-panel');
  assert.equal(ameCard.querySelector('.drink-icon').textContent, '☕💧');
  assert.equal(gxlCard.querySelector('.drink-icon').textContent, '💧☕');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 80), '(Lungo) 80 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 110), '110 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 15), '(Min) 15 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 55), '55 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 125), '(Americano) 125 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 230), '(Hot Water) 230 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 250), '250 ml');
  assert.equal(ameCard.querySelectorAll('.preset-coffee-temp-btn').length, 3);
  assert.equal(ameCard.querySelectorAll('.preset-water-temp-btn').length, 3);
  assert.equal(ameCard.querySelectorAll('.preset-temp-btn').length, 6);
  assert.equal(amePanel.innerHTML.includes('Brew Temperature'), true);
  assert.equal(gxlPanel.innerHTML.includes('Brew Temperature'), true);
  assert.equal(amePanel.innerHTML.includes('recipe-drag-handle'), false);
  assert.equal(amePanel.innerHTML.includes('data-temp="split"'), false);
  assert.equal(gxlPanel.innerHTML.includes('data-temp="split"'), false);

  // Regression [v0.13.4]: slider input re-sync must not move stage nodes already in order (breaks desktop 2nd-stage drag)
  const ameList = ameCard.querySelector('.preset-stages-list');
  let domMoves = 0;
  const origAppend = ameList.appendChild.bind(ameList);
  const origInsert = ameList.insertBefore.bind(ameList);
  ameList.appendChild = (n) => { domMoves++; return origAppend(n); };
  ameList.insertBefore = (n, r) => { domMoves++; return origInsert(n, r); };
  h.ctx.syncPresetCardUI(ameCard, 'americano');
  assert.equal(domMoves, 0, 'In-order stages must not be re-inserted on sync');
  ameList.appendChild = origAppend;
  ameList.insertBefore = origInsert;

  // Swap Americano via its single swap button and confirm stage DOM, icon order, middle swap row, & badges flip
  await ameCard.querySelector('.btn-preset-swap-stages').dispatchEvent('click');
  assert.equal(state.presetTweaks.americano.seq, 'water-first');
  assert.equal(ameCard.querySelector('.drink-icon').textContent, '💧☕');
  const ameStageChildren = ameCard.querySelector('.preset-stages-list').children;
  assert.equal(ameStageChildren[1].classList.contains('stage-swap-row'), true);
  const orderedStages = ameCard.querySelectorAll('.preset-stage-item');
  assert.deepEqual(orderedStages.map(s => s.dataset.stage), ['water', 'coffee']);
  assert.equal(ameCard.querySelector('[data-stage-badge="water"]').textContent, '1st');
  assert.equal(ameCard.querySelector('[data-stage-badge="coffee"]').textContent, '2nd');

  // Matching stage temps (both Hot 0) with water-first -> single-stage custom payload 02 (water=125) then 01 (coffee=25)
  txs.length = 0;
  await h.ctx.executePresetDrink('americano', true);
  assert.equal(state.activeWorkflow, null);
  assert.equal(txs[0], '011008000002007D010019');
  assert.equal(txs[1], '03050704000000000007');

  // Distinct stage temps (Water=Warm 1, Coffee=Max 2) with water-first -> 2-stage split starting with Water (Warm 1)
  txs.length = 0;
  state.presetTweaks.americano.waterTemp = 1;
  state.presetTweaks.americano.coffeeTemp = 2;
  await h.ctx.executePresetDrink('americano', true);
  assert.equal(state.activeWorkflow.type, 'two-stage-split');
  assert.equal(state.activeWorkflow.stage1.waterMl, 125);
  assert.equal(state.activeWorkflow.stage1.temp, 1);
  assert.equal(state.activeWorkflow.stage2.coffeeMl, 25);
  assert.equal(state.activeWorkflow.stage2.temp, 2);
  assert.equal(txs[0], '011008000002007D000000');
  assert.equal(txs[1], '03050704000000000107');

  // Custom tab swap button toggles water-first <-> coffee-first while keeping swap row between stages
  await el.btnSwapCustomStages.dispatchEvent('click');
  assert.equal(state.customSequence, 'water-first');
  assert.equal(el.customStagesList.firstElementChild, el.customStageWater);
  assert.equal(el.customStagesList.children[1].id, 'customStageSwapRow');
  assert.equal(el.customStagesList.children[2], el.customStageCoffee);
  assert.equal(el.badgeCustomWaterOrder.textContent, '1st');
  assert.equal(el.badgeCustomCoffeeOrder.textContent, '2nd');
  await el.btnSwapCustomStages.dispatchEvent('click');
  assert.equal(state.customSequence, 'coffee-first');
  assert.equal(el.customStagesList.firstElementChild, el.customStageCoffee);
  assert.equal(el.customStagesList.children[1].id, 'customStageSwapRow');
  assert.equal(el.customStagesList.children[2], el.customStageWater);
});

test('Feature [v0.13.5]: Sync all 6 dial targets, persist to localStorage, and derive volume labels from machine settings', async () => {
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();
  const uuids = h.eval('BLE_UUIDS');
  const defaults = h.eval('PRESET_DRINK_DEFAULTS');

  const dialValues = { 0: 20, 1: 35, 2: 80, 3: 30, 4: 140, 5: 230 };
  const writtenTargets = [];
  state.characteristics.set(uuids.CHAR_CUP_TARGET, {});
  state.characteristics.set(uuids.CHAR_CUP_VOLUME, {});
  h.ctx.sleep = async () => {};
  h.ctx.writeBleCharacteristic = async (uuid, bytes) => {
    if (uuid === uuids.CHAR_CUP_TARGET) {
      writtenTargets.push(((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF));
    }
  };
  h.ctx.readBleCharacteristic = async (uuid) => {
    if (uuid === uuids.CHAR_CUP_VOLUME) {
      const v = dialValues[state.lastCupTargetIdx];
      return new Uint8Array([(v >> 8) & 0xFF, v & 0xFF]);
    }
    return null;
  };

  await h.ctx.readInitialTelemetry();

  assert.deepEqual(writtenTargets, [0, 1, 2, 3, 4, 5]);
  assert.equal(state.lastCupTargetIdx, null);
  assert.equal(defaults.lungo.coffeeMl, 80);
  assert.equal(defaults.americano.coffeeMl, 30);
  assert.equal(defaults.americano.waterMl, 140);
  assert.equal(defaults.hotwater.waterMl, 250);

  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 80), '(Lungo) 80 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 110), '110 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 20), '(Ristretto) 20 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 25), '25 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 35), '(Espresso) 35 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 40), '40 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 30), '(Americano) 30 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 230), '(Hot Water) 230 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 200), '200 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 140), '(Americano) 140 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 125), '125 ml');

  const lungoCard = Array.from(el.presetDrinkCards).find(c => c.dataset.drink === 'lungo');
  const ameCard = Array.from(el.presetDrinkCards).find(c => c.dataset.drink === 'americano');
  assert.equal(lungoCard.querySelector('.drink-vol').textContent, 'Rotary Dial Preset (80 ml)');
  assert.equal(ameCard.querySelector('.drink-vol').textContent, 'Rotary Dial Preset (30ml + 140ml)');

  const saved = JSON.parse(h.storage.get('notpresso_machine_dial_v2'));
  assert.equal(saved[2], 80);
  assert.equal(saved[3], 30);
  assert.equal(saved[4], 140);
  assert.equal(saved[5], 230);

  h.ctx.applyMachineCupTargetVolume(2, 70);
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 70), '(Lungo) 70 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 80), '80 ml');

  // Offline boot restores stored personalized machine volumes before UI init
  const h2 = createAppHarness({
    initialStorage: {
      notpresso_machine_dial_v2: JSON.stringify({ 0: 20, 1: 35, 2: 70, 3: 30, 4: 140, 5: 230 })
    }
  });
  const d2 = h2.eval('PRESET_DRINK_DEFAULTS');
  assert.equal(d2.lungo.coffeeMl, 70);
  assert.equal(d2.hotwater.waterMl, 250);
  assert.equal(h2.ctx.formatPresetVolumeLabel('coffee', 70), '(Lungo) 70 ml');
  assert.equal(h2.ctx.formatPresetVolumeLabel('coffee', 110), '110 ml');
  assert.equal(h2.ctx.formatPresetVolumeLabel('water', 230), '(Hot Water) 230 ml');
  assert.equal(h2.ctx.formatPresetVolumeLabel('water', 140), '(Americano) 140 ml');
});

test('Feature [v0.13.6]: Offline boot and quick calibration profile toggle sync select options, chips, and Presets without BLE', () => {
  const h = createAppHarness();
  const el = h.getEl();
  const defaults = h.eval('PRESET_DRINK_DEFAULTS');
  const lungoOpt = el.selectCupTarget.options[2];

  // Clean boot uses My App Calibration consistently across dropdown text, hints, Presets, and labels
  assert.equal(lungoOpt.dataset.def, '80');
  assert.match(lungoOpt.textContent, /Default 80ml/);
  assert.equal(el.btnProfileAppCalibration.classList.contains('active-chip'), true);
  assert.equal(el.btnProfileFactoryDefaults.classList.contains('active-chip'), false);
  assert.equal(defaults.lungo.coffeeMl, 80);
  assert.equal(defaults.americano.coffeeMl, 40);
  assert.equal(defaults.americano.waterMl, 140);
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 80), '(Lungo) 80 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 110), '110 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 230), '(Hot Water) 230 ml');

  // Switching to Factory Defaults without machine connect updates everything and persists across reboot
  h.ctx.applyFactoryDefaultsProfile();
  assert.equal(lungoOpt.dataset.def, '110');
  assert.match(lungoOpt.textContent, /Default 110ml/);
  assert.equal(el.btnProfileFactoryDefaults.classList.contains('active-chip'), true);
  assert.equal(el.btnProfileAppCalibration.classList.contains('active-chip'), false);
  assert.equal(defaults.lungo.coffeeMl, 110);
  assert.equal(h.ctx.formatPresetVolumeLabel('coffee', 110), '(Lungo) 110 ml');
  assert.equal(h.ctx.formatPresetVolumeLabel('water', 200), '(Hot Water) 200 ml');

  const persisted = h.storage.get('notpresso_machine_dial_v2');
  const hReload = createAppHarness({ initialStorage: { notpresso_machine_dial_v2: persisted } });
  const elReload = hReload.getEl();
  assert.equal(elReload.selectCupTarget.options[2].dataset.def, '110');
  assert.match(elReload.selectCupTarget.options[2].textContent, /Default 110ml/);
  assert.equal(elReload.btnProfileFactoryDefaults.classList.contains('active-chip'), true);
  assert.equal(elReload.btnProfileAppCalibration.classList.contains('active-chip'), false);
  assert.equal(hReload.ctx.formatPresetVolumeLabel('coffee', 110), '(Lungo) 110 ml');
});

test('Fix [#24]: Copy Logs exports newline-delimited #logConsole entries only', async () => {
  let copied = '';
  const h = createAppHarness({
    navigator: {
      clipboard: {
        writeText: async (text) => { copied = text; }
      }
    }
  });
  const el = h.getEl();
  h.ctx.log('Line one', 'info');
  h.ctx.log('Line two', 'tx');

  await el.btnCopyLogs.dispatchEvent('click');
  const lines = copied.split('\n');
  assert.equal(lines.length >= 2, true);
  assert.match(lines[lines.length - 2], /Line one$/);
  assert.match(lines[lines.length - 1], /Line two$/);
});

test('Fix [#29]: #logConsole trims oldest entries beyond MAX_LOG_ENTRIES', () => {
  const h = createAppHarness();
  const el = h.getEl();
  const maxEntries = h.eval('MAX_LOG_ENTRIES');
  for (let i = 1; i <= maxEntries + 25; i += 1) {
    h.ctx.log(`msg-${i}`, 'info');
  }
  assert.equal(el.logConsole.children.length, maxEntries);
  assert.match(el.logConsole.firstElementChild.textContent, /msg-26$/);
  assert.match(el.logConsole.children[maxEntries - 1].textContent, new RegExp(`msg-${maxEntries + 25}$`));
});

test('Fix [#21]: Non-0x24 CommandResponse frames with 0xC0 header bits do not trigger fake rejection', () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const el = h.getEl();
  state.activeWorkflow = { type: 'two-stage-split', stage: 1 };
  el.brewModal.classList.remove('hidden');

  const statusFrame = new Uint8Array([0xC0, 0x00, 0x01, 0x22, 0x00, 0x04, ...new Array(14).fill(0)]);
  h.ctx.decodeCommandResponse(statusFrame);

  assert.notEqual(state.activeWorkflow, null);
  assert.equal(el.brewModal.classList.contains('hidden'), false);
  assert.equal(el.ledTelematicsBanner.classList.contains('led-state-err'), false);
});

test('Fix [#22]: Split-temp Stage 2 GATT rejection clears workflow cleanly instead of throwing', async () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const el = h.getEl();
  h.ctx.writeBleCharacteristic = async () => { throw new Error('GATT write failed'); };
  state.activeWorkflow = {
    type: 'two-stage-split',
    stage: 1,
    sawBrewing: true,
    stage2Triggered: false,
    stage2: { coffeeMl: 40, waterMl: 0, temp: 2, label: 'Stage 2/2: 40ml Coffee' }
  };

  await h.ctx.handleWorkflowStatusUpdate(4, 2, false);
  assert.equal(state.activeWorkflow, null);
  assert.equal(state.isBrewing, false);
  assert.match(el.toast.textContent, /Stage 2 error: GATT write failed/);
});

test('Fix [#25]: disconnectBle logs once and reconnect does not stack characteristic listeners', async () => {
  const charListeners = new Set();
  let connected = true;
  const statusChar = {
    async readValue() { return { buffer: new Uint8Array([0, 2, 0, 0, 0, 0]).buffer }; },
    async writeValueWithResponse() {},
    async startNotifications() {},
    addEventListener(type, fn) { if (type === 'characteristicvaluechanged') charListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'characteristicvaluechanged') charListeners.delete(fn); }
  };
  const deviceListeners = new Set();
  const mockDevice = {
    name: 'Expert-Reconnect',
    addEventListener(type, fn) { if (type === 'gattserverdisconnected') deviceListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'gattserverdisconnected') deviceListeners.delete(fn); },
    gatt: {
      get connected() { return connected; },
      async connect() {
        connected = true;
        return { async getPrimaryService() { return { async getCharacteristic() { return statusChar; } }; } };
      },
      disconnect() {
        connected = false;
        for (const fn of Array.from(deviceListeners)) fn();
      }
    }
  };

  const h = createAppHarness({
    navigator: { bluetooth: { requestDevice: async () => mockDevice } }
  });
  const el = h.getEl();
  h.ctx.sleep = async () => {};

  await h.ctx.connectBle();
  await h.ctx.disconnectBle();
  // Calling onDisconnected again (e.g. delayed native event) must be ignored
  h.ctx.onDisconnected();

  const disconnectLogs = Array.from(el.logConsole.children).filter(n => n.textContent.includes('Disconnected from machine.'));
  assert.equal(disconnectLogs.length, 1);
  assert.equal(charListeners.size, 0);

  // Reconnect twice on same cached device must keep exactly 1 listener per notify UUID (3 total)
  await h.ctx.connectBle();
  assert.equal(deviceListeners.size, 1);
  assert.equal(charListeners.size, 3);
});

test('Fix [#26]: readInitialTelemetry logs dial slot values and warns on read errors', async () => {
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();
  const uuids = h.eval('BLE_UUIDS');
  h.ctx.sleep = async () => {};

  state.characteristics.set(uuids.CHAR_CUP_TARGET, {});
  state.characteristics.set(uuids.CHAR_CUP_VOLUME, {});
  h.ctx.writeBleCharacteristic = async () => {};
  h.ctx.readBleCharacteristic = async (uuid) => {
    if (uuid === uuids.CHAR_CUP_VOLUME) {
      if (state.lastCupTargetIdx === 1) throw new Error('dial-read-timeout');
      return new Uint8Array([0x00, 0x50]); // 80 ml
    }
    throw new Error('telemetry-unavailable');
  };

  await h.ctx.readInitialTelemetry();
  const logs = Array.from(el.logConsole.children).map(n => n.textContent);
  assert.equal(logs.some(l => l.includes('Initial read 3a12 failed: telemetry-unavailable')), true);
  assert.equal(logs.some(l => l.includes('[06aa3a24 Dial 0] 80 ml (00 50)')), true);
  assert.equal(logs.some(l => l.includes('Initial dial 1 read failed: dial-read-timeout')), true);
});

test('Fix [v0.14.1]: BLE debug logging covers masked rejections, short/unknown RX, fallbacks, and handshake warns', async () => {
  const h = createAppHarness({ deferTimeouts: true });
  const state = h.getState();
  const el = h.getEl();
  h.ctx.sleep = async () => {};

  // 1. Rejection bytes[3]=0x24 MUST NOT be masked when bytes[0] has 0x80 high nibble
  const maskedRej = new Uint8Array([0x81, 0x10, 0x01, 0x24, 0x08, ...new Array(15).fill(0)]);
  h.ctx.decodeCommandResponse(maskedRej);
  assert.equal(el.ledTelematicsBanner.classList.contains('led-state-err'), true);

  // 2. Empty/short/unknown RX frames and 06aa3a22 slider log full raw hex
  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_SLIDER'), new Uint8Array([0x01, 0x02]));
  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_MACHINE_INFO'), new Uint8Array([0x01, 0x02]));
  h.ctx.handleRawCharacteristicBytes('06aa9999-f22a-11e3-9daa-0002a5d5c51b', new Uint8Array([0xAA, 0xBB]));
  h.ctx.handleRawCharacteristicBytes(h.eval('BLE_UUIDS.CHAR_STOCK'), new Uint8Array([]));

  // 3. Handshake warns instead of silently swallowing 3a51 / 3a61 errors
  h.ctx.readBleCharacteristic = async () => { throw new Error('3a51-read-err'); };
  h.ctx.writeBleCharacteristic = async (uuid) => {
    if (uuid === h.eval('BLE_UUIDS.CHAR_TX_LEVEL')) throw new Error('3a61-write-err');
  };
  await h.ctx.performAuthHandshake(true);

  // 4. Fallback timer logs reason + launches Stage 2
  h.ctx.startBrewTracking('Stage 1', 'sub', 10);
  state.machineState = 2;
  state.brewStartTime = Date.now() - 60_000;
  state.activeWorkflow = {
    type: 'two-stage-split',
    stage: 1,
    stage2Triggered: false,
    stage2: { coffeeMl: 40, waterMl: 0, temp: 2, label: 'Stage 2/2: 40ml Coffee' }
  };
  const fallbackTimer = Array.from(h.activeIntervals.values()).pop();
  await fallbackTimer.fn();

  const logs = Array.from(el.logConsole.children).map(n => n.textContent);
  assert.equal(logs.some(l => l.includes('[06aa3a52 Command Rejected]') && l.includes('81 10 01 24 08')), true);
  assert.equal(logs.some(l => l.includes('[06aa3a22 Slider] CLOSED (01 02)')), true);
  assert.equal(logs.some(l => l.includes('[BLE RX 3a21] Unhandled/short (2B): 01 02')), true);
  assert.equal(logs.some(l => l.includes('[BLE RX 9999] Unhandled/short (2B): AA BB')), true);
  assert.equal(logs.some(l => l.includes('[BLE RX 3a15] Empty payload')), true);
  assert.equal(logs.some(l => l.includes('[06aa3a51] Read failed: 3a51-read-err')), true);
  assert.equal(logs.some(l => l.includes('TX Level [0x01] note: 3a61-write-err')), true);
  assert.equal(logs.some(l => l.includes('Brew fallback timer fired (workflow=two-stage-split')), true);
  assert.equal(logs.some(l => l.includes('Launching Stage 2 (fallback timer): Stage 2/2: 40ml Coffee')), true);
});

test('Fix [v0.14.2]: Live telematics, optional 3a24 notify, and dial write readback verification logs', async () => {
  const fetchBodies = [];
  const h = createAppHarness({ deferTimeouts: true });
  h.ctx.window = { location: { hostname: 'localhost' } };
  h.ctx.fetch = async (_url, opts) => { fetchBodies.push(JSON.parse(opts.body).line); };
  h.ctx.sleep = async () => {};

  const state = h.getState();
  const el = h.getEl();
  const uuids = h.eval('BLE_UUIDS');

  // 1. 06aa3a12 status logs lid, tank, bin, stock, sched, pair, obs, boot, evt + [Telematics] once per title change
  h.ctx.handleRawCharacteristicBytes(uuids.CHAR_MACHINE_STATUS, new Uint8Array([0xC5, 0x42, 0x1A, 0x35, 0x40, 0x00]));
  h.ctx.handleRawCharacteristicBytes(uuids.CHAR_MACHINE_STATUS, new Uint8Array([0xC5, 0x42, 0x1A, 0x35, 0x40, 0x00]));
  h.ctx.handleRawCharacteristicBytes(uuids.CHAR_MACHINE_STATUS, new Uint8Array([0x00, 0x02, 0x00, 0x00, 0x00, 0x00]));
  h.ctx.handleRawCharacteristicBytes(uuids.CHAR_SLIDER, new Uint8Array([0x00]));

  // 2. writeDialCupSize performs +250ms & re-select +1.4s readback, detects mismatch, and syncs machine value
  state.isConnected = true;
  el.selectCupTarget.value = '4';
  el.inputCupVolume.value = '140';
  let readCalls = 0;
  let lastTarget = null;
  const cupTargetChar = { properties: { read: true }, async writeValueWithResponse() {} };
  const cupVolChar = { properties: { notify: true }, async writeValueWithResponse() {} };
  state.characteristics.set(uuids.CHAR_CUP_TARGET, cupTargetChar);
  state.characteristics.set(uuids.CHAR_CUP_VOLUME, cupVolChar);
  h.ctx.writeBleCharacteristic = async (uuid, bytes) => {
    if (uuid === uuids.CHAR_CUP_TARGET) lastTarget = bytes;
  };
  h.ctx.readBleCharacteristic = async (uuid) => {
    if (uuid === uuids.CHAR_CUP_TARGET) return lastTarget;
    if (uuid === uuids.CHAR_CUP_VOLUME) {
      readCalls++;
      return new Uint8Array([0x00, 0x28, 0x00, 0x00]); // machine still returns 40 ml instead of 140 ml
    }
    return null;
  };
  await h.ctx.writeDialCupSize();
  assert.equal(readCalls, 2);
  assert.equal(state.machineDialVolumes[4], 40);

  // 3. Optional 3a24 notify subscribes when properties.notify === true
  let notifySubscribed = false;
  const mockNotifyVolChar = {
    properties: { notify: true },
    async startNotifications() { notifySubscribed = true; },
    addEventListener() {},
    removeEventListener() {}
  };
  const mockServer = {
    async getPrimaryService() {
      return {
        async getCharacteristic(uuid) {
          if (uuid === uuids.CHAR_CUP_VOLUME) return mockNotifyVolChar;
          return {
            async startNotifications() {},
            addEventListener() {},
            removeEventListener() {}
          };
        }
      };
    }
  };
  await h.ctx.discoverAllCharacteristics(mockServer);
  assert.equal(notifySubscribed, true);

  h.ctx.applyAppCalibrationProfile();

  const logs = Array.from(el.logConsole.children).map(n => n.textContent);
  assert.equal(logs.some(l => l.includes('[06aa3a12 Status]') && l.includes('lid=OPEN') && l.includes('tank=EMPTY') && l.includes('boot=1') && l.includes('evt=1/1/1')), true);
  assert.equal(logs.filter(l => l.includes('[Telematics]')).length, 2);
  assert.equal(logs.some(l => l.includes('[06aa3a22 Slider] OPEN (00) | lid=OPEN')), true);
  assert.equal(logs.some(l => l.includes('[DEBUG-cup] Re-select+Readback +1.4s: Dial 4 -> 40 ml (00 28 00 00) vs req=140 ml (MISMATCH)')), true);
  assert.equal(logs.some(l => l.includes('[DEBUG-cup] Quick profile UI-only')), true);
  assert.equal(fetchBodies.length > 0, true);
});

test('Fix [v0.14.3]: auth runs before notifications, retries in-progress WinRT errors, guards scanning, and cleans up failed GATT', async () => {
  const events = [];
  let connected = false;
  let gattAttempts = 0;
  let authReadAttempts = 0;
  let authWriteAttempts = 0;
  let failFatal = false;
  const charListeners = new Map();

  function makeChar(uuid) {
    return {
      async readValue() {
        if (uuid === h.eval('BLE_UUIDS.CHAR_AUTH_TYPE')) {
          authReadAttempts++;
          if (authReadAttempts === 1) throw new Error('Connection already in progress.');
          events.push('auth-read');
          return { buffer: new Uint8Array([0x02]).buffer };
        }
        if (uuid === h.eval('BLE_UUIDS.CHAR_CUP_VOLUME')) return { buffer: new Uint8Array([0x00, 0x28]).buffer };
        return { buffer: new Uint8Array([0x00]).buffer };
      },
      async writeValueWithResponse() {
        if (uuid === h.eval('BLE_UUIDS.CHAR_AUTH')) {
          authWriteAttempts++;
          if (failFatal) {
            const e = new Error('Connection already in progress.');
            e.name = 'NetworkError';
            throw e;
          }
          if (authWriteAttempts === 1) throw new Error('Connection already in progress.');
          events.push('auth-write');
        }
      },
      async startNotifications() {
        events.push(`notify:${uuid.substring(4, 8)}`);
      },
      addEventListener(type, fn) { if (type === 'characteristicvaluechanged') charListeners.set(uuid, fn); },
      removeEventListener(type) { if (type === 'characteristicvaluechanged') charListeners.delete(uuid); }
    };
  }

  let requestCount = 0;
  const deviceListeners = new Set();
  const mockDevice = {
    name: 'Expert-WinRT',
    addEventListener(type, fn) { if (type === 'gattserverdisconnected') deviceListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'gattserverdisconnected') deviceListeners.delete(fn); },
    gatt: {
      get connected() { return connected; },
      async connect() {
        gattAttempts++;
        if (gattAttempts === 1) throw new Error('Connection already in progress.');
        connected = true;
        return { async getPrimaryService() { return { async getCharacteristic(uuid) { return makeChar(uuid); } }; } };
      },
      disconnect() {
        connected = false;
        events.push('gatt-disconnect');
      }
    }
  };

  let resolveScan;
  const h = createAppHarness({
    navigator: {
      bluetooth: {
        requestDevice() {
          requestCount++;
          if (requestCount === 1) return new Promise((r) => { resolveScan = r; });
          return Promise.resolve(mockDevice);
        }
      }
    }
  });
  h.ctx.sleep = async () => {};
  const state = h.getState();
  const el = h.getEl();

  // 1. Overlapping click while isScanning must be ignored
  const firstConnect = h.ctx.connectBle();
  await h.ctx.connectBle();
  assert.equal(requestCount, 1);
  resolveScan(mockDevice);
  await firstConnect;

  assert.equal(state.isConnected, true);
  assert.equal(gattAttempts, 2);
  assert.equal(authReadAttempts, 3); // 1 fail + 1 auth retry + 1 readInitialTelemetry read
  assert.equal(authWriteAttempts, 2);
  assert.ok(events.indexOf('auth-read') < events.indexOf('notify:3a12'));
  assert.ok(events.indexOf('auth-write') < events.indexOf('notify:3a12'));

  // 2. Fatal failure on subsequent attempt must probe 3a21, disconnect half-open GATT, and clean state
  await h.ctx.disconnectBle();
  failFatal = true;
  await h.ctx.connectBle();
  assert.equal(state.isConnected, false);
  assert.equal(state.isScanning, false);
  assert.equal(connected, false);
  assert.equal(deviceListeners.size, 0);
  assert.equal(charListeners.size, 0);
  assert.equal(events.includes('gatt-disconnect'), true);
  let logs = Array.from(el.logConsole.children).map(n => n.textContent);
  assert.equal(logs.some(l => l.includes('[DEBUG-ble] Auth fail probe:')), true);
  assert.equal(logs.some(l => l.includes('Connection error: NetworkError: Connection already in progress. (gattConnected=true)')), true);

  // 3. Early GATT drop during Service 1910 discovery must abort cleanly instead of reporting missing 3a41
  failFatal = false;
  let dropDuringDiscover = true;
  const dropServer = {
    async getPrimaryService() {
      connected = false;
      throw new Error('GATT Server is disconnected');
    }
  };
  const origConnect = mockDevice.gatt.connect;
  mockDevice.gatt.connect = async () => {
    if (dropDuringDiscover) { connected = true; return dropServer; }
    return origConnect();
  };
  await h.ctx.connectBle();
  dropDuringDiscover = false;
  logs = Array.from(el.logConsole.children).map(n => n.textContent);
  assert.equal(logs.some(l => l.includes('Connection error: GATT disconnected before Service 1910 auth was ready (gattConnected=false)')), true);
  assert.equal(logs.some(l => l.includes('Characteristic 3a41 not available')), false);

  // 4. Clear Logs red button tracks live event count and resets to Clear 0 Events
  assert.equal(el.btnClearLogs.textContent, `Clear ${el.logConsole.children.length} Events`);
  await el.btnClearLogs.dispatchEvent('click');
  assert.equal(el.btnClearLogs.textContent, 'Clear 0 Events');
  assert.equal(el.logConsole.children.length, 0);
});

test('Fix [v0.14.5]: Quick calibration profiles do not overwrite machineDialVolumes while connected', async () => {
  const h = createAppHarness();
  const state = h.getState();
  const el = h.getEl();
  state.isConnected = true;
  state.machineDialVolumes = { 0: 25, 1: 40, 2: 80, 3: 40, 4: 167, 5: 230 };
  el.selectCupTarget.value = '4';
  h.ctx.updateCupRangeHint();
  assert.equal(el.btnProfileFactoryDefaults.textContent, '🏭 Factory Default: 125 ml');
  assert.equal(el.btnProfileAppCalibration.textContent, '📱 App Calibration: 140 ml');
  assert.equal(el.btnProfileAppCalibration.classList.contains('active-chip'), false);
  h.ctx.applyAppCalibrationProfile();
  assert.equal(el.inputCupVolume.value, '140');
  assert.equal(el.valCupTargetMl.textContent, '140 ml');
  assert.equal(state.machineDialVolumes[4], 167);
  assert.equal(el.btnProfileAppCalibration.classList.contains('active-chip'), true);
});

// Execute all tests sequentially
let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n  -> ${err.stack || err.message}`);
  }
}

console.log(`\nSummary: ${passed} passed, ${failed} failed (${tests.length} total)`);
if (failed > 0) process.exit(1);
