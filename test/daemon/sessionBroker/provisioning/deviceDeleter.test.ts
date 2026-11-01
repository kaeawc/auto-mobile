import { describe, expect, test } from "bun:test";
import {
  createTeardownFailureResponse,
  type TeardownDeviceArgs,
  type TeardownToolResponse,
} from "../../../../src/server/deviceTools";
import { EmulatorTeardownEscalationError } from "../../../../src/features/deviceLifecycle/teardown/stuckEmulatorEscalation";
import { typedTeardownRefusal } from "../../../../src/server/deviceToolsLifecycle";
import { createTeardownResponse } from "../../../../src/features/deviceLifecycle/deviceLifecycleCore";
import { WorkflowBindingDeviceDeleter } from "../../../../src/daemon/sessionBroker/provisioning/deviceDeleter";
import { FakeTimer } from "../../../fakes/FakeTimer";

// #11174: abandoned-binding deletion runs the verified deleteDevice workflow as the daemon; only a
// confirmed absence counts as deleted.

const TEARDOWN_ARGS: TeardownDeviceArgs = {
  target: { platform: "android", isVirtual: true, stableId: "amslot-1" },
  mode: "destroy",
  verifyAbsence: true,
};

function destroyedResponse(): TeardownToolResponse {
  return createTeardownResponse(
    TEARDOWN_ARGS,
    "destroyed",
    { stop: "accepted", destroy: "accepted" },
    { verification: { notRunning: "confirmed", inventory: "complete_absence_confirmed" } },
  );
}

function failedResponse(message: string): TeardownToolResponse {
  return createTeardownFailureResponse(TEARDOWN_ARGS, "stop", "operation_failed", { message });
}

describe("WorkflowBindingDeviceDeleter", () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const target = {
    platform: "android" as const,
    stableId: "amslot-1",
    name: "amslot-1",
    deadlineMs: 31_000,
  };

  test("sends a verified destroy within the remaining budget and reports absence", async () => {
    const calls: TeardownDeviceArgs[] = [];
    const deleter = new WorkflowBindingDeviceDeleter(timer, () => async (args) => {
      calls.push(args);
      return destroyedResponse();
    });

    expect((await deleter.deleteAndVerifyAbsence(target)).kind).toBe("absent");
    expect(calls).toEqual([
      {
        target: {
          platform: "android",
          isVirtual: true,
          stableId: "amslot-1",
          stableName: "amslot-1",
        },
        mode: "destroy",
        verifyAbsence: true,
        timeoutMs: 30_000,
      },
    ]);
  });

  test("a failed teardown is a failure with the workflow's message, never absence", async () => {
    const deleter = new WorkflowBindingDeviceDeleter(
      timer,
      () => async () => failedResponse("emulator would not stop"),
    );
    expect(await deleter.deleteAndVerifyAbsence(target)).toMatchObject({
      kind: "failed",
      message: "emulator would not stop",
    });
  });

  test("before the device tools are registered, deletion fails", async () => {
    const deleter = new WorkflowBindingDeviceDeleter(timer, () => undefined);
    expect(await deleter.deleteAndVerifyAbsence(target)).toMatchObject({
      kind: "failed",
      notAttempted: { reason: "workflow_unavailable" },
    });
  });
  test.each([
    "device_assigned_to_binding",
    "device_owned_by_other_session",
    "device_owned_by_other_daemon",
    "inventory_incomplete",
    "booted_inventory_incomplete",
    "target_identity_conflict",
    "target_identity_unresolved",
    "target_not_destroyable",
  ])("pre-native refusal %s is not attempted", async (code) => {
    const response = createTeardownFailureResponse(TEARDOWN_ARGS, "precondition", code, {
      message: "refused",
    });
    const deleter = new WorkflowBindingDeviceDeleter(timer, () => async () => response);
    expect(await deleter.deleteAndVerifyAbsence(target)).toMatchObject({
      kind: "failed",
      notAttempted: { reason: code },
    });
  });

  test.each([
    ["stop", "device_owned_by_other_session"],
    ["destroy", "device_owned_by_other_daemon"],
    ["verification", "device_assigned_to_binding"],
    ["precondition", "operation_cancelled"],
    ["precondition", "operation_failed"],
    ["precondition", "unknown_refusal"],
  ] as const)("%s %s remains counted", async (phase, code) => {
    const response = createTeardownFailureResponse(TEARDOWN_ARGS, phase, code, {
      message: "failed",
    });
    const deleter = new WorkflowBindingDeviceDeleter(timer, () => async () => response);
    const result = await deleter.deleteAndVerifyAbsence(target);
    expect(result).toMatchObject({ kind: "failed" });
    expect(result).not.toHaveProperty("notAttempted");
  });

  test("an exhausted emulator escalation is marked so the journal quarantines instead of retrying", async () => {
    const response = typedTeardownRefusal(
      TEARDOWN_ARGS,
      new EmulatorTeardownEscalationError(
        "emulator still running",
        "still-running",
        "emulator-5554",
        { softAttempts: 3, pid: 4242 },
      ),
      undefined,
      "stop",
    );
    expect(response).toBeDefined();
    const deleter = new WorkflowBindingDeviceDeleter(timer, () => async () => response!);
    expect(await deleter.deleteAndVerifyAbsence(target)).toMatchObject({
      kind: "failed",
      message: "emulator still running",
      escalationExhausted: true,
    });
  });

  test("other stop failures are not marked exhausted", async () => {
    const deleter = new WorkflowBindingDeviceDeleter(
      timer,
      () => async () => failedResponse("emulator would not stop"),
    );
    expect(await deleter.deleteAndVerifyAbsence(target)).not.toHaveProperty("escalationExhausted");
  });
});
