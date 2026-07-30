import { describe, expect, test } from "bun:test";
import {
  h264SpsLevelIdc,
  h264SpsProfileLevelId,
  isCompatibleMainProfile,
} from "../../../src/features/webrtc/h264Level";

describe("H.264 SDP and SPS capability helpers", () => {
  test("reads the profile and level fields from an SPS", () => {
    const sps = Buffer.from([0x67, 0x4d, 0x00, 0x2a]);
    expect(h264SpsProfileLevelId(sps)).toBe("4d002a");
    expect(h264SpsLevelIdc(sps)).toBe(0x2a);
  });

  test("accepts the whole Main family but rejects a different profile", () => {
    expect(isCompatibleMainProfile("4d002a")).toBe(true);
    // Any profile-iop constraint-flag byte a device encoder may emit is accepted;
    // only profile_idc (first byte) is significant, matching the reconnect-safe gate.
    expect(isCompatibleMainProfile("4d401f")).toBe(true);
    expect(isCompatibleMainProfile("4de02a")).toBe(true);
    expect(isCompatibleMainProfile("4d001f")).toBe(true);
    // Baseline (0x42) is now rejected — a Baseline-only decoder cannot decode Main.
    expect(isCompatibleMainProfile("42e02a")).toBe(false);
    expect(isCompatibleMainProfile("428028")).toBe(false);
    // High (0x64) is still rejected — a genuinely different profile.
    expect(isCompatibleMainProfile("64001f")).toBe(false);
  });
});
