import { describe, expect, test } from "bun:test";
import type { ProvisionDeviceLifecycleOutcome } from "../../src/db/provisionDeviceOperationRepository";
import {
  buildProvisionDeviceRecoveryEvidence,
  type ProvisionDeviceRecoveryInput,
} from "../../src/server/provisionDeviceRecoveryEvidence";

const DEVICE = { platform: "android" as const, stableId: "avd-a", name: "avd-a" };

function build(overrides: Partial<ProvisionDeviceRecoveryInput>) {
  return buildProvisionDeviceRecoveryEvidence({
    operationId: "op-1",
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
  test("a handoff after creation names the retained target and says to retry the original operation", () => {
    const evidence = build({ lifecycle: lifecycle("created_not_ready") });
    expect(evidence).toMatchObject({
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
      action: "wait_then_retry_original_operation",
      retryAfterMs: 5_000,
    });
  });

  test("a recorded no_device_created lifecycle needs no cleanup", () => {
    const evidence = build({ lifecycle: lifecycle("no_device_created", { device: undefined }) });
    expect(evidence.outcomes.deviceCreation).toBe("not_created");
    expect(evidence.cleanup.status).toBe("unnecessary");
  });

  test("failed cleanup keeps the device retained, carries the cleanup operation id, and is unsafe to auto-retry", () => {
    const evidence = build({
      lifecycle: lifecycle("retained", {
        cleanup: { status: "failed", operationId: "cleanup-op" },
      }),
    });
    expect(evidence.cleanup).toEqual({
      status: "failed_device_retained",
      operationId: "cleanup-op",
    });
    expect(evidence.nextAction).toMatchObject({
      action: "perform_cleanup",
      automaticRetrySafe: false,
    });
  });

  test("pending cleanup waits; a destroy that reported success is not verified absence", () => {
    expect(build({ lifecycle: lifecycle("cleanup_in_progress") }).nextAction.action).toBe(
      "wait_then_retry_original_operation",
    );
    expect(build({ lifecycle: lifecycle("removed") }).cleanup.status).toBe(
      "reported_complete_unverified",
    );
  });

  test("a persistence failure reports the device outcome, an unconfirmed commit, and a released session", () => {
    const evidence = build({
      boundary: "result_persistence",
      originalError: { code: "platform_command_failed", message: "database unavailable" },
      result: { created: true, hasSession: true, device: DEVICE },
    });
    expect(evidence).toMatchObject({
      device: { ...DEVICE, ownership: "created_by_operation" },
      outcomes: {
        deviceCreation: "created",
        resultPersistence: "unconfirmed",
        session: "release_requested",
      },
      originalError: { code: "platform_command_failed" },
      nextAction: { action: "retry_original_operation", automaticRetrySafe: true },
    });
    expect(
      build({ boundary: "result_persistence", result: { created: false, hasSession: false } })
        .outcomes,
    ).toMatchObject({ deviceCreation: "adopted", session: "none" });
  });
});
