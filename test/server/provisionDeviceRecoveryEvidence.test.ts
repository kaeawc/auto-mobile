import { describe, expect, test } from "bun:test";
import type { ProvisionDeviceLifecycleOutcome } from "../../src/devices/provisionDeviceLifecycle";
import {
  buildProvisionDeviceRecoveryEvidence,
  type ProvisionDeviceRecoveryInput,
} from "../../src/server/provisionDeviceRecoveryEvidence";

const DEVICE = { platform: "android" as const, stableId: "avd-a", name: "avd-a" };

function build(overrides: Partial<ProvisionDeviceRecoveryInput>) {
  return buildProvisionDeviceRecoveryEvidence({
    boundary: "daemon_handoff",
    nowMs: 42,
    daemonBuild: "0.0.0+test",
    ...overrides,
  });
}

function lifecycle(
  state: ProvisionDeviceLifecycleOutcome["state"],
  extra: Partial<ProvisionDeviceLifecycleOutcome> = {},
): ProvisionDeviceLifecycleOutcome {
  return { state, phase: "boot", device: DEVICE, ...extra };
}

describe("buildProvisionDeviceRecoveryEvidence", () => {
  test("a handoff after creation names the retained target and says to reacquire it", () => {
    const evidence = build({ lifecycle: lifecycle("created_not_ready") });
    expect(evidence).not.toHaveProperty("operationId");
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      phaseReached: "boot",
      device: { ...DEVICE, ownership: "unknown" },
      outcomes: { deviceCreation: "created", settlement: "not_applicable" },
      nextAction: { action: "reacquire_retained_device", automaticRetrySafe: true },
      freshness: { observedAtMs: 42, daemonBuild: "0.0.0+test", source: "snapshot" },
    });
  });

  test("missing lifecycle evidence stays unknown and forbids automatic retry", () => {
    const evidence = build({ boundary: "caller_cancellation", settled: true });
    expect(evidence.outcomes.deviceCreation).toBe("unknown");
    expect(evidence.cleanup.status).toBe("unknown");
    expect(evidence.nextAction).toMatchObject({
      action: "obtain_further_evidence",
      automaticRetrySafe: false,
    });
  });

  test("an unsettled cancellation waits with a bounded delay and never claims no_device_created", () => {
    const evidence = build({
      boundary: "caller_cancellation",
      settled: false,
      retryAfterMs: 5_000,
      lifecycle: lifecycle("provisioning"),
    });
    expect(evidence.outcomes).toMatchObject({ settlement: "settling", deviceCreation: "unknown" });
    expect(evidence.nextAction).toMatchObject({
      action: "retry",
      automaticRetrySafe: true,
      retryAfterMs: 5_000,
    });
  });

  test("a recorded no_device_created lifecycle needs no cleanup", () => {
    const evidence = build({ lifecycle: lifecycle("no_device_created", { device: undefined }) });
    expect(evidence.outcomes.deviceCreation).toBe("not_created");
    expect(evidence.cleanup.status).toBe("unnecessary");
  });

  test("failed cleanup keeps the device retained and is unsafe to auto-retry", () => {
    const evidence = build({
      lifecycle: lifecycle("retained", { cleanup: { status: "failed" } }),
    });
    expect(evidence.cleanup).toEqual({ status: "failed_device_retained" });
    expect(evidence.nextAction).toMatchObject({
      action: "perform_cleanup",
      automaticRetrySafe: false,
    });
  });

  test("pending cleanup waits before a retry; a destroy that reported success is not verified absence", () => {
    const pending = build({ lifecycle: lifecycle("cleanup_in_progress"), retryAfterMs: 5_000 });
    expect(pending.cleanup.status).toBe("pending");
    expect(pending.nextAction).toMatchObject({
      action: "retry",
      automaticRetrySafe: false,
      retryAfterMs: 5_000,
    });
    expect(build({ lifecycle: lifecycle("removed") }).cleanup.status).toBe(
      "reported_complete_unverified",
    );
  });

  // #11065: with no stored per-request record, a retry is always a fresh call,
  // so a settled terminal outcome is safe to retry automatically.
  test.each(["no_device_created", "removed"] as const)(
    "a retryable readiness failure recorded as %s says to retry",
    (state) => {
      const evidence = build({
        boundary: "readiness_failure",
        retryable: true,
        lifecycle: lifecycle(state),
      });
      expect(evidence.nextAction).toMatchObject({ action: "retry", automaticRetrySafe: true });
    },
  );

  test("a settled cancellation whose rollback removed the device says to retry", () => {
    const evidence = build({
      boundary: "caller_cancellation",
      settled: true,
      lifecycle: lifecycle("removed"),
    });
    expect(evidence.nextAction).toMatchObject({ action: "retry", automaticRetrySafe: true });
  });

  test("an unsettled cancellation waits before a retry even over a terminal lifecycle", () => {
    const evidence = build({
      boundary: "caller_cancellation",
      settled: false,
      lifecycle: lifecycle("cleanup_in_progress"),
    });
    expect(evidence.nextAction.action).toBe("retry");
    expect(evidence.outcomes.settlement).toBe("settling");
  });

  test("no recovery action refers to an operation id", () => {
    const actions = new Set(
      [
        build({ lifecycle: lifecycle("created_not_ready") }),
        build({ lifecycle: lifecycle("retained") }),
        build({ lifecycle: lifecycle("cleanup_in_progress") }),
        build({ boundary: "caller_cancellation", settled: false }),
        build({}),
      ].map((evidence) => `${evidence.nextAction.action} ${evidence.nextAction.reason}`),
    );
    for (const action of actions) {
      expect(action).not.toMatch(/operation/i);
    }
  });

  describe("iOS simulators", () => {
    const SIM = {
      platform: "ios" as const,
      stableId: "6F1E0C52-0000-4000-8000-000000000001",
      name: "iPhone 16",
      runtimeDeviceId: "6F1E0C52-0000-4000-8000-000000000001",
    };

    test("a handoff after simulator creation names the exact UDID and the observed ownership", () => {
      const evidence = build({
        ownership: "created_by_request",
        lifecycle: lifecycle("created_not_ready", { device: SIM }),
      });
      expect(evidence).toMatchObject({
        device: { ...SIM, ownership: "created_by_request" },
        outcomes: { deviceCreation: "created" },
        nextAction: { action: "reacquire_retained_device" },
      });
    });

    test("an adopted simulator that fails readiness is never reported as created", () => {
      const evidence = build({
        boundary: "readiness_failure",
        retryable: true,
        ownership: "adopted",
        originalError: { code: "device_lost", message: "simulator vanished" },
        lifecycle: lifecycle("created_not_ready", { device: SIM, phase: "readiness" }),
      });
      expect(evidence).toMatchObject({
        device: { ownership: "adopted", stableId: SIM.stableId },
        outcomes: { deviceCreation: "adopted" },
        originalError: { code: "device_lost" },
      });
    });

    test("a simulator whose cleanup failed is retained and unsafe to auto-retry", () => {
      const evidence = build({
        boundary: "cleanup_failure",
        retryable: true,
        ownership: "created_by_request",
        lifecycle: lifecycle("retained", {
          device: SIM,
          cleanup: { status: "failed" },
        }),
      });
      expect(evidence.cleanup).toEqual({ status: "failed_device_retained" });
      expect(evidence.nextAction).toMatchObject({
        action: "perform_cleanup",
        automaticRetrySafe: false,
      });
    });
  });

  test("a non-retryable readiness failure forbids automatic retry", () => {
    const evidence = build({
      boundary: "readiness_failure",
      retryable: false,
      lifecycle: lifecycle("removed"),
    });
    expect(evidence.nextAction).toMatchObject({
      action: "obtain_further_evidence",
      automaticRetrySafe: false,
    });
  });

  test("a retained outcome with no resolved identity never claims creation or authorizes cleanup", () => {
    const evidence = build({
      boundary: "cleanup_failure",
      retryable: true,
      lifecycle: lifecycle("retained", {
        device: undefined,
        cleanup: { status: "failed", reason: "target_identity_unresolved" },
      }),
    });
    expect(evidence.device).toBeUndefined();
    expect(evidence.outcomes.deviceCreation).toBe("unknown");
    expect(evidence.nextAction).toMatchObject({
      action: "obtain_further_evidence",
      automaticRetrySafe: false,
    });
  });

  test("ownership stays unknown without observation", () => {
    expect(build({ lifecycle: lifecycle("created_not_ready") }).device?.ownership).toBe("unknown");
  });
});
