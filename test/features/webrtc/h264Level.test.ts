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

  test("accepts constrained-baseline profile variants but rejects a different profile", () => {
    expect(isCompatibleConstrainedBaselineProfile("42e02a")).toBe(true);
    expect(isCompatibleConstrainedBaselineProfile("42f00b")).toBe(true);
    expect(isCompatibleConstrainedBaselineProfile("42c02a")).toBe(true);
    expect(isCompatibleConstrainedBaselineProfile("64001f")).toBe(false);
  });
});
