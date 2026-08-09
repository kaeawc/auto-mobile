import { describe, it, expect } from "bun:test";
import {
  classifyContinuity,
  continuityExitCode,
  redactContinuityEvidence,
  type ContinuitySnapshot,
  type DeploymentWindow,
  type ContinuityEvidence,
} from "../../src/utils/iosSimulatorContinuity";

// A deploy window used across tests. The simulator that was booted *before*
// this window began is what continuity has to preserve.
const DEPLOY: DeploymentWindow = {
  startedAt: "2026-08-07T10:00:00.000Z",
  completedAt: "2026-08-07T10:05:00.000Z",
};

// A fully-populated, healthy snapshot. Tests clone-and-tweak this so each case
// isolates the one field that drives its verdict.
function snapshot(overrides: Partial<ContinuitySnapshot> = {}): ContinuitySnapshot {
  return {
    udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    runtimeDeviceType: "iOS 17.5 / iPhone 15",
    hostIdentity: "mac-worker-07.internal",
    automobileVersion: "@kaeawc/auto-mobile@0.0.45",
    workerIncarnation: "worker-incarnation-1",
    processSupervisor: "launchd",
    processIds: { daemon: 4201, runner: 4310, coreSimulatorService: 512 },
    coreSimulatorDataRoot:
      "/Users/ci/Library/Developer/CoreSimulator/Devices/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/data",
    // Booted an hour before the deploy window opened — i.e. it survived.
    bootedSince: "2026-08-07T09:00:00.000Z",
    lifecycleState: "booted",
    responsive: true,
    reportingStatus: "reporting",
    activeWork: false,
    ...overrides,
  };
}

