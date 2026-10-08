import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Rotate } from "../../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { ROTATION_READ_FLOOR_MS } from "../../../src/features/observe/Idle";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { AwaitIdle } from "../../../src/features/observe/AwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";

// Captured API 36 dumps: mirror display 3 reports rotation 0 while display 0 reports rotation 1
// (landscape capture), and display 4 reports 0 while display 0 reports 0 (portrait capture).
const windowDumps = join(__dirname, "..", "observe", "windowDumps");
const mirrorLandscape = readFileSync(
  join(windowDumps, "dumpsys-window-displays-mirror-landscape.txt"),
  "utf8",
);
const mirrorPortrait = readFileSync(
  join(windowDumps, "dumpsys-window-displays-mirror-portrait.txt"),
  "utf8",
);

const device: BootedDevice = {
  name: "Test Device",
  platform: "android",
  deviceId: "display-device",
  source: "local",
};
const DUMPSYS = "shell dumpsys window displays";

function setup() {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  // An empty display list skips the existence check; display 3 is naturally portrait.
  adb.setCommandResponse("shell wm size -d 3", createExecResult("Physical size: 1080x1920", ""));
  return { adb, timer, rotate: new Rotate(device, adb, timer) };
}

const dumpsysCalls = (adb: FakeAdbExecutor) =>
  adb.getCommandCalls().filter((call) => call.command === DUMPSYS);

describe("Rotate non-default display read-back (#10362)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  test("reports success once the target display reads back the requested orientation", async () => {
    const { adb, rotate } = setup();
    adb.setCommandResponse(DUMPSYS, createExecResult(mirrorLandscape, ""));
    const result = await rotate.execute("portrait", undefined, true, undefined, 3);
    expect(result).toMatchObject({
      success: true,
      currentOrientation: "portrait",
      value: 0,
      message: "Rotated display 3 to portrait",
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd display get-displays",
      "shell wm size -d 3",
      "shell cmd window user-rotation -d 3 lock 0",
      DUMPSYS,
    ]);
  });

  test("waits for the display to settle before confirming", async () => {
    const { adb, rotate, timer } = setup();
    adb.setCommandResponseSequence(DUMPSYS, [
      createExecResult(mirrorLandscape, ""),
      createExecResult(mirrorLandscape.replace("    mRotation=0 ", "    mRotation=1 "), ""),
    ]);
    const result = await rotate.execute("landscape", undefined, true, undefined, 3);
    expect(result.success).toBe(true);
    expect(result.currentOrientation).toBe("landscape");
    expect(dumpsysCalls(adb)).toHaveLength(2);
    expect(timer.getSleepHistory()).toEqual([150]);
  });

  test("reports a mismatch from the target display, not display 0", async () => {
    const { adb, rotate } = setup();
    // Display 0 is landscape in this capture; display 3 stays at rotation 0 (portrait).
    adb.setCommandResponse(DUMPSYS, createExecResult(mirrorLandscape, ""));
    const result = await rotate.execute("landscape", undefined, true, undefined, 3);
    expect(result).toMatchObject({
      success: false,
      orientation: "landscape",
      value: 1,
      currentOrientation: "portrait",
      rotationPerformed: false,
    });
    expect(result.error).toBe(
      "Requested landscape on display 3, but the display is actually in portrait (rotation 0) after the rotation settled.",
    );
  });

  test("the read-back wait is bounded in reads, sleep and per-read timeout", async () => {
    const { adb, rotate, timer } = setup();
    adb.setCommandResponse(DUMPSYS, createExecResult(mirrorPortrait, ""));
    // Display 4 of the portrait capture never leaves rotation 0.
    adb.setCommandResponse("shell wm size -d 4", createExecResult("Physical size: 1080x1920", ""));
    const result = await rotate.execute("landscape", undefined, true, undefined, 4);
    expect(result.success).toBe(false);
    const reads = dumpsysCalls(adb);
    expect(reads).toHaveLength(5);
    expect(reads.every((call) => call.timeoutMs === ROTATION_READ_FLOOR_MS)).toBe(true);
    expect(timer.getSleepHistory()).toEqual([150, 150, 150, 150]);
  });

  test("slow reads stop polling once the confirmation budget has elapsed", async () => {
    const { adb, rotate, timer } = setup();
    const slow = new (class extends FakeAdbExecutor {
      override async executeCommand(command: string, timeoutMs?: number) {
        const result = await adb.executeCommand(command, timeoutMs);
        if (command === DUMPSYS) {
          timer.advanceTime(600);
        }
        return result;
      }
    })();
    adb.setCommandResponse(DUMPSYS, createExecResult(mirrorPortrait, ""));
    adb.setCommandResponse("shell wm size -d 4", createExecResult("Physical size: 1080x1920", ""));
    Object.assign(rotate, { adb: slow });
    const result = await rotate.execute("landscape", undefined, true, undefined, 4);
    expect(result.success).toBe(false);
    // 600ms per read: the second read ends past the 1000ms budget, so no third read starts.
    expect(dumpsysCalls(adb)).toHaveLength(2);
  });

  test("an unreadable display rotation is reported as unconfirmed", async () => {
    const { adb, rotate } = setup();
    const result = await rotate.execute("landscape", undefined, true, undefined, 3);
    expect(result.success).toBe(true);
    expect(result.currentOrientation).toBe("unknown");
    expect(result.warning).toContain(
      "Display 3's orientation after rotation could not be confirmed",
    );
    expect(dumpsysCalls(adb)).toHaveLength(5);
  });
});

describe("Rotate on a default display that ignores user_rotation (am-flip-6p7 O1)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  test("fails within the bounded rotation wait and restores auto-rotate", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    adb.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x1920", ""));
    // The window manager never applies the written user_rotation.
    adb.setCommandResponse(DUMPSYS, createExecResult("mRotation=0", ""));
    adb.setCommandResponse("shell settings get system user_rotation", createExecResult("0", ""));
    adb.setCommandResponse(
      "shell settings get system accelerometer_rotation",
      createExecResult("1", ""),
    );
    const rotate = new Rotate(device, adb, timer);
    const observe = new FakeObserveScreen();
    observe.enableAutoVaryHierarchy();
    observe.setObserveResult(() => ({
      timestamp: timer.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { node: {} },
    }));
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({ appId: "com.test.app", activityName: "Main", layoutSeqSum: 1 });
    Object.assign(rotate, {
      awaitIdle: new AwaitIdle(device, { create: () => adb }, timer),
      observeScreen: observe,
      window,
    });
    const start = timer.now();
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout waiting for rotation to 1 after 500ms");
    expect(result.currentOrientation).toBe("portrait");
    expect(adb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(true);
    // waitForRotation (500ms) plus the 1000ms cleanup/confirmation deadlines bound the call.
    expect(timer.now() - start).toBeLessThan(5000);
  });
});
