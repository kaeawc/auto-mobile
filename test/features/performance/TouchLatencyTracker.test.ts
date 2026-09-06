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

    test("should derive the location from the app window bounds when given (split-screen)", function () {
      const fakeAdb = new FakeAdbExecutor();
      const factory: AdbClientFactory = { create: () => fakeAdb };
      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      // App occupies only the lower half of the screen.
      const windowBounds = { left: 0, top: 960, right: 1080, bottom: 1920 };
      const location = (tracker as any).selectSafeTouchLocation(
        screenSize,
        undefined,
        windowBounds,
      );

      expect(location).toEqual({ x: 540, y: 1440 });
    });

    test("should ignore malformed window bounds and fall back to the default", function () {
      const fakeAdb = new FakeAdbExecutor();
      const factory: AdbClientFactory = { create: () => fakeAdb };
      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const invalidBounds = { left: 100, top: 100, right: 100, bottom: 100 };
      const location = (tracker as any).selectSafeTouchLocation(
        screenSize,
        undefined,
        invalidBounds,
      );

      expect(location).toEqual({ x: Math.floor(1080 * 0.5), y: Math.floor(1920 * 0.12) });
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

        // Frame counter present but flat at zero: no frame was rendered
        // during the pre-tap idle window (not animating) and none after the
        // tap either (frozen), so this exercises the "no increase" timeout
        // path rather than the animating path (#6167).
        return {
          stdout: `
            Total frames rendered: 0
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

    test("should flag even a low-frame-rate (slow) animation, not just a fast one (#6167)", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        // A slow animation only manages a single frame in the 50ms pre-tap
        // idle window - still evidence the app is rendering with no input.
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
          { sampleCount: 1, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      expect(result.animating).toBe(true);
      expect(result.success).toBe(false);
    });

    test("flags animating via the jank-counter fallback when Total frames rendered is absent (#6167)", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }

        // Some gfxinfo variants omit "Total frames rendered" entirely, but
        // still report jank counters. A nonzero jank counter right after a
        // reset is still evidence the app rendered with no input.
        return {
          stdout: `
            Number Missed Vsync: 2
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

      expect(result.animating).toBe(true);
      expect(result.success).toBe(false);
    });

    test("does not flag animating when every fallback counter reads zero and Total frames rendered is absent", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let pollCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          pollCount = 0;
          return { stdout: "", stderr: "" };
        }
        pollCount++;
        // No "Total frames rendered" line at all in this gfxinfo variant.
        // Baseline (first read) is a true zero on every counter; only after
        // the tap does a jank counter move.
        const missedVsync = pollCount === 1 ? 0 : 1;
        return {
          stdout: `
            Number Missed Vsync: ${missedVsync}
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
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    test("should not flag a genuinely static app (0 frames in the idle window)", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let pollCount = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          pollCount = 0;
          return { stdout: "", stderr: "" };
        }
        pollCount++;
        const totalFrames = pollCount === 1 ? 0 : 5;
        return {
          stdout: `Total frames rendered: ${totalFrames}`,
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
    });

    test("preserves a valid measurement from a mixed run (one animating sample, one clean)", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();
      let sampleIndex = 0;
      let pollInSample = 0;

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          sampleIndex++;
          pollInSample = 0;
          return { stdout: "", stderr: "" };
        }

        pollInSample++;
        if (sampleIndex === 1) {
          // Sample 1: animating - frames already present at the baseline read.
          return { stdout: `Total frames rendered: 4`, stderr: "" };
        }
        // Sample 2: static baseline, then a real post-tap frame.
        const totalFrames = pollInSample === 1 ? 0 : 3;
        return { stdout: `Total frames rendered: ${totalFrames}`, stderr: "" };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 2, maxWaitMs: 200 },
          perf,
        ),
        fakeTimer,
      );

      // The animating sample must not null out the run: the clean sample's
      // latency is still reported, annotated with the animating flag.
      expect(result.success).toBe(true);
      expect(result.sampleCount).toBe(1);
      expect(result.latencyMs).toBeGreaterThan(0);
      expect(result.animating).toBe(true);
    });

    test("derives the synthetic tap from the app's actual window bounds (split-screen lower half, #6167)", async function () {
      const dynamicAdb = new DynamicFakeAdbExecutor();

      dynamicAdb.setDynamicCommandHandler("dumpsys gfxinfo", (command, _callCount) => {
        if (command.includes("reset")) {
          return { stdout: "", stderr: "" };
        }
        return { stdout: `Total frames rendered: 0`, stderr: "" };
      });

      dynamicAdb.setCommandResponse("input tap", { stdout: "", stderr: "" });
      const factory: AdbClientFactory = { create: () => dynamicAdb };

      tracker = new TouchLatencyTracker(device, factory, fakeTimer);

      // App occupies only the lower half of a 1920-tall screen in split-screen.
      const lowerHalfWindow = { left: 0, top: 960, right: 1080, bottom: 1920 };

      const result = await runWithFakeTimer(
        tracker.measureLatency(
          "com.example.app",
          screenSize,
          { sampleCount: 1, maxWaitMs: 50, windowBounds: lowerHalfWindow },
          perf,
        ),
        fakeTimer,
      );

      // Not the full-screen 12% default (y=230) - inside the lower-half window.
      expect(result.touchCoordinates.y).toBeGreaterThanOrEqual(lowerHalfWindow.top);
      expect(result.touchCoordinates.y).toBeLessThanOrEqual(lowerHalfWindow.bottom);
      expect(result.touchCoordinates.x).toBeGreaterThanOrEqual(lowerHalfWindow.left);
      expect(result.touchCoordinates.x).toBeLessThanOrEqual(lowerHalfWindow.right);
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
