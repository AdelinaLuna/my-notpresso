import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'expert_ble_constants.dart';

/// Dart BLE Service for Nespresso Expert EN 350.G
/// Can be dropped into any Flutter application using flutter_blue_plus.
class ExpertBleService extends ChangeNotifier {
  BluetoothDevice? _device;
  StreamSubscription<BluetoothConnectionState>? _connSub;
  StreamSubscription<List<int>>? _statusSub;

  BluetoothCharacteristic? _charAuth;
  BluetoothCharacteristic? _charCommand;
  BluetoothCharacteristic? _charMachineStatus;
  BluetoothCharacteristic? _charAuthType;
  BluetoothCharacteristic? _charTxLevel;
  BluetoothCharacteristic? _charCapsules;

  bool _isConnected = false;
  bool _isScanning = false;
  int _machineStateCode = 0;
  String _pairingState = 'NONE';
  int? _capsuleCount;

  bool get isConnected => _isConnected;
  bool get isScanning => _isScanning;
  String get machineState => _machineStateCode < ExpertBleConstants.machineStates.length
      ? ExpertBleConstants.machineStates[_machineStateCode]
      : 'UNKNOWN';
  String get pairingState => _pairingState;
  int? get capsuleCount => _capsuleCount;

  // 1. Scan & Connect
  Future<void> startScanAndConnect() async {
    if (_isScanning || _isConnected) return;
    _isScanning = true;
    notifyListeners();

    try {
      await FlutterBluePlus.startScan(
        timeout: const Duration(seconds: 10),
        withKeywords: ['Expert', 'Prodigio', 'EN350', 'EN 350', 'Nespresso'],
      );

      final subscription = FlutterBluePlus.scanResults.listen((results) async {
        for (final r in results) {
          final name = r.device.platformName.toUpperCase();
          if (name.contains('EXPERT') || name.contains('PRODIGIO') || name.contains('EN350')) {
            await FlutterBluePlus.stopScan();
            _isScanning = false;
            await connect(r.device);
            break;
          }
        }
      });

      // Auto cancel after timeout
      Future.delayed(const Duration(seconds: 10), () {
        subscription.cancel();
        if (_isScanning) {
          _isScanning = false;
          notifyListeners();
        }
      });
    } catch (e) {
      debugPrint('[ExpertBLE] Scan error: $e');
      _isScanning = false;
      notifyListeners();
    }
  }

  Future<void> connect(BluetoothDevice device, {String? authKeyHex}) async {
    await disconnect();
    _device = device;

    _connSub = device.connectionState.listen((state) async {
      if (state == BluetoothConnectionState.connected) {
        await _setupGattAndAuth(device, authKeyHex: authKeyHex);
      } else if (state == BluetoothConnectionState.disconnected) {
        _handleDisconnect();
      }
    });

    try {
      await device.connect(timeout: const Duration(seconds: 8));
    } catch (e) {
      debugPrint('[ExpertBLE] Connect error: $e');
      _handleDisconnect();
    }
  }

  Future<void> _setupGattAndAuth(BluetoothDevice device, {String? authKeyHex}) async {
    try {
      final services = await device.discoverServices();
      for (final s in services) {
        final sUuid = s.uuid.str128.toLowerCase();
        if (sUuid == ExpertBleConstants.deviceInfoAuthService.toLowerCase()) {
          for (final c in s.characteristics) {
            final cUuid = c.uuid.str128.toLowerCase();
            if (cUuid == ExpertBleConstants.charAuthKey.toLowerCase()) _charAuth = c;
            if (cUuid == ExpertBleConstants.charAuthType.toLowerCase()) _charAuthType = c;
            if (cUuid == ExpertBleConstants.charTxLevelRequest.toLowerCase()) _charTxLevel = c;
          }
        } else if (sUuid == ExpertBleConstants.statusControlService.toLowerCase()) {
          for (final c in s.characteristics) {
            final cUuid = c.uuid.str128.toLowerCase();
            if (cUuid == ExpertBleConstants.charMachineStatus.toLowerCase()) _charMachineStatus = c;
            if (cUuid == ExpertBleConstants.charCommandReq.toLowerCase()) _charCommand = c;
            if (cUuid == ExpertBleConstants.charCapsuleCount.toLowerCase()) _charCapsules = c;
          }
        }
      }

      if (_charAuth == null || _charCommand == null) {
        debugPrint('[ExpertBLE] Missing critical GATT characteristics.');
        await disconnect();
        return;
      }

      // Perform Handshake
      final key = authKeyHex ?? ExpertBleConstants.defaultPairedCmid;
      final keyBytes = _hexToBytes(key);

      // Check pairing code if status is readable
      if (_charMachineStatus != null) {
        final statusBytes = await _charMachineStatus!.read();
        if (statusBytes.isNotEmpty) {
          final pairingCode = (statusBytes[0] & 0x60) >> 5;
          if (pairingCode != 2 && _charTxLevel != null) {
            await _charTxLevel!.write([0x01]);
          }
        }
      }

      // Write Auth Key to 06aa3a41
      await _charAuth!.write(keyBytes, withoutResponse: false);
      debugPrint('[ExpertBLE] Auth key successfully written.');

      // Subscribe to machine status notifications
      if (_charMachineStatus != null) {
        await _charMachineStatus!.setNotifyValue(true);
        _statusSub = _charMachineStatus!.onValueReceived.listen(_handleStatusPacket);
        final initialStatus = await _charMachineStatus!.read();
        _handleStatusPacket(initialStatus);
      }

      _isConnected = true;
      notifyListeners();
    } catch (e) {
      debugPrint('[ExpertBLE] Handshake error: $e');
      await disconnect();
    }
  }