describe("classifyContinuity — distinguishes the required states (AC5)", () => {
  it("same UDID + same data + booted+responsive+reporting throughout → same-device-continuity", () => {
    const result = classifyContinuity(snapshot(), snapshot(), DEPLOY);
    expect(result.verdict).toBe("same-device-continuity");
    expect(result.proven).toBe(true);
    expect(result.recommendedState).toBe("available");
  });

  it("explicit planned replacement with a new, healthy device → controlled-replacement", () => {
    const before = snapshot();
    const after = snapshot({
      udid: "11111111-2222-3333-4444-555555555555",
      coreSimulatorDataRoot:
        "/Users/ci/Library/Developer/CoreSimulator/Devices/11111111-2222-3333-4444-555555555555/data",
      bootedSince: "2026-08-07T10:04:00.000Z",
    });
    const result = classifyContinuity(before, after, { ...DEPLOY, plannedReplacement: true });
    expect(result.verdict).toBe("controlled-replacement");
    expect(result.proven).toBe(true);
    expect(result.recommendedState).toBe("available");
  });

  it("same device but shut down and not recovered → shutdown", () => {
    const result = classifyContinuity(
      snapshot(),
      snapshot({ lifecycleState: "shutdown", responsive: false }),
      DEPLOY,
    );
    expect(result.verdict).toBe("shutdown");
    expect(result.proven).toBe(false);
    expect(result.recommendedState).toBe("maintenance");
  });

  it("same UDID + same data but rebooted during the window → boot-recovery", () => {
    // Booted timestamp falls inside the deploy window: the running sim did not
    // survive even though its data did.
    const after = snapshot({ bootedSince: "2026-08-07T10:02:00.000Z" });
    const result = classifyContinuity(snapshot(), after, DEPLOY);
    expect(result.verdict).toBe("boot-recovery");
    expect(result.proven).toBe(false);
    expect(result.recommendedState).toBe("maintenance");
  });

  it("a boot exactly at the window start counts as a reboot (inclusive boundary)", () => {
    const after = snapshot({ bootedSince: DEPLOY.startedAt });
    const result = classifyContinuity(snapshot(), after, DEPLOY);
    expect(result.verdict).toBe("boot-recovery");
  });

  it("an identical boot session (before === after) predating the window → same-device-continuity", () => {
    const boot = { bootedSince: "2026-08-07T09:30:00.000Z" };
    const result = classifyContinuity(snapshot(boot), snapshot(boot), DEPLOY);
    expect(result.verdict).toBe("same-device-continuity");
    expect(result.proven).toBe(true);
  });

  it("equivalent ISO spellings of the same boot instant are the same session → same-device-continuity", () => {
    const before = snapshot({ bootedSince: "2026-08-07T09:00:00Z" });
    const after = snapshot({ bootedSince: "2026-08-07T09:00:00.000Z" });
    const result = classifyContinuity(before, after, DEPLOY);
    expect(result.verdict).toBe("same-device-continuity");
    expect(result.proven).toBe(true);
  });

  it("a real leap day is accepted, not falsely rejected as an impossible date", () => {
    const boot = { bootedSince: "2028-02-29T09:00:00.000Z" };
    const window: DeploymentWindow = {
      startedAt: "2028-02-29T10:00:00.000Z",
      completedAt: "2028-02-29T10:05:00.000Z",
    };
    const result = classifyContinuity(snapshot(boot), snapshot(boot), window);
    expect(result.verdict).toBe("same-device-continuity");
    expect(result.proven).toBe(true);
  });

  it("a changed boot session across the deploy (before !== after) → boot-recovery", () => {
    // before booted 09:00, after booted 09:59 — the session changed even though
    // both predate the window; the original booted session did not survive.
    const before = snapshot({ bootedSince: "2026-08-07T09:00:00.000Z" });
    const after = snapshot({ bootedSince: "2026-08-07T09:59:00.000Z" });
    const result = classifyContinuity(before, after, DEPLOY);
    expect(result.verdict).toBe("boot-recovery");
    expect(result.proven).toBe(false);
  });

  it("device continuous but worker reporting lost → reporting-delay", () => {
    const result = classifyContinuity(snapshot(), snapshot({ reportingStatus: "lost" }), DEPLOY);
    expect(result.verdict).toBe("reporting-delay");
    expect(result.proven).toBe(false);
    expect(result.recommendedState).toBe("maintenance");
  });

  it("device continuous but worker reporting delayed → reporting-delay", () => {
    const result = classifyContinuity(snapshot(), snapshot({ reportingStatus: "delayed" }), DEPLOY);
    expect(result.verdict).toBe("reporting-delay");
    expect(result.proven).toBe(false);
  });

  it("a probe that could not determine device state → failed-probe", () => {
    const result = classifyContinuity(snapshot(), snapshot({ lifecycleState: "unknown" }), DEPLOY);
    expect(result.verdict).toBe("failed-probe");
    expect(result.proven).toBe(false);
    expect(result.recommendedState).toBe("maintenance");
  });

  it("booted but unresponsive after → failed-probe (responsiveness not proven)", () => {
    const result = classifyContinuity(snapshot(), snapshot({ responsive: false }), DEPLOY);
    expect(result.verdict).toBe("failed-probe");
    expect(result.proven).toBe(false);
  });

  it("missing required identity/context fields → incomplete-evidence", () => {
    const result = classifyContinuity(snapshot(), snapshot({ coreSimulatorDataRoot: "" }), DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
    expect(result.recommendedState).toBe("maintenance");
  });

  it("an otherwise-clean device with no bootedSince → incomplete-evidence (reboot cannot be ruled out)", () => {
    const result = classifyContinuity(snapshot(), snapshot({ bootedSince: undefined }), DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("an unhealthy pre-deploy baseline (booted but unresponsive) cannot prove continuity → incomplete-evidence", () => {
    const before = snapshot({ responsive: false });
    const result = classifyContinuity(before, snapshot(), DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("no process-identifier evidence (empty processIds) → incomplete-evidence", () => {
    const result = classifyContinuity(snapshot({ processIds: {} }), snapshot(), DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("junk or role-incomplete process ids → incomplete-evidence", () => {
    const bad = [
      { daemon: 0, runner: 4310, coreSimulatorService: 512 }, // non-positive PID
      { daemon: 1.5, runner: 4310, coreSimulatorService: 512 }, // non-integer PID
      { placeholder: 1 }, // unrelated role, none of the required ones
      { daemon: 4201, runner: 4310 }, // missing coreSimulatorService
    ];
    for (const processIds of bad) {
      const result = classifyContinuity(snapshot({ processIds }), snapshot(), DEPLOY);
      expect(result.verdict).toBe("incomplete-evidence");
      expect(result.proven).toBe(false);
    }
  });

  it("the same PID reused across the three required roles → incomplete-evidence", () => {
    const processIds = { daemon: 1, runner: 1, coreSimulatorService: 1 };
    const result = classifyContinuity(snapshot({ processIds }), snapshot({ processIds }), DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("a backwards boot instant (after earlier than before) → incomplete-evidence, not boot-recovery", () => {
    const before = snapshot({ bootedSince: "2026-08-07T09:00:00.000Z" });
    const after = snapshot({ bootedSince: "2026-08-07T08:00:00.000Z" });
    const result = classifyContinuity(before, after, DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("an unhealthy baseline outranks a changed boot instant → incomplete-evidence, not boot-recovery", () => {
    // before is shutdown (unhealthy) yet carries a boot time; after is healthy
    // with a different instant. Baseline health is checked first.
    const before = snapshot({
      lifecycleState: "shutdown",
      bootedSince: "2026-08-07T08:00:00.000Z",
    });
    const after = snapshot({ bootedSince: "2026-08-07T09:00:00.000Z" });
    const result = classifyContinuity(before, after, DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });
});

describe("classifyContinuity — cannot silently erase/orphan managed state (AC3)", () => {
  it("UDID vanished/changed without a planned replacement → orphaned-or-erased-state", () => {
    const after = snapshot({
      udid: "99999999-8888-7777-6666-555555555555",
      coreSimulatorDataRoot:
        "/Users/ci/Library/Developer/CoreSimulator/Devices/99999999-8888-7777-6666-555555555555/data",
    });
    const result = classifyContinuity(snapshot(), after, DEPLOY);
    expect(result.verdict).toBe("orphaned-or-erased-state");
    expect(result.proven).toBe(false);
    expect(result.recommendedState).toBe("maintenance");
  });

  it("CoreSimulator data root changed under the same UDID (erased/relocated) → orphaned-or-erased-state", () => {
    const after = snapshot({
      coreSimulatorDataRoot: "/private/tmp/ephemeral-extract/CoreSimulator/Devices/x/data",
    });
    const result = classifyContinuity(snapshot(), after, DEPLOY);
    expect(result.verdict).toBe("orphaned-or-erased-state");
    expect(result.proven).toBe(false);
  });

  it("before/after captured on different hosts (same UDID) is not continuity → orphaned-or-erased-state", () => {
    const after = snapshot({ hostIdentity: "mac-worker-09.internal" });
    const result = classifyContinuity(snapshot(), after, DEPLOY);
    expect(result.verdict).toBe("orphaned-or-erased-state");
    expect(result.proven).toBe(false);
  });

  it("a data-root change IS allowed when the deploy is an explicit planned replacement", () => {
    const after = snapshot({
      udid: "11111111-2222-3333-4444-555555555555",
      coreSimulatorDataRoot:
        "/Users/ci/Library/Developer/CoreSimulator/Devices/11111111-2222-3333-4444-555555555555/data",
    });
    const result = classifyContinuity(snapshot(), after, { ...DEPLOY, plannedReplacement: true });
    expect(result.verdict).toBe("controlled-replacement");
  });

  it("a planned replacement of a device that had active work is NOT certified (idle-only)", () => {
    const before = snapshot({ activeWork: true });
    const after = snapshot({
      udid: "11111111-2222-3333-4444-555555555555",
      coreSimulatorDataRoot:
        "/Users/ci/Library/Developer/CoreSimulator/Devices/11111111-2222-3333-4444-555555555555/data",
    });
    const result = classifyContinuity(before, after, { ...DEPLOY, plannedReplacement: true });
    expect(result.verdict).toBe("orphaned-or-erased-state");
    expect(result.proven).toBe(false);
    expect(result.recommendedState).toBe("maintenance");
  });

  it("a planned replacement across different hosts is NOT certified", () => {
    const after = snapshot({
      udid: "11111111-2222-3333-4444-555555555555",
      hostIdentity: "mac-worker-09.internal",
    });
    const result = classifyContinuity(snapshot(), after, { ...DEPLOY, plannedReplacement: true });
    expect(result.verdict).toBe("orphaned-or-erased-state");
    expect(result.proven).toBe(false);
  });

  it("a planned replacement whose new device is not reporting is NOT certified", () => {
    const after = snapshot({
      udid: "11111111-2222-3333-4444-555555555555",
      reportingStatus: "lost",
    });
    const result = classifyContinuity(snapshot(), after, { ...DEPLOY, plannedReplacement: true });
    expect(result.verdict).toBe("reporting-delay");
    expect(result.proven).toBe(false);
  });

  it("a planned replacement with no boot-session time is NOT certified", () => {
    const after = snapshot({
      udid: "11111111-2222-3333-4444-555555555555",
      bootedSince: undefined,
    });
    const result = classifyContinuity(snapshot(), after, { ...DEPLOY, plannedReplacement: true });
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });
});

describe("classifyContinuity — malformed evidence and windows are not proven", () => {
  it("a malformed after.bootedSince → incomplete-evidence (not silently 'no reboot')", () => {
    const result = classifyContinuity(snapshot(), snapshot({ bootedSince: "not-a-date" }), DEPLOY);
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("a malformed deploy window (missing/invalid timestamps) → incomplete-evidence", () => {
    const result = classifyContinuity(snapshot(), snapshot(), {
      startedAt: "",
      completedAt: "",
    });
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("an inverted deploy window (completed before started) → incomplete-evidence", () => {
    const result = classifyContinuity(snapshot(), snapshot(), {
      startedAt: "2026-08-07T10:05:00.000Z",
      completedAt: "2026-08-07T10:00:00.000Z",
    });
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("non-ISO timestamps that Date.parse would accept (e.g. '0') → incomplete-evidence", () => {
    const result = classifyContinuity(
      snapshot({ bootedSince: "0" }),
      snapshot({ bootedSince: "1" }),
      {
        startedAt: "1",
        completedAt: "2",
      },
    );
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("an impossible calendar date Date.parse would normalize (2026-02-30) → incomplete-evidence", () => {
    const result = classifyContinuity(snapshot(), snapshot(), {
      startedAt: "2026-02-30T10:00:00.000Z",
      completedAt: "2026-02-30T10:05:00.000Z",
    });
    expect(result.verdict).toBe("incomplete-evidence");
    expect(result.proven).toBe(false);
  });

  it("a reboot after the deploy completed (before capture) is still not proven → boot-recovery", () => {
    // Window is 10:00–10:05; the boot session began at 10:06, after completion.
    const after = snapshot({ bootedSince: "2026-08-07T10:06:00.000Z" });
    const result = classifyContinuity(snapshot(), after, DEPLOY);
    expect(result.verdict).toBe("boot-recovery");
    expect(result.proven).toBe(false);
  });
});

describe("continuityExitCode — gate exits non-zero unless continuity is proven", () => {
  it("returns 0 only for proven outcomes", () => {
    expect(continuityExitCode(classifyContinuity(snapshot(), snapshot(), DEPLOY))).toBe(0);
  });

  it("returns non-zero when continuity is not proven", () => {
    const shutdown = classifyContinuity(
      snapshot(),
      snapshot({ lifecycleState: "shutdown", responsive: false }),
      DEPLOY,
    );
    expect(continuityExitCode(shutdown)).not.toBe(0);
  });
});

describe("redactContinuityEvidence — retains a shareable, redacted result (AC7)", () => {
  const evidence: ContinuityEvidence = {
    before: snapshot(),
    after: snapshot(),
    deploy: DEPLOY,
  };

  it("removes host identity, UDIDs, PIDs, and home-dir paths from the shared artifact", () => {
    const redacted = redactContinuityEvidence(evidence);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("mac-worker-07.internal");
    expect(serialized).not.toContain("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    expect(serialized).not.toContain("/Users/ci");
    expect(serialized).not.toContain("4201");
    expect(serialized).not.toContain("4310");
  });

  it("keeps the non-sensitive fields needed to read the evidence", () => {
    const redacted = redactContinuityEvidence(evidence);
    expect(redacted.after.runtimeDeviceType).toBe("iOS 17.5 / iPhone 15");
    expect(redacted.after.automobileVersion).toBe("@kaeawc/auto-mobile@0.0.45");
    expect(redacted.after.lifecycleState).toBe("booted");
    expect(redacted.after.reportingStatus).toBe("reporting");
    expect(redacted.deploy.startedAt).toBe(DEPLOY.startedAt);
  });

  it("preserves same-device correlation within one artifact, stable under a fixed salt", () => {
    const salt = "fixed-test-salt";
    const a = redactContinuityEvidence(evidence, salt);
    const b = redactContinuityEvidence(evidence, salt);
    // Same salt + same input → identical redacted output.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Correlation preserved: identical raw UDID before/after → identical token,
    // so a reader can still tell it was the same device.
    expect(a.before.udid).toBe(a.after.udid);
  });

  it("uses a fresh random salt per call so tokens cannot be precomputed", () => {
    // Without an injected salt, two passes over identical input yield different
    // tokens — defeating offline precomputation against a known salt.
    const a = redactContinuityEvidence(evidence);
    const b = redactContinuityEvidence(evidence);
    expect(a.before.udid).not.toBe(b.before.udid);
  });

  it("maps a changed UDID to a different token (replacement stays visible)", () => {
    const replaced: ContinuityEvidence = {
      before: snapshot(),
      after: snapshot({ udid: "11111111-2222-3333-4444-555555555555" }),
      deploy: DEPLOY,
    };
    const redacted = redactContinuityEvidence(replaced);
    expect(redacted.before.udid).not.toBe(redacted.after.udid);
  });

  it("carries the classification result when one is attached", () => {
    const withResult: ContinuityEvidence = {
      ...evidence,
      result: classifyContinuity(evidence.before, evidence.after, evidence.deploy),
    };
    const redacted = redactContinuityEvidence(withResult);
    expect(redacted.result?.verdict).toBe("same-device-continuity");
    expect(redacted.result?.proven).toBe(true);
  });
});
