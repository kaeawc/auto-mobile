import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rotate } from "../../../src/features/action/Rotate";
import { SetPosture } from "../../../src/features/device/SetPosture";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { DisplayTransitionTracker } from "../../../src/features/observe/DisplayTransition";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import { CachingDisplayInventoryProvider } from "../../../src/devices/DisplayInventoryProvider";
import { readAndroidDeviceDisplaysChecked } from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { createExecResult } from "../../../src/utils/execResult";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

// An unfold swaps a naturally-portrait cover panel for a naturally-landscape inner panel
// (#10104 sends the console command, #10105 refreshes the display inventory on the
// resulting transition, #10103 maps rotations by the panel's natural orientation). The
// rotation after it must use the inner panel's axes.
const fixture = (...segments: string[]): string =>
  readFileSync(
    join(import.meta.dir, "..", "..", "fixtures", "android-display", ...segments),
    "utf8",
  );
const windowDump = (name: string): string =>
  readFileSync(join(import.meta.dir, "..", "observe", "windowDumps", name), "utf8");
const rotation0 = windowDump("dumpsys-window-displays-mirror-portrait.txt");
const rotation1 = windowDump("dumpsys-window-displays-mirror-landscape.txt");

const DISPLAYS = "shell dumpsys window displays";
const WM_SIZE = "shell wm size";
// Same stand-in sizes as Rotate.naturalOrientation.test.ts (no `wm size` capture exists).
const COVER_PANEL = "Physical size: 1080x2400";
const INNER_PANEL = "Physical size: 2208x1840";

const device: BootedDevice = {
  name: "Foldable",
  platform: "android",
  deviceId: "emulator-5554",
  source: "local",
  displays: { panels: [], postures: ["closed", "opened"] },
};

function execResult(stdout: string): ExecResult {
  return createExecResult(stdout, "");
}

/** An emulator whose `wm size` follows the console unfold command. */
class FoldingEmulatorAdb extends FakeAdbExecutor {
  constructor() {
    super();
    this.setCommandResponse(
      "shell cmd device_state print-states",
      execResult(fixture("foldpf-print-states.txt")),
    );
    this.setCommandResponse(
      "shell cmd device_state state",
      execResult(fixture("foldpf-1-default-state.txt")),
    );
    this.setCommandResponse(WM_SIZE, execResult(COVER_PANEL));
    this.setCommandResponse(DISPLAYS, execResult(rotation0));
    this.setCommandResponse("shell settings get system user_rotation", execResult("0"));
    this.setCommandResponse("shell settings get system accelerometer_rotation", execResult("0"));
  }

  override async executeCommand(
    ...args: Parameters<FakeAdbExecutor["executeCommand"]>
  ): ReturnType<FakeAdbExecutor["executeCommand"]> {
    const response = await super.executeCommand(...args);
    // The emulator answers OK/KO on stdout; only an accepted unfold swaps the panel.
    if (args[0] === "emu unfold" && !response.stdout.startsWith("KO")) {
      this.setCommandResponse(WM_SIZE, execResult(INNER_PANEL));
    }
    return response;
  }
}

/** Counts reads of the display inventory; phone layout before the unfold, fold layout after. */
class InventorySource {
  reads = 0;
  unfolded = false;
  async read(): ReturnType<typeof readAndroidDeviceDisplaysChecked> {
    this.reads++;
    const adb = new FakeAdbExecutor();
    const names = this.unfolded
      ? ["fold-surfaceflinger.txt", "fold-open-display-device-info.txt", "fold-states.txt"]
      : ["phone-surfaceflinger.txt", "phone-display-device-info.txt", "phone-states.txt"];
    adb.setCommandResponse("dumpsys SurfaceFlinger --display-id", execResult(fixture(names[0])));
    adb.setCommandResponse("dumpsys display", execResult(fixture(names[1])));
    adb.setCommandResponse("cmd device_state print-states", execResult(fixture(names[2])));
    return readAndroidDeviceDisplaysChecked(adb);
  }
}

