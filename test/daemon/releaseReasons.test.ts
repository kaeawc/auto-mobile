import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SESSION_RELEASE_REASON_FAMILY_TRAITS,
  SESSION_RELEASE_REASON_TRAITS,
  isExpiryReleaseReason,
  isIdleReleaseReason,
  idleReleaseField,
  releaseReasonStrength,
  releaseReasonMayReplace,
  isReissuableByNameReleaseReason,
  isRecoverableDaemonReleaseReason,
  isTerminalReleaseReason,
  literalReleaseReasonsWhere,
  outranksReleaseReason,
  releaseReasonFamiliesWhere,
  releasedRowStatus,
  sessionReleaseReasonFamily,
  sessionReleaseReasonTraits,
} from "../../src/daemon/releaseReasons";
import { DEVICE_LOSS_REASON_PREFIX } from "../../src/utils/deviceLossCancellationReason";

describe("session release-reason table (#11258)", () => {
  test("the utils-side device-loss prefix is a family in the table", () => {
    expect(Object.keys(SESSION_RELEASE_REASON_FAMILY_TRAITS)).toContain(DEVICE_LOSS_REASON_PREFIX);
  });

  test("idle releases are exactly the idle-window reasons", () => {
    expect(literalReleaseReasonsWhere("idle").sort()).toEqual(
      ["cleanup-expired", "cli-idle-timeout", "lazy-expiry", "expired"].sort(),
    );
    expect(releaseReasonFamiliesWhere("idle")).toEqual([]);
  });

  test("idle releases are terminal except a persisted expired row", () => {
    for (const reason of literalReleaseReasonsWhere("idle")) {
      expect(isTerminalReleaseReason(reason)).toBe(reason !== "expired");
    }
  });

  test("expired qualifies an idle answer while keeping its other traits", () => {
    expect(sessionReleaseReasonTraits("expired")).toEqual({
      idle: true,
      expiry: false,
      terminal: false,
      recoverable: false,
      reissuableByName: false,
    });
  });

  test("restart recovery timeout is terminal expiry without idle", () => {
    expect(sessionReleaseReasonTraits("restart-recovery-timeout")).toEqual({
      terminal: true,
      expiry: true,
      idle: false,
      recoverable: false,
      reissuableByName: false,
    });
    expect(releaseReasonStrength("restart-recovery-timeout")).toBe(2);
    expect(releasedRowStatus("restart-recovery-timeout")).toBe("expired");
    expect(idleReleaseField("restart-recovery-timeout")).toEqual({});
  });

  test("pins: expired keeps its non-terminal precedence and released-row status", () => {
    expect(releaseReasonStrength("expired")).toBe(0);
    expect(releasedRowStatus("expired")).toBe("released");
    for (const [reason, terminal] of [
      ["cleanup-expired", true],
      ["heartbeat-timeout", true],
      ["daemon-shutdown", false],
    ] as const) {
      expect(outranksReleaseReason("expired", reason)).toBe(false);
      expect(outranksReleaseReason(reason, "expired")).toBe(terminal);
      expect(releaseReasonMayReplace("expired", reason)).toBe(!terminal);
      expect(releaseReasonMayReplace(reason, "expired")).toBe(true);
    }
    // outranks accepts strings only; the row replacement predicate accepts a null held reason.
    expect(outranksReleaseReason("expired", "expired")).toBe(false);
    expect(releaseReasonMayReplace("expired", null)).toBe(true);
    expect(releaseReasonMayReplace("expired", "expired")).toBe(true);
  });

  test("idleReleaseField emits only true for idle reasons and omits the key otherwise", () => {
    for (const reason of ["cli-idle-timeout", "cleanup-expired", "lazy-expiry", "expired"]) {
      expect(idleReleaseField(reason)).toEqual({ idle: true });
    }
    for (const reason of [
      "heartbeat-timeout",
      "missing-first-heartbeat",
      "owner-disconnected",
      "daemon-shutdown",
      "device-restart:x",
      "unknown",
      "",
      undefined,
    ]) {
      expect(idleReleaseField(reason)).toEqual({});
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
        "restart-recovery-timeout",
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
        "restart-recovery-timeout",
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
      reissuableByName: false,
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

  test("the user doc's release table names every reason", () => {
    const doc = readFileSync(join(import.meta.dir, "../../docs/using/device-ownership.md"), "utf8");
    const missing = [
      ...Object.keys(SESSION_RELEASE_REASON_TRAITS),
      ...Object.keys(SESSION_RELEASE_REASON_FAMILY_TRAITS),
    ].filter((reason) => !doc.includes(`\`${reason}`));
    expect(missing).toEqual([]);
  });
});

describe("re-issuable-by-name category (#11418)", () => {
  test("is the recoverable reasons plus plan-auto-release, and nothing terminal", () => {
    const reissuable = [
      ...literalReleaseReasonsWhere("reissuableByName"),
      ...releaseReasonFamiliesWhere("reissuableByName"),
    ].sort();
    const recoverable = [
      ...literalReleaseReasonsWhere("recoverable"),
      ...releaseReasonFamiliesWhere("recoverable"),
    ];
    expect(reissuable).toEqual([...recoverable, "plan-auto-release"].sort());
    expect(isRecoverableDaemonReleaseReason("plan-auto-release")).toBe(false);
    for (const reason of ["superseded", "allocation-rollback", "explicit-release", "expired"]) {
      expect(isReissuableByNameReleaseReason(reason)).toBe(false);
    }
    expect(isReissuableByNameReleaseReason("device-restart:Pixel")).toBe(true);
    expect(isTerminalReleaseReason("plan-auto-release")).toBe(false);
  });
});
