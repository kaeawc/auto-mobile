import { describe, expect, test } from "bun:test";
import { isIosSimulatorUdid } from "../../../src/utils/ios-cmdline-tools/iosDeviceType";

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
