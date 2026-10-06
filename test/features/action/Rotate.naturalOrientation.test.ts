import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Rotate } from "../../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

// Captured `dumpsys window displays` output: display 0 is mRotation=0 / mRotation=1.
const rotation0 = readFileSync(
  join(__dirname, "..", "observe", "windowDumps", "dumpsys-window-displays-mirror-portrait.txt"),
  "utf8",
);
const rotation1 = readFileSync(
  join(__dirname, "..", "observe", "windowDumps", "dumpsys-window-displays-mirror-landscape.txt"),
  "utf8",
);

const DISPLAYS = "shell dumpsys window displays";
const WM_SIZE = "shell wm size";
const NATURALLY_LANDSCAPE = "Physical size: 2208x1840";
const NATURALLY_PORTRAIT = "Physical size: 1080x2400";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString),
  };
}

function observeResult(): ObserveResult {
  return {
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
  };
}

describe("Rotate on a display whose natural orientation is not portrait (#10103)", () => {
  let adb: FakeAdbExecutor;
  let rotate: Rotate;

  const userRotationWrites = () =>
    adb
      .getExecutedCommands()
      .filter((command) => command.startsWith("shell settings put system user_rotation"));
  const wmSizeReads = () => adb.getExecutedCommands().filter((command) => command === WM_SIZE);

  beforeEach(() => {
    const device: BootedDevice = {
      name: "Test Device",
      platform: "android",
      deviceId: "natural-orientation-device",
      source: "local",
    };
    adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.enableAutoVaryHierarchy();
    observeScreen.setObserveResult(() => observeResult());
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });
    adb.setCommandResponse("shell settings get system user_rotation", execResult("0"));
    // Auto-rotate locked: the call writes (or skips) user_rotation and nothing is restored.
    adb.setCommandResponse("shell settings get system accelerometer_rotation", execResult("0"));
    rotate = new Rotate(device, adb, timer);
    rotate.awaitIdle = new FakeAwaitIdle();
    rotate.observeScreen = observeScreen;
    rotate.window = window;
  });

  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });

  test("a naturally-landscape display resting at rotation 0 is already landscape", async () => {
    adb.setCommandResponse(WM_SIZE, execResult(NATURALLY_LANDSCAPE));
    adb.setCommandResponse(DISPLAYS, execResult(rotation0));

    const result = await rotate.execute("landscape");

    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(false);
    expect(result.currentOrientation).toBe("landscape");
    expect(result.previousOrientation).toBe("landscape");
    expect(result.value).toBe(0);
    expect(userRotationWrites()).toEqual([]);
  });

  test("portrait on a naturally-landscape display resting at rotation 0 writes user_rotation 1", async () => {
    adb.setCommandResponse(WM_SIZE, execResult(NATURALLY_LANDSCAPE));
    // The pre-read sees rotation 0; every later read sees the rotation the call wrote.
    adb.setCommandResponseSequence(DISPLAYS, [execResult(rotation0), execResult(rotation1)]);

    const result = await rotate.execute("portrait");

    expect(userRotationWrites()).toContain("shell settings put system user_rotation 1");
    expect(userRotationWrites()).not.toContain("shell settings put system user_rotation 0");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.value).toBe(1);
    expect(result.previousOrientation).toBe("landscape");
    expect(result.currentOrientation).toBe("portrait");
    expect(result.message).toBe("Successfully rotated from landscape to portrait");
  });

  test("a naturally-landscape display at rotation 1 is already portrait", async () => {
    adb.setCommandResponse(WM_SIZE, execResult(NATURALLY_LANDSCAPE));
    adb.setCommandResponse(DISPLAYS, execResult(rotation1));

    const result = await rotate.execute("portrait");

    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(false);
    expect(result.currentOrientation).toBe("portrait");
    expect(result.value).toBe(1);
    expect(userRotationWrites()).toEqual([]);
  });

  test("end-of-call confirmation catches a revert using the display's natural axes", async () => {
    adb.setCommandResponse(WM_SIZE, execResult(NATURALLY_LANDSCAPE));
    // Auto-rotate is on, so the call restores it and the sensor leaves rotation 0 in place,
    // which is landscape here. The old fixed mapping read that as portrait and reported success.
    adb.setCommandResponse("shell settings get system accelerometer_rotation", execResult("1"));
    adb.setCommandResponse(DISPLAYS, execResult(rotation0));

    const result = await rotate.execute("portrait");

    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("landscape");
    expect(result.error).toContain("Requested portrait, but the device is actually in landscape");
  });

  test("a naturally-portrait display keeps the existing mapping", async () => {
    adb.setCommandResponse(WM_SIZE, execResult(NATURALLY_PORTRAIT));
    adb.setCommandResponse(DISPLAYS, execResult(rotation0));

    const noOp = await rotate.execute("portrait");
    expect(noOp.success).toBe(true);
    expect(noOp.rotationPerformed).toBe(false);
    expect(noOp.value).toBe(0);
    expect(userRotationWrites()).toEqual([]);

    adb.setCommandResponseSequence(DISPLAYS, [execResult(rotation0), execResult(rotation1)]);
    const rotated = await rotate.execute("landscape");
    expect(userRotationWrites()).toEqual(["shell settings put system user_rotation 1"]);
    expect(rotated.success).toBe(true);
    expect(rotated.value).toBe(1);
    expect(rotated.currentOrientation).toBe("landscape");
  });

  test("an unreadable display size keeps the existing mapping", async () => {
    adb.setCommandResponse(WM_SIZE, execResult(""));
    adb.setCommandResponse(DISPLAYS, execResult(rotation0));

    const result = await rotate.execute("portrait");

    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(false);
    expect(result.value).toBe(0);
  });

  test("natural axes are read once per call and never carried to the next call", async () => {
    adb.setCommandResponse(DISPLAYS, execResult(rotation0));
    adb.setCommandResponse(WM_SIZE, execResult(NATURALLY_LANDSCAPE));

    const unfolded = await rotate.execute("landscape");
    expect(unfolded.rotationPerformed).toBe(false);
    expect(wmSizeReads()).toHaveLength(1);

    // Folding swaps the active panel for a naturally-portrait one: the same
    // rotation 0 is now portrait, so landscape needs a real rotation.
    adb.setCommandResponse(WM_SIZE, execResult(NATURALLY_PORTRAIT));
    adb.setCommandResponseSequence(DISPLAYS, [execResult(rotation0), execResult(rotation1)]);
    const folded = await rotate.execute("landscape");

    expect(wmSizeReads()).toHaveLength(2);
    expect(userRotationWrites()).toEqual(["shell settings put system user_rotation 1"]);
    expect(folded.rotationPerformed).toBe(true);
    expect(folded.previousOrientation).toBe("portrait");
    expect(folded.currentOrientation).toBe("landscape");
  });
});
