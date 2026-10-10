import { describe, expect, test } from "bun:test";
import {
  SESSION_RELEASE_REASON_FAMILY_TRAITS,
  SESSION_RELEASE_REASON_TRAITS,
  isExpiryReleaseReason,
  isIdleReleaseReason,
  isRecoverableDaemonReleaseReason,
  isTerminalReleaseReason,
  literalReleaseReasonsWhere,
  outranksReleaseReason,
  releaseReasonFamiliesWhere,
  releasedRowStatus,
  sessionReleaseReasonFamily,
  sessionReleaseReasonTraits,
} from "../../src/daemon/releaseReasons";

describe("session release-reason table (#11258)", () => {
  test("idle releases are exactly the idle-window reasons", () => {
    expect(literalReleaseReasonsWhere("idle").sort()).toEqual(
      ["cleanup-expired", "cli-idle-timeout", "lazy-expiry"].sort(),
    );
    expect(releaseReasonFamiliesWhere("idle")).toEqual([]);
  });

  test("every idle release is terminal (owner decision 2026-10-09)", () => {
    for (const reason of literalReleaseReasonsWhere("idle")) {
      expect(isTerminalReleaseReason(reason)).toBe(true);
    }
  });

  test("expiry releases persist as expired; everything else as released", () => {
    expect(literalReleaseReasonsWhere("expiry").sort()).toEqual(
      [
        "cleanup-expired",
        "cli-idle-timeout",
        "heartbeat-timeout",
        "lazy-expiry",
        "missing-first-heartbeat",
        "rehydration-owner-timeout",
      ].sort(),
    );
    expect(releasedRowStatus("heartbeat-timeout")).toBe("expired");
    expect(releasedRowStatus("explicit-release")).toBe("released");
    expect(releasedRowStatus("device-disconnected:emulator-5554")).toBe("released");
  });

  test("terminal literal reasons", () => {
    expect(literalReleaseReasonsWhere("terminal").sort()).toEqual(
      [
        "cleanup-expired",
        "cli-idle-timeout",
        "device-killed",
        "explicit-release",
        "heartbeat-timeout",
        "lazy-expiry",
        "missing-first-heartbeat",
        "owner-disconnected",
        "rehydration-owner-timeout",
        "session-creation-cancelled",
      ].sort(),
    );
  });

  test("recoverable handoffs are never terminal", () => {
    expect(literalReleaseReasonsWhere("recoverable").sort()).toEqual([
      "daemon-restart",
      "daemon-shutdown",
    ]);
    expect(releaseReasonFamiliesWhere("recoverable")).toEqual(["device-restart:"]);
    for (const traits of [
      ...Object.values(SESSION_RELEASE_REASON_TRAITS),
      ...Object.values(SESSION_RELEASE_REASON_FAMILY_TRAITS),
    ]) {
      expect(traits.recoverable && traits.terminal).toBe(false);
    }
  });

  test("families match a prefix followed by an id", () => {
    expect(isTerminalReleaseReason("identity-recovery-identity-continuity-lost")).toBe(true);
    expect(isTerminalReleaseReason("device-disconnected:emulator-5554;incident=abc")).toBe(true);
    expect(isTerminalReleaseReason("device-disconnected-during-session-create:emulator-5554")).toBe(
      false,
    );
    expect(isRecoverableDaemonReleaseReason("device-restart:Pixel_8_API_35")).toBe(true);
    expect(sessionReleaseReasonFamily("device-restart:")).toBeUndefined();
    expect(sessionReleaseReasonFamily("device-disconnected-during-session-create:x")).toBe(
      "device-disconnected-during-session-create:",
    );
  });

  test("an unknown reason (an older daemon's row) is ordinary and non-terminal", () => {
    expect(sessionReleaseReasonTraits("some-future-reason")).toEqual({
      idle: false,
      expiry: false,
      terminal: false,
      recoverable: false,
    });
    expect(isIdleReleaseReason("some-future-reason")).toBe(false);
    expect(isExpiryReleaseReason("some-future-reason")).toBe(false);
  });

  test("inherited object keys are not reasons", () => {
    expect(sessionReleaseReasonTraits("toString").terminal).toBe(false);
    expect(sessionReleaseReasonTraits("constructor").expiry).toBe(false);
  });

  test("an idle reason is the weakest terminal reason", () => {
    // A terminal reason replaces a non-terminal one, idle included.
    expect(outranksReleaseReason("lazy-expiry", "plan-auto-release")).toBe(true);
    // A non-idle terminal reason replaces an idle one (#10051 keeps the heartbeat diagnostic).
    expect(outranksReleaseReason("heartbeat-timeout", "cleanup-expired")).toBe(true);
    expect(outranksReleaseReason("device-disconnected:emulator-5554", "lazy-expiry")).toBe(true);
    // Never the other way round, and terminal reasons of equal rank do not replace each other.
    expect(outranksReleaseReason("cleanup-expired", "device-disconnected:emulator-5554")).toBe(
      false,
    );
    expect(outranksReleaseReason("cleanup-expired", "lazy-expiry")).toBe(false);
    expect(outranksReleaseReason("explicit-release", "heartbeat-timeout")).toBe(false);
    expect(outranksReleaseReason("daemon-shutdown", "plan-auto-release")).toBe(false);
  });
});
