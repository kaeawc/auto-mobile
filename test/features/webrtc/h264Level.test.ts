import { describe, expect, test } from "bun:test";
import {
  h264SpsLevelIdc,
  h264SpsProfileLevelId,
  isCompatibleConstrainedBaselineProfile,
} from "../../../src/features/webrtc/h264Level";

describe("H.264 SDP and SPS capability helpers", () => {
  test("reads the profile and level fields from an SPS", () => {
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x2a]);
    expect(h264SpsProfileLevelId(sps)).toBe("42e02a");
    expect(h264SpsLevelIdc(sps)).toBe(0x2a);
  });

  test("accepts the whole Baseline family but rejects a different profile", () => {
    expect(isCompatibleConstrainedBaselineProfile("42e02a")).toBe(true);
    expect(isCompatibleConstrainedBaselineProfile("42f00b")).toBe(true);
    expect(isCompatibleConstrainedBaselineProfile("42c02a")).toBe(true);
    // Plain Baseline as Android device encoders emit it (constraint_set1 clear):
    // previously rejected, which caused an endless reconnect loop with no video.
    expect(isCompatibleConstrainedBaselineProfile("428028")).toBe(true);
    expect(isCompatibleConstrainedBaselineProfile("42001f")).toBe(true);
    // Main (0x4d) and High (0x64) are still rejected — genuinely different profiles.
    expect(isCompatibleConstrainedBaselineProfile("64001f")).toBe(false);
    expect(isCompatibleConstrainedBaselineProfile("4d401f")).toBe(false);
  });
});
