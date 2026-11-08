/// BLE Constants and UUID definitions for the Nespresso Expert EN 350.G (and Prodigio)
/// Manufactured by Eugster/Frismag AG under OEM specifications for Nespresso.
class ExpertBleConstants {
  // Primary GATT Services
  static const String deviceInfoAuthService = '06aa1910-f22a-11e3-9daa-0002a5d5c51b';
  static const String statusControlService  = '06aa1920-f22a-11e3-9daa-0002a5d5c51b';
  static const String errorService          = '06aa1930-f22a-11e3-9daa-0002a5d5c51b';

  // Characteristics under Device Info & Auth (06aa1910)
  static const String charProfileVersion   = '06aa3a11-f22a-11e3-9daa-0002a5d5c51b';
  static const String charMachineInfo      = '06aa3a21-f22a-11e3-9daa-0002a5d5c51b';
  static const String charSerialNumber     = '06aa3a31-f22a-11e3-9daa-0002a5d5c51b';
  static const String charAuthKey          = '06aa3a41-f22a-11e3-9daa-0002a5d5c51b'; // 8-byte Auth/CMID write
  static const String charAuthType         = '06aa3a51-f22a-11e3-9daa-0002a5d5c51b'; // Read: 2 = Final/Authenticated
  static const String charTxLevelRequest   = '06aa3a61-f22a-11e3-9daa-0002a5d5c51b'; // Write [0x01] for pairing

  // Characteristics under Status & Control (06aa1920)
  static const String charMachineStatus    = '06aa3a12-f22a-11e3-9daa-0002a5d5c51b'; // Read / Notify
  static const String charCapsuleCount     = '06aa3a15-f22a-11e3-9daa-0002a5d5c51b'; // Read / Notify
  static const String charCommandReq       = '06aa3a42-f22a-11e3-9daa-0002a5d5c51b'; // Write brew & custom recipe
  static const String charCommandRsp       = '06aa3a52-f22a-11e3-9daa-0002a5d5c51b'; // Notify

  // Default Paired CMID / AuthKey fallback
  static const String defaultPairedCmid = '82C15F832A864437';

  // Temperature byte parameters
  static const int tempMedium = 0x00;   // ~83°C (Warm)
  static const int tempHot = 0x01;      // ~86°C (Hot)
  static const int tempExtraHot = 0x02; // ~89°C (Extra Hot)

  // Cup size byte parameters for standard brew
  static const int cupRistretto = 0x00; // 25ml
  static const int cupEspresso  = 0x01; // 40ml
  static const int cupLungo     = 0x02; // 110ml
  static const int cupHotWater  = 0x04; // 200ml
  static const int cupAmericano = 0x05; // 25ml coffee + 125ml water
  static const int cupRecipe    = 0x07; // Custom Recipe trigger

  // Machine States (Byte 1 & 0x0F of charMachineStatus)
  static const List<String> machineStates = [
    'STANDBY',
    'READY',
    'BREWING',
    'SETTINGS',
    'ERROR',
    'OVERHEATED',
    'FIRST_SETUP',
    'PAUSED'
  ];

  // Pairing States ((Byte 0 & 0x60) >> 5 of charMachineStatus)
  static const List<String> pairingStates = [
    'NONE',
    'TEMPORARY',
    'FINAL',
    'UNDEFINED'
  ];
}
