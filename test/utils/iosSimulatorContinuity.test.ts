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

  it("a boot before the window start is survival, not a reboot → same-device-continuity", () => {
    const after = snapshot({ bootedSince: "2026-08-07T09:59:59.000Z" });
    const result = classifyContinuity(snapshot(), after, DEPLOY);
    expect(result.verdict).toBe("same-device-continuity");
    expect(result.proven).toBe(true);
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