function observation(): ObserveResult {
  return {
    timestamp: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
    display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
    deviceLock: { locked: false, keyguardShowing: false },
  } as ObserveResult;
}

function rotateOn(adb: FakeAdbExecutor, timer: FakeTimer): Rotate {
  const observeScreen = new FakeObserveScreen();
  observeScreen.enableAutoVaryHierarchy();
  observeScreen.setObserveResult(() => observation());
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  window.configureActiveWindow({
    appId: "com.test.app",
    activityName: "MainActivity",
    layoutSeqSum: 1,
  });
  const rotate = new Rotate(device, adb, timer);
  rotate.awaitIdle = new FakeAwaitIdle();
  rotate.observeScreen = observeScreen;
  rotate.window = window;
  return rotate;
}

const userRotationWrites = (adb: FakeAdbExecutor): string[] =>
  adb.getExecutedCommands().filter((command) => command.includes("put system user_rotation"));

afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
});

describe("rotate right after an unfold (#10103 x #10104 x #10105)", () => {
  test("reads the unfolded panel's natural orientation through the real transition tracker", async () => {
    const source = new InventorySource();
    const provider = new CachingDisplayInventoryProvider(source, source, new FakeTimer());
    const tracker = new DisplayTransitionTracker(
      () => {},
      (deviceId) => provider.invalidate(deviceId),
    );
    const adb = new FoldingEmulatorAdb();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();

    // The provider reads the inventory only for a device that arrives without one.
    const bare: BootedDevice = { ...device, displays: undefined };
    const folded = await provider.hydrate(bare, "1:avd");
    expect(folded.displays).toBeUndefined();
    expect(source.reads).toBe(1);

    const posture = new SetPosture(device, {
      adbFactory: { create: () => adb },
      observeFactory: () =>
        ({
          // The observation that sees the new panel reports it to the tracker, as ObserveScreen does.
          execute: async () => {
            source.unfolded = true;
            tracker.notifyTransition(device.deviceId, "display key, role, or posture changed");
            return { ...observation(), displayRevision: tracker.revision(device.deviceId) };
          },
        }) as ObserveScreen,
      timer,
      transitionSink: tracker,
    });
    await posture.execute("opened");

    // The transition dropped the cached single-panel inventory.
    const unfolded = await provider.hydrate(bare, "1:avd");
    expect(source.reads).toBe(2);
    expect(unfolded.displays?.panels.length).toBeGreaterThan(1);

    // On the inner panel rotation 0 is already landscape: nothing to write. With the cover
    // panel's axes (what an unfold must not leave behind) it would write user_rotation 1.
    const result = await rotateOn(adb, timer).execute("landscape");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(false);
    expect(result.currentOrientation).toBe("landscape");
    expect(userRotationWrites(adb)).toEqual([]);

    const commands = adb.getExecutedCommands();
    expect(commands.lastIndexOf(WM_SIZE)).toBeGreaterThan(commands.indexOf("emu unfold"));
  });

  test("a refused unfold leaves the cover panel's axes in force for the next rotate", async () => {
    const adb = new FoldingEmulatorAdb();
    adb.setCommandResponse("emu unfold", execResult("KO: unfold not supported"));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new DisplayTransitionTracker(() => {});
    const posture = new SetPosture(device, {
      adbFactory: { create: () => adb },
      observeFactory: () => ({ execute: async () => observation() }) as ObserveScreen,
      timer,
      transitionSink: tracker,
    });

    await expect(posture.execute("opened")).rejects.toThrow(
      "The emulator console refused 'emu unfold'",
    );

    // The panel never swapped, so rotation 0 on the naturally-portrait cover is portrait
    // and landscape needs a real rotation.
    expect(tracker.revision(device.deviceId)).toBe(0);
    adb.setCommandResponseSequence(DISPLAYS, [execResult(rotation0), execResult(rotation1)]);
    const result = await rotateOn(adb, timer).execute("landscape");
    expect(result.rotationPerformed).toBe(true);
    expect(userRotationWrites(adb)).toEqual(["shell settings put system user_rotation 1"]);
  });
});
