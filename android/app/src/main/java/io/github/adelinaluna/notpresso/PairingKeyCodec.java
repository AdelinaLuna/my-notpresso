package io.github.adelinaluna.notpresso;

import java.security.SecureRandom;
import java.util.Locale;

/**
 * Exact implementation of Nespresso's proprietary BLE PairingKey transformation
 * reverse-engineered from com.nespresso.mobile.core.bean.machine.PairingKey
 * in Nespresso Android 3.28.0 (classes3.dex, codeOff=0x37bd98).
 */
public final class PairingKeyCodec {
    private static final SecureRandom RANDOM = new SecureRandom();

    private PairingKeyCodec() {}

    /**
     * Exact port of PairingKey.getBufferFromByteArray(byte[] raw16):
     * Shifts nibbles right by 4 bits across the first 8 bytes of a 16-byte UUID/MD5 buffer,
     * and forces the high nibble of byte 0 to 0x8 (0x80..0x8F).
     */
    public static byte[] getBufferFromByteArray(byte[] raw) {
        if (raw == null || raw.length < 8) {
            throw new IllegalArgumentException("Input array must be at least 8 bytes");
        }
        byte[] out = new byte[8];
        out[0] = (byte) (((raw[0] & 0xF0) >>> 4) | 0x80);
        for (int i = 1; i < 8; i++) {
            out[i] = (byte) (((raw[i - 1] & 0x0F) << 4) | ((raw[i] & 0xF0) >>> 4));
        }
        return out;
    }

    /**
     * Generates a brand-new valid 8-byte (16-hex-char) Nespresso BLE PairingKey
     * guaranteed to start with nibble '8' (0x80..0x8F).
     */
    public static String generateValidKeyHex() {
        byte[] raw16 = new byte[16];
        RANDOM.nextBytes(raw16);
        byte[] key8 = getBufferFromByteArray(raw16);
        return bytesToHex(key8);
    }

    /**
     * Accepts either:
     * - 16-char raw BLE hex key (e.g. "8215C8D89A6A51A0"), OR
     * - 32-char Nespresso SQLite DB pairingKey string (converts via getBufferFromByteArray).
     */
    public static String normalizeKeyHex(String input) {
        if (input == null) return "82C15F832A864437";
        String clean = input.replaceAll("[^A-Fa-f0-9]", "").toUpperCase(Locale.US);
        if (clean.length() == 32) {
            byte[] raw16 = hexToBytes(clean);
            return bytesToHex(getBufferFromByteArray(raw16));
        }
        if (clean.length() == 16) {
            return clean;
        }
        return "82C15F832A864437";
    }

    public static byte[] hexToBytes(String hex) {
        String clean = hex.replaceAll("[^A-Fa-f0-9]", "");
        int len = clean.length() / 2;
        byte[] out = new byte[len];
        for (int i = 0; i < len; i++) {
            out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    public static String bytesToHex(byte[] bytes) {
        if (bytes == null) return "";
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.US, "%02X", b & 0xFF));
        }
        return sb.toString();
    }
}
