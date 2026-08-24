import { describe, expect, test } from "bun:test";
import {
  evaluateH264SpsForSend,
  h264ProfileLevelId,
  h264SpsLevelIdc,
  h264SpsProfileLevelId,
  isCompatibleConstrainedBaselineProfile,
  isCompatibleMainProfile,
  isCompatibleProfileForSession,
  WEBRTC_H264_MAIN_PROFILE_LEVEL_ID,
  WEBRTC_H264_PROFILE_LEVEL_ID,
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

  test("accepts the whole Main family but rejects a different profile (#4756)", () => {
    // The Android MediaCodec source (issue #4756) emits Main; accept the family
    // regardless of the profile-iop/constraint byte the device encoder writes.
    expect(isCompatibleMainProfile("4d002a")).toBe(true);
    expect(isCompatibleMainProfile("4d401f")).toBe(true);
    // Baseline (0x42) and High (0x64) are rejected for a Main session.
    expect(isCompatibleMainProfile("42e02a")).toBe(false);
    expect(isCompatibleMainProfile("64001f")).toBe(false);
  });

  test("advertises the profile-level-id matching each session profile", () => {
    expect(h264ProfileLevelId("constrained-baseline")).toBe(WEBRTC_H264_PROFILE_LEVEL_ID);
    expect(h264ProfileLevelId("main")).toBe(WEBRTC_H264_MAIN_PROFILE_LEVEL_ID);
    // Level 4.2 (level_idc 0x2a) for both profiles.
    expect(WEBRTC_H264_PROFILE_LEVEL_ID).toBe("42e02a");
    expect(WEBRTC_H264_MAIN_PROFILE_LEVEL_ID).toBe("4d002a");
  });

  test("per-session dispatch validates each source's SPS against its own profile", () => {
    // No global reject: a Main session accepts Main, a Baseline session accepts
    // Baseline, and neither accepts the other's profile (the #4877 failure mode).
    expect(isCompatibleProfileForSession("4d002a", "main")).toBe(true);
    expect(isCompatibleProfileForSession("42e02a", "constrained-baseline")).toBe(true);
    expect(isCompatibleProfileForSession("42e02a", "main")).toBe(false);
    expect(isCompatibleProfileForSession("4d002a", "constrained-baseline")).toBe(false);
  });

  test("evaluateH264SpsForSend accepts each real source's SPS under its profile", () => {
    // Android Main SPS on a Main session; iOS/synthetic Baseline SPS on a Baseline
    // session. The default profile is Baseline, so a bare call keeps old behavior.
    expect(evaluateH264SpsForSend(Buffer.from([0x67, 0x4d, 0x00, 0x2a]), "main")).toEqual({
      compatible: true,
    });
    expect(
      evaluateH264SpsForSend(Buffer.from([0x67, 0x42, 0xc0, 0x1f]), "constrained-baseline"),
    ).toEqual({ compatible: true });
    expect(evaluateH264SpsForSend(Buffer.from([0x67, 0x42, 0xc0, 0x1f]))).toEqual({
      compatible: true,
    });
    // A Baseline SPS on a Main session is rejected, and vice versa.
    expect(evaluateH264SpsForSend(Buffer.from([0x67, 0x42, 0xc0, 0x1f]), "main").compatible).toBe(
      false,
    );
    expect(
      evaluateH264SpsForSend(Buffer.from([0x67, 0x4d, 0x00, 0x2a]), "constrained-baseline")
        .compatible,
    ).toBe(false);
  });
});
