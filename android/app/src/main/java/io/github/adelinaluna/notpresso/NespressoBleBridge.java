package io.github.adelinaluna.notpresso;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.webkit.JavascriptInterface;

import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Native Android BLE Engine & WebView JavascriptInterface Bridge for Nespresso Expert EN 350.G.
 * Implements the exact GATT onboarding, authentication, and command queue reverse-engineered
 * from Nespresso Android 3.28.0 (classes5.dex com.nestle.connecteddevices.nespresso).
 */
@SuppressLint("MissingPermission")
public class NespressoBleBridge {
    public static final UUID UUID_SERVICE_AUTH = UUID.fromString("06aa1910-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_SERVICE_CTRL = UUID.fromString("06aa1920-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_SERVICE_CUPS = UUID.fromString("06aa1940-f22a-11e3-9daa-0002a5d5c51b");

    public static final UUID UUID_CHAR_MACHINE_INFO = UUID.fromString("06aa3a21-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_SERIAL       = UUID.fromString("06aa3a31-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_AUTH         = UUID.fromString("06aa3a41-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_KEY_STATE    = UUID.fromString("06aa3a51-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_TX_LEVEL     = UUID.fromString("06aa3a61-f22a-11e3-9daa-0002a5d5c51b");

    public static final UUID UUID_CHAR_STATUS       = UUID.fromString("06aa3a12-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_SLIDER       = UUID.fromString("06aa3a22-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_COMMAND      = UUID.fromString("06aa3a42-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_CMD_RESP     = UUID.fromString("06aa3a52-f22a-11e3-9daa-0002a5d5c51b");

    public static final UUID UUID_CHAR_CUP_TARGET   = UUID.fromString("06aa3a14-f22a-11e3-9daa-0002a5d5c51b");
    public static final UUID UUID_CHAR_CUP_VOLUME   = UUID.fromString("06aa3a24-f22a-11e3-9daa-0002a5d5c51b");

    public static final UUID UUID_CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final MainActivity activity;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, String> cachedValues = new ConcurrentHashMap<>();
    private final Map<UUID, BluetoothGattCharacteristic> charMap = new HashMap<>();
    private final Queue<Runnable> gattQueue = new LinkedList<>();
    private boolean gattBusy = false;

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner bleScanner;
    private BluetoothGatt currentGatt;
    private boolean isScanning = false;
    private String currentAuthKeyHex = "82C15F832A864437";

    public NespressoBleBridge(MainActivity activity) {
        this.activity = activity;
        BluetoothManager bm = (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm != null) {
            this.bluetoothAdapter = bm.getAdapter();
        }
    }

    @JavascriptInterface
    public void setAuthKey(String keyHex) {
        this.currentAuthKeyHex = PairingKeyCodec.normalizeKeyHex(keyHex);
    }

    @JavascriptInterface
    public void startScan() {
        mainHandler.post(() -> {
            if (!activity.ensureBlePermissions()) {
                sendLog("Waiting for Bluetooth permissions...", "warn");
                return;
            }
            if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
                sendToast("Please turn ON Bluetooth on your phone!");
                sendLog("Bluetooth adapter is disabled.", "err");
                return;
            }

            // 1. Report any already-bonded Nespresso devices immediately
            try {
                Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
                if (bonded != null) {
                    for (BluetoothDevice dev : bonded) {
                        String name = dev.getName();
                        if (isLikelyNespresso(name, null)) {
                            emitScanResult(dev.getAddress(), name != null ? name : "Bonded Nespresso", 0, true);
                        }
                    }
                }
            } catch (Exception e) {
                sendLog("Bonded device check warning: " + e.getMessage(), "warn");
            }

            // 2. Start live BLE scan
            bleScanner = bluetoothAdapter.getBluetoothLeScanner();
            if (bleScanner == null) {
                sendLog("BluetoothLeScanner unavailable.", "err");
                return;
            }
            if (isScanning) {
                try { bleScanner.stopScan(scanCallback); } catch (Exception ignored) {}
            }
            isScanning = true;
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
            bleScanner.startScan(null, settings, scanCallback);
            sendLog("Native Android BLE scan started (LOW_LATENCY)...", "info");

            // Auto-stop scan after 15 seconds
            mainHandler.postDelayed(this::stopScanInternal, 15000);
        });
    }

    @JavascriptInterface
    public void stopScan() {
        mainHandler.post(this::stopScanInternal);
    }

    private void stopScanInternal() {
        if (isScanning && bleScanner != null) {
            try {
                bleScanner.stopScan(scanCallback);
            } catch (Exception ignored) {}
        }
        isScanning = false;
    }

    private boolean isLikelyNespresso(String name, ScanRecord record) {
        if (name != null) {
            String upper = name.toUpperCase(Locale.US);
            if (upper.startsWith("EXPERT") || upper.startsWith("PRODIGIO") ||
                upper.contains("NESPRESSO") || upper.contains("EN350") || upper.contains("EN 350")) {
                return true;
            }
        }
        if (record != null && record.getServiceUuids() != null) {
            for (ParcelUuid pu : record.getServiceUuids()) {
                String u = pu.getUuid().toString().toLowerCase(Locale.US);
                if (u.startsWith("06aa")) return true;
            }
        }
        return false;
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice dev = result.getDevice();
            if (dev == null) return;
            String name = dev.getName();
            if (name == null && result.getScanRecord() != null) {
                name = result.getScanRecord().getDeviceName();
            }
            if (isLikelyNespresso(name, result.getScanRecord())) {
                emitScanResult(dev.getAddress(), name != null ? name : "Nespresso BLE", result.getRssi(), false);
            }
        }
    };

    @JavascriptInterface
    public void connectDevice(String address, String authKeyHex) {
        if (authKeyHex != null && !authKeyHex.isEmpty()) {
            this.currentAuthKeyHex = PairingKeyCodec.normalizeKeyHex(authKeyHex);
        }
        mainHandler.post(() -> {
            stopScanInternal();
            if (currentGatt != null) {
                try {
                    currentGatt.disconnect();
                    currentGatt.close();
                } catch (Exception ignored) {}
                currentGatt = null;
            }
            try {
                BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);
                sendLog("Connecting to " + address + " over TRANSPORT_LE...", "info");
                currentGatt = device.connectGatt(activity, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            } catch (Exception e) {
                sendLog("connectGatt failed: " + e.getMessage(), "err");
                sendToast("Connect error: " + e.getMessage());
            }
        });
    }

    @JavascriptInterface
    public void disconnect() {
        mainHandler.post(() -> {
            synchronized (gattQueue) {
                gattQueue.clear();
                gattBusy = false;
            }
            if (currentGatt != null) {
                try {
                    currentGatt.disconnect();
                    currentGatt.close();
                } catch (Exception ignored) {}
                currentGatt = null;
            }
            emitEvent("disconnected", "{}");
        });
    }

    @JavascriptInterface
    public void pairWithNewKey(String newKeyHex) {
        this.currentAuthKeyHex = PairingKeyCodec.normalizeKeyHex(newKeyHex);
        mainHandler.post(() -> {
            if (currentGatt == null) {
                sendToast("Connect to the machine first!");
                return;
            }
            sendLog("[OnboardingAdapter] Executing pair sequence with new key: " + currentAuthKeyHex, "tx");
            enqueueWrite(UUID_CHAR_TX_LEVEL, new byte[]{0x01});
            enqueueWrite(UUID_CHAR_AUTH, PairingKeyCodec.hexToBytes(currentAuthKeyHex));
            enqueueRead(UUID_CHAR_KEY_STATE);
            enqueueRead(UUID_CHAR_STATUS);
        });
    }

    @JavascriptInterface
    public boolean writeCharacteristic(String uuidStr, String hexPayload) {
        try {
            UUID uuid = UUID.fromString(uuidStr.toLowerCase(Locale.US));
            byte[] data = PairingKeyCodec.hexToBytes(hexPayload);
            enqueueWrite(uuid, data);
            if (uuid.equals(UUID_CHAR_COMMAND)) {
                enqueueRead(UUID_CHAR_CMD_RESP);
            }
            return true;
        } catch (Exception e) {
            sendLog("writeCharacteristic error: " + e.getMessage(), "err");
            return false;
        }
    }

    @JavascriptInterface
    public String readCharacteristicSync(String uuidStr) {
        String key = uuidStr.toLowerCase(Locale.US);
        try {
            UUID uuid = UUID.fromString(key);
            enqueueRead(uuid);
        } catch (Exception ignored) {}
        return cachedValues.getOrDefault(key, "");
    }

    // Serialized GATT Queue Implementation
    private void enqueueGattOp(Runnable op) {
        synchronized (gattQueue) {
            gattQueue.add(op);
            if (!gattBusy) {
                gattBusy = true;
                mainHandler.post(this::runNextGattOp);
            }
        }
    }

    private void completeGattOp() {
        synchronized (gattQueue) {
            if (gattQueue.isEmpty()) {
                gattBusy = false;
            } else {
                mainHandler.postDelayed(this::runNextGattOp, 60);
            }
        }
    }

    private void runNextGattOp() {
        Runnable op;
        synchronized (gattQueue) {
            op = gattQueue.poll();
            if (op == null) {
                gattBusy = false;
                return;
            }
        }
        try {
            op.run();
        } catch (Exception e) {
            sendLog("GATT queue op exception: " + e.getMessage(), "warn");
            completeGattOp();
        }
    }

    private void enqueueRead(UUID uuid) {
        enqueueGattOp(() -> {
            BluetoothGattCharacteristic ch = charMap.get(uuid);
            if (currentGatt == null || ch == null) {
                completeGattOp();
                return;
            }
            if (!currentGatt.readCharacteristic(ch)) {
                completeGattOp();
            }
        });
    }

    private void enqueueWrite(UUID uuid, byte[] payload) {
        enqueueGattOp(() -> {
            BluetoothGattCharacteristic ch = charMap.get(uuid);
            if (currentGatt == null || ch == null) {
                sendLog("Cannot write to missing characteristic " + uuid, "warn");
                completeGattOp();
                return;
            }
            ch.setValue(payload);
            int props = ch.getProperties();
            if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0) {
                ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            } else if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
                ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            }
            if (!currentGatt.writeCharacteristic(ch)) {
                sendLog("writeCharacteristic returned false for " + uuid, "warn");
                completeGattOp();
            }
        });
    }

    private void enqueueEnableNotification(UUID uuid) {
        enqueueGattOp(() -> {
            BluetoothGattCharacteristic ch = charMap.get(uuid);
            if (currentGatt == null || ch == null) {
                completeGattOp();
                return;
            }
            currentGatt.setCharacteristicNotification(ch, true);
            BluetoothGattDescriptor desc = ch.getDescriptor(UUID_CCCD);
            if (desc != null) {
                desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                if (!currentGatt.writeDescriptor(desc)) {
                    completeGattOp();
                }
            } else {
                completeGattOp();
            }
        });
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                sendLog("GATT connected. Discovering services...", "info");
                mainHandler.postDelayed(gatt::discoverServices, 200);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                sendLog("GATT disconnected (status=" + status + ")", "warn");
                synchronized (gattQueue) {
                    gattQueue.clear();
                    gattBusy = false;
                }
                try { gatt.close(); } catch (Exception ignored) {}
                if (currentGatt == gatt) currentGatt = null;
                emitEvent("disconnected", "{}");
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                sendLog("Service discovery failed: status=" + status, "err");
                return;
            }
            charMap.clear();
            List<BluetoothGattService> services = gatt.getServices();
            for (BluetoothGattService svc : services) {
                for (BluetoothGattCharacteristic ch : svc.getCharacteristics()) {
                    charMap.put(ch.getUuid(), ch);
                }
            }
            sendLog("Discovered " + charMap.size() + " GATT characteristics. Reading PairingKeyState (06aa3a51)...", "info");

            String devName = gatt.getDevice().getName();
            if (devName == null) devName = gatt.getDevice().getAddress();
            emitEvent("connected", "{\"name\":\"" + escapeJson(devName) + "\",\"address\":\"" + escapeJson(gatt.getDevice().getAddress()) + "\"}");

            // Step 1: Read PairingKeyState (06aa3a51) to decide Onboarding vs Authenticate
            enqueueRead(UUID_CHAR_KEY_STATE);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            UUID uuid = characteristic.getUuid();
            byte[] val = characteristic.getValue();
            if (status == BluetoothGatt.GATT_SUCCESS && val != null) {
                String hex = PairingKeyCodec.bytesToHex(val);
                cachedValues.put(uuid.toString().toLowerCase(Locale.US), hex);
                emitCharChanged(uuid, hex);

                // Automatic AuthenticationAdapter / OnboardingAdapter state machine on first 06aa3a51 read:
                if (uuid.equals(UUID_CHAR_KEY_STATE) && val.length >= 1) {
                    int keyState = val[0] & 0xFF;
                    if (keyState == 0 || keyState == 1) {
                        // PairingKeyState.ABSENT! Machine is ready for onboarding!
                        if ("82C15F832A864437".equals(currentAuthKeyHex)) {
                            currentAuthKeyHex = PairingKeyCodec.generateValidKeyHex();
                            emitEvent("keyGenerated", "{\"key\":\"" + currentAuthKeyHex + "\"}");
                        }
                        sendLog("[OnboardingAdapter] PairingKeyState is ABSENT (" + keyState + "). Auto-onboarding with 0x8X key: " + currentAuthKeyHex, "tx");
                        enqueueWrite(UUID_CHAR_TX_LEVEL, new byte[]{0x01});
                        enqueueWrite(UUID_CHAR_AUTH, PairingKeyCodec.hexToBytes(currentAuthKeyHex));
                        enqueuePostAuthSetup();
                    } else if (keyState == 2 && !cachedValues.containsKey("auth_sent")) {
                        cachedValues.put("auth_sent", "true");
                        sendLog("[AuthenticationAdapter] PairingKeyState is PRESENT (2). Writing Credentials to 06aa3a41: " + currentAuthKeyHex, "tx");
                        enqueueWrite(UUID_CHAR_AUTH, PairingKeyCodec.hexToBytes(currentAuthKeyHex));
                        enqueuePostAuthSetup();
                    }
                }
            }
            completeGattOp();
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            UUID uuid = characteristic.getUuid();
            if (status == BluetoothGatt.GATT_SUCCESS) {
                sendLog("GATT write OK: " + uuid.toString().substring(0, 8), "tx");
            } else {
                sendLog("GATT write failed on " + uuid.toString().substring(0, 8) + " (status=" + status + "). If 06aa3a41 refused key (status 252/137/19), factory reset the machine in Settings!", "err");
            }
            completeGattOp();
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            completeGattOp();
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            UUID uuid = characteristic.getUuid();
            byte[] val = characteristic.getValue();
            if (val != null) {
                String hex = PairingKeyCodec.bytesToHex(val);
                cachedValues.put(uuid.toString().toLowerCase(Locale.US), hex);
                emitCharChanged(uuid, hex);
            }
        }
    };

    private void enqueuePostAuthSetup() {
        enqueueEnableNotification(UUID_CHAR_STATUS);
        enqueueEnableNotification(UUID_CHAR_SLIDER);
        enqueueEnableNotification(UUID_CHAR_CMD_RESP);
        enqueueRead(UUID_CHAR_STATUS);
        enqueueRead(UUID_CHAR_SLIDER);
        enqueueRead(UUID_CHAR_SERIAL);
        enqueueRead(UUID_CHAR_MACHINE_INFO);
    }

    private void emitScanResult(String address, String name, int rssi, boolean bonded) {
        String json = String.format(Locale.US,
                "{\"address\":\"%s\",\"name\":\"%s\",\"rssi\":%d,\"bonded\":%b}",
                escapeJson(address), escapeJson(name), rssi, bonded);
        emitEvent("scanResult", json);
    }

    private void emitCharChanged(UUID uuid, String hex) {
        String json = String.format(Locale.US,
                "{\"uuid\":\"%s\",\"hex\":\"%s\"}",
                uuid.toString().toLowerCase(Locale.US), hex);
        emitEvent("charChanged", json);
    }

    private void sendLog(String msg, String level) {
        String json = String.format(Locale.US,
                "{\"msg\":\"%s\",\"level\":\"%s\"}",
                escapeJson(msg), escapeJson(level));
        emitEvent("log", json);
    }

    private void sendToast(String msg) {
        String json = String.format(Locale.US, "{\"msg\":\"%s\"}", escapeJson(msg));
        emitEvent("toast", json);
    }

    private void emitEvent(String eventType, String jsonPayload) {
        mainHandler.post(() -> activity.dispatchToJs(eventType, jsonPayload));
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", " ")
                .replace("\r", "");
    }
}
