import { expect, test } from "bun:test";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

test("a raw swipe can dispatch coordinates after a completed display transition", async () => {
  const device: BootedDevice = {
    deviceId: "transition-gesture",
    name: "Foldable",
    platform: "android",
  };
  const adb = new FakeAdbExecutor();
  const gesture = new ExecuteGesture(device, adb, new FakeTimer());
  displayTransitions.notifyTransition(device.deviceId, "fold");
  try {
    const result = await gesture.swipe(10, 10, 90, 90);
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toContain("shell input swipe 10 10 90 90 300");
  } finally {
    displayTransitions.reset(device.deviceId);
  }
});
