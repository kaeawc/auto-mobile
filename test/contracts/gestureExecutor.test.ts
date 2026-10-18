import { ExecuteGesture } from "../../src/features/action/ExecuteGesture";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeGestureExecutor } from "../fakes/FakeGestureExecutor";
import { runGestureExecutorContract } from "./GestureExecutorContract";

const device: BootedDevice = { deviceId: "contract-device", platform: "android", name: "Contract" };

runGestureExecutorContract("FakeGestureExecutor", () => {
  const executor = new FakeGestureExecutor();
  return {
    executor,
    dispatchedSwipes: () => executor.getSwipeCalls().length,
    failDevice: (message) => executor.failWith(message),
  };
});

runGestureExecutorContract("ExecuteGesture (adb mode)", () => {
  const adb = new FakeAdbExecutor();
  return {
    executor: new ExecuteGesture({ ...device }, adb),
    dispatchedSwipes: () => adb.getExecutedCommands().length,
    failDevice: (message) => adb.setCommandError("input swipe", new Error(message)),
  };
});
