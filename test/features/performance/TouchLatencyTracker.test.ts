import { expect, describe, test, beforeEach } from "bun:test";
import { TouchLatencyTracker } from "../../../src/features/performance/TouchLatencyTracker";
import { BootedDevice, ScreenSize } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";

/**
 * Extended FakeAdbExecutor that supports dynamic responses based on call count.
 * Used for testing scenarios where command responses change over time.
 */
class DynamicFakeAdbExecutor extends FakeAdbExecutor {
  private commandHandlers: Map<
    string,
    (command: string, callCount: number) => { stdout: string; stderr: string }
  > = new Map();
  private callCounts: Map<string, number> = new Map();

  setDynamicCommandHandler(
    pattern: string,
    handler: (command: string, callCount: number) => { stdout: string; stderr: string },
  ): void {
    this.commandHandlers.set(pattern, handler);
    this.callCounts.set(pattern, 0);
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<{
    stdout: string;
    stderr: string;
    toString: () => string;
    trim: () => string;
    includes: (search: string) => boolean;
  }> {
    // Check for dynamic handlers first
    for (const [pattern, handler] of this.commandHandlers.entries()) {
      if (command.includes(pattern)) {
        const count = (this.callCounts.get(pattern) || 0) + 1;
        this.callCounts.set(pattern, count);
        const result = handler(command, count);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          toString: () => result.stdout,
          trim: () => result.stdout.trim(),
          includes: (search: string) => result.stdout.includes(search),
        };
      }
    }
    // Fall back to parent behavior
    return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
  }

  resetCallCounts(): void {
    for (const key of this.callCounts.keys()) {
      this.callCounts.set(key, 0);
    }
  }
}

