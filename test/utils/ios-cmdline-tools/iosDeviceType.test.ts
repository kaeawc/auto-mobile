import { describe, expect, test } from "bun:test";
import {
  isIosPhysicalUdid,
  isIosSimulatorUdid,
  isIosUdid,
} from "../../../src/utils/ios-cmdline-tools/iosDeviceType";

/**
 * `isIosSimulatorUdid` is the routing predicate that decides simctl (simulator)
 * vs devicectl (physical) across the iOS action layer. Pin the 8-4-4-4-12
 * simulator-UUID shape and the physical-device forms it must reject.
 */
describe("isIosSimulatorUdid", () => {
  test("accepts a standard 8-4-4-4-12 simulator UUID (either case)", () => {
    expect(isIosSimulatorUdid("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(true);
    expect(isIosSimulatorUdid("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
  });

  test("rejects a physical-device UDID (8-hex + 16-hex, no dashed groups)", () => {
    // e.g. 00008110-000A4D3C1234801E
    expect(isIosSimulatorUdid("00008110-000A4D3C1234801E")).toBe(false);
  });

  test("rejects a 40-char physical-device UDID", () => {
    expect(isIosSimulatorUdid("a".repeat(40))).toBe(false);
  });

  test("rejects malformed / empty / non-hex input", () => {
    expect(isIosSimulatorUdid("")).toBe(false);
    expect(isIosSimulatorUdid("not-a-uuid")).toBe(false);
    // Wrong group lengths (7-4-4-4-12) and non-hex chars must not match.
    expect(isIosSimulatorUdid("A1B2C3D-E5F6-7890-ABCD-EF1234567890")).toBe(false);
    expect(isIosSimulatorUdid("G1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(false);
  });

  test("rejects a UUID with surrounding whitespace (anchored match)", () => {
    expect(isIosSimulatorUdid(" A1B2C3D4-E5F6-7890-ABCD-EF1234567890 ")).toBe(false);
  });
});

/**
 * The physical-device forms are what `isIosSimulatorUdid` deliberately rejects.
 * They still have to be recognised as iOS by platform-level classification
 * (issue #4165), so pin both generations and the negative boundaries.
 */
describe("isIosPhysicalUdid", () => {
  test("accepts the A12+ form (8 hex + '-' + 16 hex, either case)", () => {
    expect(isIosPhysicalUdid("00008030-001C2D3E1234567A")).toBe(true);
    expect(isIosPhysicalUdid("00008110-000a4d3c1234801e")).toBe(true);
  });

  test("accepts the legacy 40-hex form (either case)", () => {
    expect(isIosPhysicalUdid("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe(true);
    expect(isIosPhysicalUdid("A1B2C3D4E5F60718293A4B5C6D7E8F9012345678")).toBe(true);
  });

  test("rejects simulator UUIDs, Android serials and off-by-one lengths", () => {
    expect(isIosPhysicalUdid("569C0F94-5D53-40D2-AF8F-F4AA5BAA7D5E")).toBe(false);
    expect(isIosPhysicalUdid("emulator-5554")).toBe(false);
    expect(isIosPhysicalUdid("R58M12ABCDE")).toBe(false);
    expect(isIosPhysicalUdid("a".repeat(39))).toBe(false);
    expect(isIosPhysicalUdid("a".repeat(41))).toBe(false);
    expect(isIosPhysicalUdid("00008030-001C2D3E123456")).toBe(false);
    expect(isIosPhysicalUdid("00008030-001C2D3E1234567AB")).toBe(false);
    expect(isIosPhysicalUdid("00008030-001C2D3E1234567G")).toBe(false);
    expect(isIosPhysicalUdid("")).toBe(false);
    expect(isIosPhysicalUdid(" 00008030-001C2D3E1234567A ")).toBe(false);
  });
});

/**
 * The modern physical pattern matches structure (8 hex + "-" + 16 hex) rather
 * than the `00008` chip-id prefix on purpose — see the note on
 * IOS_PHYSICAL_UDID_MODERN_PATTERN. These rows are the proof that the breadth
 * cannot swallow an Android device id, which is the failure mode issue #4165
 * describes in the other direction.
 *
 * Android's CDD (3.2.2 Build Parameters) constrains `Build.SERIAL` /
 * `ro.serialno` to `^([a-zA-Z0-9]{0,20})$`: alphanumeric only, at most 20
 * characters. Both iOS physical forms fall outside that grammar — one needs a
 * hyphen and 25 characters, the other needs 40.
 */
describe("physical-UDID patterns stay disjoint from Android device ids", () => {
  const CDD_SERIAL_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const CDD_SERIAL_MAX_LENGTH = 20;

  test("no string in the CDD serial grammar is classified as an iOS UDID", () => {
    const misclassified: string[] = [];

    for (let length = 1; length <= CDD_SERIAL_MAX_LENGTH; length++) {
      for (const char of CDD_SERIAL_ALPHABET) {
        // Homogeneous run plus a mixed run, so hex-only serials (the closest
        // any compliant serial can get to a UDID) are covered at every length.
        const homogeneous = char.repeat(length);
        const mixed = Array.from({ length }, (_, i) =>
          i % 2 === 0 ? char : CDD_SERIAL_ALPHABET[(i * 7 + length) % CDD_SERIAL_ALPHABET.length],
        ).join("");

        for (const serial of [homogeneous, mixed]) {
          if (isIosUdid(serial)) {
            misclassified.push(serial);
          }
        }
      }
    }

    expect(misclassified).toEqual([]);
  });

  test.each([
    ["Pixel", "1A241FDEE0071P"],
    ["Pixel, hex-only characters", "8ADX0123456"],
    ["Samsung", "R58M12ABCDE"],
    ["Samsung, second form", "RF8N20XXXXY"],
    ["OnePlus / MTK style, 16 hex chars", "0123456789ABCDEF"],
    ["8 hex chars only", "00008030"],
    ["16 hex chars only", "001C2D3E1234567A"],
    ["20 hex chars (CDD length ceiling)", "00008030001C2D3E1234"],
    ["emulator", "emulator-5554"],
    ["adb over TCP/IP", "192.168.1.24:5555"],
    ["adb wireless-debugging mDNS id", "adb-R58M12ABCDE-vWL3xY._adb-tls-connect._tcp"],
  ])("classifies the %s device id as non-iOS", (_label, serial) => {
    expect(isIosUdid(serial)).toBe(false);
  });

  test("hyphenated hex that is not the 8-16 shape is still rejected", () => {
    expect(isIosPhysicalUdid("0000803-0001C2D3E1234567A")).toBe(false);
    expect(isIosPhysicalUdid("000080300-01C2D3E1234567A")).toBe(false);
    expect(isIosPhysicalUdid("00008030-001C2D3E1234567A-0000")).toBe(false);
  });
});

describe("isIosUdid", () => {
  test("is the union of the simulator and physical predicates", () => {
    const iosUdids = [
      "569C0F94-5D53-40D2-AF8F-F4AA5BAA7D5E",
      "00008030-001C2D3E1234567A",
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    ];
    for (const udid of iosUdids) {
      expect(isIosUdid(udid)).toBe(true);
      expect(isIosSimulatorUdid(udid) || isIosPhysicalUdid(udid)).toBe(true);
    }
  });

  test("rejects Android serials and degenerate input", () => {
    for (const serial of [
      "emulator-5554",
      "R58M12ABCDE",
      "192.168.1.24:5555",
      "",
      "   ",
      "not-a-uuid",
    ]) {
      expect(isIosUdid(serial)).toBe(false);
    }
  });
});