  void _handleStatusPacket(List<int> data) {
    if (data.length < 2) return;
    final b0 = data[0] & 0xFF;
    final b1 = data[1] & 0xFF;

    final pairingCode = (b0 & 0x60) >> 5;
    _machineStateCode = b1 & 0x0F;
    _pairingState = pairingCode < ExpertBleConstants.pairingStates.length
        ? ExpertBleConstants.pairingStates[pairingCode]
        : 'UNKNOWN';

    notifyListeners();
  }

  // 2. Standard Brew Command
  // Payload: [0x03, 0x05, 0x07, 0x04, 0x00, 0x00, 0x00, 0x00, tempByte, sizeByte]
  Future<void> brewPreset({required int sizeCode, int tempCode = ExpertBleConstants.tempHot}) async {
    if (!_isConnected || _charCommand == null) return;
    final payload = [
      0x03, 0x05, 0x07, 0x04,
      0x00, 0x00, 0x00, 0x00,
      tempCode & 0xFF,
      sizeCode & 0xFF
    ];
    await _charCommand!.write(payload, withoutResponse: false);
    debugPrint('[ExpertBLE] Brew preset dispatched: $payload');
  }

  // 3. Custom Recipe Brew Command
  // Step 1: Write [0x01, 0x10, 0x08, 0x00, 0x00, 0x01, coffee_hi, coffee_lo, 0x02, water_hi, water_lo]
  // Step 2: Write [0x03, 0x05, 0x07, 0x04, 0x00, 0x00, 0x00, 0x00, tempByte, 0x07]
  Future<void> brewCustomRecipe({
    required int coffeeMl,
    required int waterMl,
    int tempCode = ExpertBleConstants.tempHot
  }) async {
    if (!_isConnected || _charCommand == null) return;

    final coffeeHi = (coffeeMl >> 8) & 0xFF;
    final coffeeLo = coffeeMl & 0xFF;
    final waterHi = (waterMl >> 8) & 0xFF;
    final waterLo = waterMl & 0xFF;

    final recipePayload = [
      0x01, 0x10, 0x08, 0x00, 0x00,
      0x01, coffeeHi, coffeeLo,
      0x02, waterHi, waterLo
    ];

    await _charCommand!.write(recipePayload, withoutResponse: false);
    await Future.delayed(const Duration(milliseconds: 250));

    final execPayload = [
      0x03, 0x05, 0x07, 0x04,
      0x00, 0x00, 0x00, 0x00,
      tempCode & 0xFF,
      ExpertBleConstants.cupRecipe
    ];

    await _charCommand!.write(execPayload, withoutResponse: false);
    debugPrint('[ExpertBLE] Custom Recipe executed: ${coffeeMl}ml coffee, ${waterMl}ml water');
  }

  // 4. Emergency Stop
  // Payload: [0x01, 0x00]
  Future<void> emergencyStop() async {
    if (_charCommand == null) return;
    await _charCommand!.write([0x01, 0x00], withoutResponse: false);
    debugPrint('[ExpertBLE] Emergency Stop executed.');
  }

  Future<void> disconnect() async {
    await _statusSub?.cancel();
    _statusSub = null;
    await _connSub?.cancel();
    _connSub = null;
    if (_device != null) {
      try { await _device!.disconnect(); } catch (_) {}
      _device = null;
    }
    _handleDisconnect();
  }

  void _handleDisconnect() {
    _isConnected = false;
    _isScanning = false;
    _charAuth = null;
    _charCommand = null;
    _charMachineStatus = null;
    _charAuthType = null;
    _charTxLevel = null;
    _charCapsules = null;
    notifyListeners();
  }

  List<int> _hexToBytes(String hex) {
    final clean = hex.replaceAll(' ', '').trim();
    final bytes = <int>[];
    for (int i = 0; i < clean.length; i += 2) {
      bytes.add(int.parse(clean.substring(i, i + 2), radix: 16));
    }
    return bytes;
  }
}
