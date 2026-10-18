import { AwaitIdle } from "../../src/features/observe/AwaitIdle";
import { WINDOW_MANAGER_ROTATION_COMMAND } from "../../src/utils/android-cmdline-tools/readWindowManagerRotation";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../fakes/FakeAwaitIdle";
import { FakeTimer } from "../fakes/FakeTimer";
import { runAwaitIdleContract } from "./AwaitIdleContract";

runAwaitIdleContract("AwaitIdle over stubbed adb", () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  const awaitIdle = new AwaitIdle(
    { name: "Pixel", platform: "android", deviceId: "emulator-5554" },
    { create: () => adb },
    timer,
  );
  return {
    awaitIdle,
    setRotation: (rotation) =>
      adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, {
        stdout: `mRotation=${rotation}`,
        stderr: "",
        toString: () => "",
        trim: () => "",
        includes: () => false,
      }),
  };
});

runAwaitIdleContract("FakeAwaitIdle", () => {
  const awaitIdle = new FakeAwaitIdle();
  return { awaitIdle, setRotation: (rotation) => awaitIdle.configureRotation(rotation) };
});
