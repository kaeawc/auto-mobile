import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TerminateApp } from "../../../src/features/action/TerminateApp";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { logger } from "../../../src/utils/logger";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

const PACKAGE = "com.example.app";
const PROCESSES = "shell dumpsys activity processes";
const FORCE_STOP = "shell am force-stop --user 0 'com.example.app'";
// Existing TerminateApp.test.ts process fixture; no new parser shapes.
const RUNNING = "3220:com.example.app/u0a123";
const device: BootedDevice = { deviceId: "emulator-9724", name: "Pixel", platform: "android" };

/** Device state only changes when a post-stop read confirms teardown. */
class TerminatingAdb extends FakeAdbClient {
  stoppedAt: number | undefined;
  processDeathMs = 0;
  foregroundDeathMs = 0;
  processAlive = true;
  foregroundAlive = true;
  foregroundReads = 0;
  postProcessReads = 0;
  postForegroundReads = 0;
  readError: Error | undefined;
  foregroundError: Error | undefined;
  remainingProcesses = "";
  nextForeground = { packageName: "com.android.settings", userId: 0 };
  onPostProcessRead?: (signal?: AbortSignal) => void;
  readonly events: string[] = [];

  constructor(readonly timer: FakeTimer) {
    super();
    this.setCommandResult("shell pm list packages --user 0", "package:com.example.app");
    this.setCommandResultSequence(PROCESSES, [RUNNING, ""]);
    this.setForegroundApp({ packageName: PACKAGE, userId: 0 });
  }

  override async executeCommand(...args: Parameters<FakeAdbClient["executeCommand"]>) {
    const command = args[0];
    if (command === PROCESSES && this.stoppedAt !== undefined) {
      this.events.push("process read");
      this.postProcessReads++;
      this.onPostProcessRead?.(args[4]);
      this.processAlive = this.timer.now() - this.stoppedAt < this.processDeathMs;
      this.setCommandResultSequence(PROCESSES, [
        this.processAlive ? RUNNING : this.remainingProcesses,
      ]);
      if (this.readError) {
        this.setCommandError(PROCESSES, this.readError);
      }
      this.readError = undefined;
    }
    try {
      const result = await super.executeCommand(...args);
      if (command === FORCE_STOP) {
        this.events.push("force-stop");
        this.stoppedAt = this.timer.now();
      }
      return result;
    } finally {
      this.clearCommandError(PROCESSES);
    }
  }

  override async getForegroundApp(...args: Parameters<FakeAdbClient["getForegroundApp"]>) {
    this.foregroundReads++;
    if (this.stoppedAt !== undefined) {
      this.events.push("foreground read");
      this.postForegroundReads++;
      this.foregroundAlive = this.timer.now() - this.stoppedAt < this.foregroundDeathMs;
      if (!this.foregroundAlive) {
        this.setForegroundApp(this.nextForeground);
      }
      const error = this.foregroundError;
      this.foregroundError = undefined;
      if (error) {
        throw error;
      }
    }
    return super.getForegroundApp(...args);
  }
}

