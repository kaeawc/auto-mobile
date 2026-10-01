import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { executeTouchscreenInput } from "../../../src/features/action/touchscreenInput";
import { InputKey } from "../../../src/features/action/InputKey";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { ScreenshotJobTracker } from "../../../src/utils/ScreenshotJobTracker";
import { DaemonState } from "../../../src/daemon/daemonState";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeWindow } from "../../fakes/FakeWindow";

const device: BootedDevice = {
  deviceId: "android-owner-action-concurrency",
  name: "Android",
  platform: "android",
};
const png = readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64");

/** Keep one dispatched owner command live until the test releases it. */
class HoldingAdb extends FakeAdbExecutor {
  private releaseCommand?: () => void;
  private announceStart!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.announceStart = resolve;
  });
  ownerSignal?: AbortSignal;
  ownerCancelled = false;

  constructor(private readonly commandToHold: string) {
    super();
    this.setCommandResponse("screencap", { stdout: png, stderr: "" });
  }

  override async executeCommand(
    ...args: Parameters<FakeAdbExecutor["executeCommand"]>
  ): Promise<ExecResult> {
    const response = await super.executeCommand(...args);
    if (args[0] !== this.commandToHold || this.releaseCommand) {
      return response;
    }
    this.ownerSignal = args[4];
    return new Promise<ExecResult>((resolve, reject) => {
      const onAbort = () => {
        this.ownerCancelled = true;
        reject(new Error("Owner command was cancelled"));
      };
      this.ownerSignal?.addEventListener("abort", onAbort, { once: true });
      this.releaseCommand = () => {
        this.ownerSignal?.removeEventListener("abort", onAbort);
        resolve(response);
      };
      this.announceStart();
    });
  }

  release(): void {
    this.releaseCommand?.();
  }
}

function screenshot(adb: FakeAdbExecutor, timer: FakeTimer, ids: CountingIdGenerator) {
  const writer = new FakeScreenshotFileWriter();
  const capture = new TakeScreenshot(
    device,
    new FakeAdbClientFactory(adb),
    timer,
    ids,
    writer,
    undefined,
    undefined,
    undefined,
    false,
  );
  return { capture, writer };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Expected asynchronous dispatch did not occur");
}

afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
  DaemonState.getInstance().reset();
  ScreenshotJobTracker.clear();
  ScreenshotJobTracker.resetTimer();
  resetObserveCacheStore();
  resetScreenshotStateStore();
});

const ownerCommands = [
  "shell input touchscreen tap 10 20",
  "shell input touchscreen -d 2 swipe 10 20 30 40 100",
  "shell input swipe 10 20 30 40 100",
  "shell input text hello",
  "shell input keyevent KEYCODE_ENTER",
  "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
  "shell am start -n com.example/.MainActivity",
  "shell am force-stop com.example",
  "shell am broadcast -a com.example.ACTION",
  "shell pm clear com.example",
  "shell pm grant com.example android.permission.CAMERA",
  "install /fake/app.apk",
  "shell cmd notification set_enabled com.example true",
  "shell settings put system accelerometer_rotation 0",
  "shell cmd device_state state 1",
  "shell ime set com.example/.Ime",
  "push /fake/data /sdcard/data",
  "emu avd snapshot save owner",
];

test.each(ownerCommands)(
  "observer reads leave in-flight owner ADB command intact: %s",
  async (command) => {
    const timer = new FakeTimer();
    const adb = new HoldingAdb(command);
    const factory = new FakeAdbClientFactory(adb);
    let socket: FakeWebSocket | undefined;
    let hierarchyRequested = false;
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, timer);
        spyOn(socket, "send").mockImplementation((wire: string) => {
          if (wire.includes('"request_hierarchy"')) {
            hierarchyRequested = true;
          }
        });
        return socket;
      },
      timer,
    );
    try {
      expect(await client.ensureConnected()).toBe(true);
      AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
      const daemon = DaemonState.getInstance();
      const assignment = { sessionId: "owner", poolStatus: "assigned" };
      Reflect.set(daemon, "sessionManager", {});
      Reflect.set(daemon, "devicePool", {
        getDevice: () => assignment,
        assertDeviceActionable: () => {},
      });
      Reflect.set(daemon, "deviceSessionRegistry", {});
      const owner = new AbortController();
      const ownerAction =
        command === ownerCommands[0]
          ? executeTouchscreenInput(adb, "tap 10 20", undefined, owner.signal)
          : command === ownerCommands[1]
            ? executeTouchscreenInput(adb, "swipe 10 20 30 40 100", 2, owner.signal)
            : command === ownerCommands[2]
              ? new ExecuteGesture(device, adb, timer).swipe(
                  10,
                  20,
                  30,
                  40,
                  { duration: 100 },
                  undefined,
                  owner.signal,
                )
              : command === ownerCommands[4]
                ? new InputKey(device, factory, undefined, timer).press(
                    "enter",
                    undefined,
                    undefined,
                    [],
                    { signal: owner.signal },
                  )
                : adb.executeCommand(command, undefined, undefined, undefined, owner.signal);
      await adb.started;
      const ownerIndex = adb.getExecutedCommands().indexOf(command);
      const revision = displayTransitions.revision(device.deviceId);
      const screen = new RealObserveScreen(
        device,
        factory,
        {
          deviceReadOnly: true,
          window: new FakeWindow(),
          cacheStore: new FakeObserveCacheStore(timer),
          screenshotStateStore: new FakeScreenshotStateStore(timer),
          hierarchyCapture: createDeviceHierarchyCapture(device, { adbFactory: factory, timer }),
        },
        timer,
      );
      const observation = screen.execute({
        observerMode: true,
        timeoutMs: 50,
        screenshot: "none",
        skipBackStack: true,
      });
      await flushUntil(() => hierarchyRequested);
      await new Promise<void>((resolve) => setImmediate(resolve));
      timer.advanceTime(50);
      expect((await observation).freshness?.category).toBe("unavailable");
      expect(client.isConnected()).toBe(true);
      const shot = screenshot(adb, timer, new CountingIdGenerator("observer"));
      expect(
        (await shot.capture.executeObservationRead({ format: "png", displayId: 0 })).success,
      ).toBe(true);
      expect(adb.ownerSignal).toBe(owner.signal);
      expect(adb.ownerCancelled).toBe(false);
      expect(owner.signal.aborted).toBe(false);
      expect(adb.getExecutedCommands().indexOf(command)).toBe(ownerIndex);
      expect(adb.getExecutedCommands().filter((value) => value === command)).toHaveLength(1);
      expect(displayTransitions.revision(device.deviceId)).toBe(revision);
      expect(assignment).toEqual({ sessionId: "owner", poolStatus: "assigned" });
      adb.release();
      const result = await ownerAction;
      if (result && "success" in result) {
        expect(result.success).toBe(true);
      }
      expect(adb.ownerCancelled).toBe(false);
    } finally {
      adb.release();
      await client.close();
    }
  },
);

