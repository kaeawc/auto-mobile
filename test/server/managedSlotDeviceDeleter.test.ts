import { describe, expect, test } from "bun:test";
import type { TeardownDeviceArgs, TeardownToolResponse } from "../../src/server/deviceTools";
import { WorkflowManagedSlotDeviceDeleter } from "../../src/server/managedSlotDeviceDeleter";
import { FakeTimer } from "../fakes/FakeTimer";

// #11174: abandoned-slot deletion runs the verified deleteDevice workflow as the daemon; only a
// confirmed absence counts as deleted.

function textResponse(payload: unknown, isError: boolean): TeardownToolResponse {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) }],
  } as unknown as TeardownToolResponse;
}

describe("WorkflowManagedSlotDeviceDeleter", () => {
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
    const deleter = new WorkflowManagedSlotDeviceDeleter(timer, () => async (args) => {
      calls.push(args);
      return textResponse({ state: "destroyed" }, false);
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
    const deleter = new WorkflowManagedSlotDeviceDeleter(
      timer,
      () => async () => textResponse({ success: false, error: "emulator would not stop" }, true),
    );
    expect(await deleter.deleteAndVerifyAbsence(target)).toMatchObject({
      kind: "failed",
      message: "emulator would not stop",
    });
  });

  test("before the device tools are registered, deletion fails", async () => {
    const deleter = new WorkflowManagedSlotDeviceDeleter(timer, () => undefined);
    expect((await deleter.deleteAndVerifyAbsence(target)).kind).toBe("failed");
  });
});
