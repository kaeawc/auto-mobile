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
    for (const serial of ["emulator-5554", "R58M12ABCDE", "192.168.1.24:5555", "", "   ", "not-a-uuid"]) {
      expect(isIosUdid(serial)).toBe(false);
    }
  });
});
