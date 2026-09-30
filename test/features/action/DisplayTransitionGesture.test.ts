import { afterEach, beforeEach, expect, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const transitionDevice: BootedDevice = {
  deviceId: "transition-gesture",
  name: "Foldable",
  platform: "android",
};

beforeEach(() => displayTransitions.reset(transitionDevice.deviceId));
afterEach(() => displayTransitions.reset(transitionDevice.deviceId));

test("a raw swipe can dispatch coordinates after a completed display transition", async () => {
  const adb = new FakeAdbExecutor();
  const gesture = new ExecuteGesture(transitionDevice, adb, new FakeTimer());
  displayTransitions.notifyTransition(transitionDevice.deviceId, "fold");
  try {
    const result = await gesture.swipe(10, 10, 90, 90);
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toContain("shell input swipe 10 10 90 90 300");
  } finally {
    displayTransitions.reset(transitionDevice.deviceId);
  }
});

test("a coordinate action rejects a transition already detected before it starts", async () => {
  const action = new BaseVisualChange(
    transitionDevice,
    new FakeAdbExecutor(),
    new FakeTimer(),
    () => 0,
  );
  displayTransitions.notifyTransition(transitionDevice.deviceId, "fold found by discovery");
  let dispatched = false;
  await expect(
    action.observedInteraction(
      async () => {
        dispatched = true;
      },
      { changeExpected: false, predictionContext: { toolName: "dragAndDrop", toolArgs: {} } },
    ),
  ).rejects.toThrow("Re-observe");
  expect(dispatched).toBe(false);
});