describe("TouchLatencyTracker - Unit Tests", function () {
  let tracker: TouchLatencyTracker;
  let device: BootedDevice;
  let screenSize: ScreenSize;
  let perf: NoOpPerformanceTracker;
  let fakeTimer: FakeTimer;

  async function runWithFakeTimer<T>(
    promise: Promise<T>,
    timer: FakeTimer,
    stepMs: number = 10,
  ): Promise<T> {
    let settled = false;
    let result: T | undefined;
    let error: unknown;

    promise
      .then((value) => {
        settled = true;
        result = value;
      })
      .catch((caught) => {
        settled = true;
        error = caught;
      });

    let steps = 0;
    while (!settled) {
      if (timer.getPendingSleepCount() > 0) {
        timer.advanceTime(stepMs);
      }
      await Promise.resolve();
      steps += 1;
      if (steps > 2000) {
        throw new Error("FakeTimer pump exceeded max steps");
      }
    }

    if (error) {
      throw error;
    }
    return result as T;
  }

  beforeEach(function () {
    device = {
      deviceId: "test-device",
      platform: "android",
      state: "device",
    };

    screenSize = {
      width: 1080,
      height: 1920,
    };

    perf = new NoOpPerformanceTracker();
    fakeTimer = new FakeTimer();
  });

  describe("selectSafeTouchLocation", function () {
    // A tap at 2% of screen height lands in the SystemUI status bar, not the
    // audited app's window (#6167) - the default location must clear it.
    const STATUS_BAR_BAND_RATIO = 0.02;

    test("should select a location inside the app window, below the status bar", function () {
      const fakeAdb = new FakeAdbExecutor();
      const factory: AdbClientFactory = { create: () => fakeAdb };
      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      // Access private method via type assertion for testing
      const location = (tracker as any).selectSafeTouchLocation(screenSize);

      expect(location.x).toBe(Math.floor(1080 * 0.5));
      expect(location.y).toBe(Math.floor(1920 * 0.12));
      // The old status-bar band is no longer the target.
      expect(location.y).toBeGreaterThan(screenSize.height * STATUS_BAR_BAND_RATIO);
    });

    test("should handle different screen sizes", function () {
      const fakeAdb = new FakeAdbExecutor();
      const factory: AdbClientFactory = { create: () => fakeAdb };
      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const smallScreen: ScreenSize = { width: 720, height: 1280 };
      const location = (tracker as any).selectSafeTouchLocation(smallScreen);

      expect(location.x).toBe(Math.floor(720 * 0.5));
      expect(location.y).toBe(Math.floor(1280 * 0.12));
      expect(location.y).toBeGreaterThan(smallScreen.height * STATUS_BAR_BAND_RATIO);
    });

    test("should honor a caller-provided touchPoint override", function () {
      const fakeAdb = new FakeAdbExecutor();
      const factory: AdbClientFactory = { create: () => fakeAdb };
      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const location = (tracker as any).selectSafeTouchLocation(screenSize, { x: 42, y: 84 });

      expect(location).toEqual({ x: 42, y: 84 });
    });
  });

  describe("measureLatency", function () {
    test("should return successful result when frame activity is detected", async function () {
      // Set up fake ADB responses with dynamic handler
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let gfxinfoCallCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        // Return baseline stats first, then show increased jank on subsequent calls
        gfxinfoCallCount++;
        if (gfxinfoCallCount === 1) {
          // Baseline
          return {
            stdout: `
              50th percentile: 8.5ms
              90th percentile: 12.3ms
              95th percentile: 15.7ms
              99th percentile: 22.1ms
              Number Missed Vsync: 0
              Number Slow UI thread: 0
              Number Frame deadline missed: 0
            `,
            stderr: "",
          };
        } else {
          // After touch - show frame activity
          return {
            stdout: `
              50th percentile: 10.2ms
              90th percentile: 15.8ms
              95th percentile: 18.3ms
              99th percentile: 25.7ms
              Number Missed Vsync: 1
              Number Slow UI thread: 0
              Number Frame deadline missed: 0
            `,
            stderr: "",
          };
        }
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThan(0);
      expect(result.sampleCount).toBe(1);
      expect(result.touchCoordinates.x).toBeGreaterThan(0);
      expect(result.touchCoordinates.y).toBeGreaterThan(0);
    });

    test("should calculate median from multiple samples", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let callCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          callCount = 0;
          return { stdout: "", stderr: "" };
        }

        callCount++;
        // Return baseline first, then activity on second call for each sample
        if (callCount % 2 === 1) {
          return {
            stdout: `
              Number Missed Vsync: 0
              Number Slow UI thread: 0
              Number Frame deadline missed: 0
            `,
            stderr: "",
          };
        } else {
          return {
            stdout: `
              Number Missed Vsync: 1
              Number Slow UI thread: 0
              Number Frame deadline missed: 0
            `,
            stderr: "",
          };
        }
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 3, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(true);
      expect(result.sampleCount).toBe(3);
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    test("should handle timeout when no frame activity detected", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        // Always return same stats - no frame activity
        return {
          stdout: `
            Number Missed Vsync: 0
            Number Slow UI thread: 0
            Number Frame deadline missed: 0
          `,
          stderr: "",
        };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 50 }, // Short timeout for fast test
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(false);
      expect(result.sampleCount).toBe(0);
      expect(result.error).toContain("No successful measurements");
    });

    test("should detect frame activity via slowUiThread increase", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let callCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        callCount++;
        if (callCount === 1) {
          return {
            stdout: `
              Number Missed Vsync: 0
              Number Slow UI thread: 0
              Number Frame deadline missed: 0
            `,
            stderr: "",
          };
        } else {
          return {
            stdout: `
              Number Missed Vsync: 0
              Number Slow UI thread: 1
              Number Frame deadline missed: 0
            `,
            stderr: "",
          };
        }
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    test("should detect frame activity via frameDeadlineMissed increase", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let callCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        callCount++;
        if (callCount === 1) {
          return {
            stdout: `
              Number Missed Vsync: 0
              Number Slow UI thread: 0
              Number Frame deadline missed: 0
            `,
            stderr: "",
          };
        } else {
          return {
            stdout: `
              Number Missed Vsync: 0
              Number Slow UI thread: 0
              Number Frame deadline missed: 2
            `,
            stderr: "",
          };
        }
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    test("should detect frame activity via totalFrames increase with flat jank counters (#6124)", async function () {
      // A smooth app renders frames without tripping any jank counter. The
      // tracker must treat a growing `Total frames rendered` as a response.
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let callCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        callCount++;
        // Baseline on the first call, then +3 frames per poll, jank flat.
        const totalFrames = callCount === 1 ? 0 : (callCount - 1) * 3;
        return {
          stdout: `
            Total frames rendered: ${totalFrames}
            Janky frames: 0 (0.00%)
            Number Missed Vsync: 0
            Number Slow UI thread: 0
            Number Frame deadline missed: 0
          `,
          stderr: "",
        };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(true);
      expect(result.sampleCount).toBe(1);
      // Frames appear on the first poll after the touch, so the sample lands
      // well inside the wait window rather than timing out.
      expect(result.latencyMs).toBeGreaterThan(0);
      expect(result.latencyMs).toBeLessThanOrEqual(200);
    });

    test("should report frozen when totalFrames is present but never increases", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        // Frame counter present but flat, jank flat: no frame was rendered.
        // Stays below the animating-detection threshold so this exercises
        // the "no increase" timeout path, not the animating path (#6167).
        return {
          stdout: `
            Total frames rendered: 1
            Number Missed Vsync: 0
            Number Slow UI thread: 0
            Number Frame deadline missed: 0
          `,
          stderr: "",
        };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 50 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(false);
      expect(result.sampleCount).toBe(0);
      expect(result.error).toContain("No successful measurements");
      expect(result.animating).toBeFalsy();
    });

    test("should flag an app as animating when frames render during the pre-tap idle window (#6167)", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        // The app keeps rendering (spinner/video) with no input at all -
        // every read, including the pre-tap baseline, sees frame growth.
        return {
          stdout: `
            Total frames rendered: 12
            Number Missed Vsync: 0
            Number Slow UI thread: 0
            Number Frame deadline missed: 0
          `,
          stderr: "",
        };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      // No misleading pollIntervalMs-ish latency: the sample is discounted
      // and the result carries the animating disposition instead.
      expect(result.animating).toBe(true);
      expect(result.success).toBe(false);
      expect(result.sampleCount).toBe(0);
      expect(result.error).toContain("animating");
    });

    test("should not flag a static app as animating and should measure a real post-tap latency", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let pollCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          pollCount = 0;
          return { stdout: "", stderr: "" };
        }

        pollCount++;
        // Baseline (first read after reset) is idle: no frames. Only after
        // the synthetic tap does the frame counter move.
        const totalFrames = pollCount === 1 ? 0 : 5;
        return {
          stdout: `
            Total frames rendered: ${totalFrames}
            Number Missed Vsync: 0
            Number Slow UI thread: 0
            Number Frame deadline missed: 0
          `,
          stderr: "",
        };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.animating).toBeFalsy();
      expect(result.success).toBe(true);
      expect(result.sampleCount).toBe(1);
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    test("synthetic tap coordinate lands inside the app window, not the status-bar band", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }
        return {
          stdout: `
            Number Missed Vsync: 0
            Number Slow UI thread: 0
            Number Frame deadline missed: 0
          `,
          stderr: "",
        };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 50 },
          perf,
        ),
        fakeTimer,
      );

      // The old default (y = 2% of height) is the SystemUI status-bar band.
      const statusBarBandY = Math.floor(screenSize.height * 0.02);
      expect(result.touchCoordinates.y).toBeGreaterThan(statusBarBandY);
      expect(result.touchCoordinates.y).toBeLessThan(screenSize.height);
      expect(result.touchCoordinates.x).toBeGreaterThan(0);
      expect(result.touchCoordinates.x).toBeLessThan(screenSize.width);
    });

    test("should handle errors gracefully and return error result", async function () {
      const errorAdb = new FakeAdbExecutor();
      errorAdb.setDefaultError(new Error("ADB connection failed"));
      const factory: AdbClientFactory = { create: () => errorAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("ADB connection failed");
    });
  });
});