describe("TerminateApp Android termination verification", () => {
  let timer: FakeTimer;
  let adb: TerminatingAdb;
  let observe: FakeObserveScreen;
  let app: TerminateApp;
  let invalidator: FakeDeviceWindowCacheInvalidator;
  let observedAt: number | undefined;
  let ctrlProxySpy: ReturnType<typeof spyOn<typeof AndroidCtrlProxyClient, "getInstance">>;
  let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    // A nonzero clock pins the absolute deadline relative to the first read.
    timer.advanceTime(100);
    adb = new TerminatingAdb(timer);
    observedAt = undefined;
    invalidator = new FakeDeviceWindowCacheInvalidator(() => adb.events.push("invalidate"));
    app = new TerminateApp(device, adb as unknown as AdbClient, {
      timer,
      cacheInvalidator: invalidator,
    });
    observe = new FakeObserveScreen();
    observe.setObserveResult((): ObserveResult => {
      if (adb.stoppedAt !== undefined) {
        adb.events.push("observe");
        observedAt = timer.now();
        // Model the missing CtrlProxy reply without any real sleep.
        if (adb.processAlive || adb.foregroundAlive) {
          timer.advanceTime(5000);
        }
      }
      return {
        updatedAt: timer.now(),
        screenSize: { width: 1170, height: 2532 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: {
          hierarchy: { node: [] },
          packageName: "com.android.settings",
          updatedAt: timer.now(),
        },
      };
    });
    app.observeScreen = observe;
    app.awaitIdle = new FakeAwaitIdle();
    app.window = new FakeWindow();
    ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("CtrlProxy unavailable");
    });
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    ctrlProxySpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  const executeObserved = (signal?: AbortSignal) =>
    app.execute(PACKAGE, { userId: 0, skipUiStability: true }, signal);
  const elapsed = () => timer.now() - 100;

  test("immediate stop verifies once without sleeps before observing", async () => {
    const result = await executeObserved();
    expect(elapsed()).toBeLessThan(500);
    expect(adb.getCommandCalls().filter(({ command }) => command === PROCESSES)).toHaveLength(2);
    expect(adb.foregroundReads).toBe(2);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(result).toMatchObject({ success: true, wasRunning: true, wasForeground: true });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.filter(([message]) => String(message).includes("attempts"))).toEqual(
      [],
    );
    expect(adb.events).toEqual([
      "force-stop",
      "invalidate",
      "process read",
      "foreground read",
      "observe",
    ]);
    expect(invalidator.calls).toEqual([device]);
    expect(observe.getExecuteOptions()[0]).toMatchObject({ freshness: "fresh" });
  });

  test("80ms dying foreground is gone before observation", async () => {
    adb.foregroundDeathMs = 80;
    await executeObserved();
    expect(elapsed()).toBeLessThan(1000);
    expect(observedAt).toBe(250);
    expect(timer.getSleepHistory()).toEqual([50, 100]);
    expect(adb.postProcessReads).toBe(3);
    expect(adb.postForegroundReads).toBe(3);
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(infoSpy.mock.calls.filter(([message]) => String(message).includes("attempts"))).toEqual([
      [expect.stringContaining("3 attempts and 150ms")],
    ]);
  });

  test("1500ms process teardown preserves success and waits before observing", async () => {
    adb.processDeathMs = 1500;
    const result = await executeObserved();
    expect(observedAt).toBe(1650);
    expect(elapsed()).toBe(1550);
    expect(timer.getSleepHistory()).toEqual([50, 100, 200, 400, 800]);
    expect(adb.postProcessReads).toBe(6);
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(result).toMatchObject({ success: true, wasRunning: true, wasForeground: true });
  });

  test("never dies: seven attempts stop at the 3000ms deadline and still observe", async () => {
    adb.processDeathMs = Infinity;
    adb.foregroundDeathMs = Infinity;
    const result = await executeObserved();
    expect(observedAt).toBe(3100);
    expect(timer.getSleepHistory()).toEqual([50, 100, 200, 400, 800, 800, 650]);
    expect(adb.postProcessReads).toBe(7);
    expect(adb.postForegroundReads).toBe(7);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("still reported running/foreground"),
    );
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("7 attempts and 3000ms"));
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(result).toMatchObject({ success: true, wasRunning: true, wasForeground: true });
  });

  test.each(["process", "foreground"] as const)(
    "%s read error warns and polling continues",
    async (read) => {
      if (read === "process") {
        adb.readError = new Error("dumpsys unavailable");
      } else {
        adb.foregroundError = new Error("dumpsys unavailable");
      }
      const result = await executeObserved();
      expect(adb.postProcessReads).toBe(2);
      expect(adb.postForegroundReads).toBe(2);
      expect(timer.getSleepHistory()).toEqual([50]);
      expect(elapsed()).toBe(50);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("verification read failed: dumpsys unavailable"),
      );
      expect(result.success).toBe(true);
      expect(observe.getExecuteCallCount()).toBe(1);
    },
  );

  test("skipObservation leaves the pre-change command list and reads unchanged", async () => {
    const result = await app.execute(PACKAGE, { userId: 0, skipObservation: true });
    expect(adb.getCommandCalls().map(({ command }) => command)).toEqual([
      "shell pm list packages --user 0",
      PROCESSES,
      FORCE_STOP,
    ]);
    expect(adb.foregroundReads).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(observe.getExecuteCallCount()).toBe(0);
    expect(result).toEqual({
      success: true,
      packageName: PACKAGE,
      wasInstalled: true,
      wasRunning: true,
      wasForeground: true,
      userId: 0,
    });
  });

  test("background termination adds only the process read", async () => {
    adb.foregroundAlive = false;
    adb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    const result = await executeObserved();
    expect(adb.postProcessReads).toBe(1);
    expect(adb.postForegroundReads).toBe(0);
    expect(elapsed()).toBe(0);
    expect(result.wasForeground).toBe(false);
  });

  test("another user's matching package does not block verification", async () => {
    // Reuse the existing androidProcessState.test.ts multi-user record verbatim.
    adb.remainingProcesses = "*APP* UID u10a123 ProcessRecord{bbb 222:com.example.app/u10a123}";
    adb.nextForeground = { packageName: PACKAGE, userId: 10 };
    const result = await executeObserved();
    expect(adb.postProcessReads).toBe(1);
    expect(adb.postForegroundReads).toBe(1);
    expect(elapsed()).toBe(0);
    expect(result).toMatchObject({ success: true, userId: 0, wasForeground: true });
  });

  test("read time counts against the deadline and the final sleep is clipped", async () => {
    adb.processDeathMs = Infinity;
    adb.onPostProcessRead = () => timer.advanceTime(40);
    await executeObserved();
    expect(observedAt).toBe(3100);
    expect(timer.getSleepHistory()).toEqual([50, 100, 200, 400, 800, 800, 370]);
    expect(adb.postProcessReads).toBe(7);
  });

  test.each(["not installed", "not running"])("%s preserves the existing result", async (state) => {
    if (state === "not installed") {
      adb.setCommandResult("shell pm list packages --user 0", "");
    } else {
      adb.setCommandResultSequence(PROCESSES, [""]);
    }
    const result = await executeObserved();
    expect(result).toMatchObject({
      success: true,
      packageName: PACKAGE,
      wasInstalled: state !== "not installed",
      wasRunning: false,
      wasForeground: false,
      userId: 0,
    });
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
    expect(adb.postProcessReads).toBe(0);
    expect(invalidator.calls).toHaveLength(state === "not installed" ? 0 : 1);
  });

  test("aborting during a verification read rethrows without warning or observation", async () => {
    const controller = new AbortController();
    adb.onPostProcessRead = (signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      adb.readError = new Error("read interrupted");
    };
    await expect(executeObserved(controller.signal)).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(observe.getExecuteCallCount()).toBe(0);
  });

  test.each([new DOMException("Aborted", "AbortError"), new Error(OPERATION_CANCELLED_MESSAGE)])(
    "verification cancellation error is rethrown: %s",
    async (error) => {
      adb.readError = error;
      await expect(executeObserved()).rejects.toBe(error);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(observe.getExecuteCallCount()).toBe(0);
    },
  );

  test("abort between attempts stops polling", async () => {
    const controller = new AbortController();
    adb.processDeathMs = Infinity;
    const sleep = spyOn(timer, "sleep").mockImplementation(async (ms) => {
      timer.advanceTime(ms);
      controller.abort();
    });
    try {
      await expect(executeObserved(controller.signal)).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      expect(adb.postProcessReads).toBe(1);
      expect(observe.getExecuteCallCount()).toBe(0);
    } finally {
      sleep.mockRestore();
    }
  });

  test("process and foreground reads start concurrently", async () => {
    let release: (() => void) | undefined;
    const executeCommand = adb.executeCommand.bind(adb);
    const commandSpy = spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
      if (args[0] === PROCESSES && adb.stoppedAt !== undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return executeCommand(...args);
    });
    const getForeground = adb.getForegroundApp.bind(adb);
    const foregroundSpy = spyOn(adb, "getForegroundApp").mockImplementation(async (...args) => {
      if (adb.stoppedAt !== undefined) {
        expect(release).toBeDefined();
        release!();
      }
      return getForeground(...args);
    });
    try {
      expect((await executeObserved()).success).toBe(true);
      expect(adb.postForegroundReads).toBe(1);
      expect(elapsed()).toBe(0);
    } finally {
      commandSpy.mockRestore();
      foregroundSpy.mockRestore();
    }
  });
});