test.each(["finish", "timeout", "cancel"] as const)(
  "observer screenshot %s preserves the tracked owner screencap and its order",
  async (mode) => {
    const timer = new FakeTimer();
    ScreenshotJobTracker.setTimer(timer);
    const ids = new CountingIdGenerator("captures");
    // Read the exact command from the production capture, rather than inventing its temp path.
    const recorder = new FakeAdbExecutor();
    const commandProbe = screenshot(recorder, timer, new CountingIdGenerator("captures"));
    recorder.setCommandResponse("screencap", { stdout: png, stderr: "" });
    await commandProbe.capture.executeObservationRead({ format: "png", displayId: 0 });
    const command = recorder.getExecutedCommands().find((value) => value.includes("screencap"))!;
    const adb = new HoldingAdb(command);
    const ownerShot = screenshot(adb, timer, ids);
    const observerShot = screenshot(adb, timer, ids);
    const owner = ownerShot.capture.startTrackedCapture({ format: "png", displayId: 0 });
    await adb.started;
    const observerController = new AbortController();
    const observer = observerShot.capture.executeObservationRead(
      { format: "png", displayId: 0 },
      observerController.signal,
    );
    await flushUntil(() => timer.getPendingTimeoutCount() > 0);
    expect(adb.getExecutedCommands().filter((value) => value.includes("screencap"))).toHaveLength(
      1,
    );
    if (mode === "timeout") {
      timer.advanceTime(10_000);
    }
    if (mode === "cancel") {
      observerController.abort();
    }
    if (mode === "finish") {
      adb.release();
    }
    const result = await observer;
    expect(result.success).toBe(mode === "finish");
    if (mode === "timeout") {
      expect(result.error).toBe("Observer screenshot capture timed out after 10000ms");
    }
    expect(owner.signal.aborted).toBe(false);
    expect(adb.ownerCancelled).toBe(false);
    expect(ScreenshotJobTracker.isLatest(device.deviceId, owner.jobId)).toBe(true);
    adb.release();
    expect((await owner.promise).success).toBe(true);
    await Promise.resolve();
    expect(adb.getExecutedCommands().filter((value) => value.includes("screencap"))).toHaveLength(
      mode === "finish" ? 2 : 1,
    );
    expect(ownerShot.writer.written).toHaveLength(1);
    expect(observerShot.writer.written).toHaveLength(mode === "finish" ? 1 : 0);
    expect(observerShot.writer.written[0]).not.toBe(ownerShot.writer.written[0]);
  },
);

test("observer display-discovery deadline aborts only its probes and fences late screencap", async () => {
  const timer = new FakeTimer();
  const ownerAdb = new HoldingAdb("shell input touchscreen tap 10 20");
  const observerAdb = new HoldingAdb("shell dumpsys SurfaceFlinger --display-id");
  const ownerController = new AbortController();
  const owner = executeTouchscreenInput(ownerAdb, "tap 10 20", undefined, ownerController.signal);
  await ownerAdb.started;
  const shot = screenshot(observerAdb, timer, new CountingIdGenerator("observer"));
  const observer = shot.capture.executeObservationRead({ format: "png" });
  await observerAdb.started;
  timer.advanceTime(10_000);
  expect((await observer).error).toBe("Observer screenshot capture timed out after 10000ms");
  expect(observerAdb.ownerSignal?.aborted).toBe(true);
  expect(ownerController.signal.aborted).toBe(false);
  expect(ownerAdb.ownerCancelled).toBe(false);
  observerAdb.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(observerAdb.getExecutedCommands().some((command) => command.includes("screencap"))).toBe(
    false,
  );
  expect(shot.writer.written).toEqual([]);
  ownerAdb.release();
  await owner;
});
