import { describe, it, expect, beforeEach } from "bun:test";
import {
  DefaultScreenshotBackoffScheduler,
  ScreenshotCaptureResult,
  computeChecksum,
} from "../../../src/features/observe/ScreenshotBackoffScheduler";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("computeChecksum", () => {
  it("returns different checksum for different data", () => {
    const checksum1 = computeChecksum("data1");
    const checksum2 = computeChecksum("data2");
    expect(checksum1).not.toBe(checksum2);
  });

  it("returns 32-character hex string", () => {
    const checksum = computeChecksum("test");
    expect(checksum).toHaveLength(32);
    expect(checksum).toMatch(/^[0-9a-f]+$/);
  });
});

describe("DefaultScreenshotBackoffScheduler", () => {
  let fakeTimer: FakeTimer;
  let capturedScreenshots: string[];
  let emittedScreenshots: string[];
  let captureCount: number;
  let captureCallback: () => Promise<ScreenshotCaptureResult>;
  let emitCallback: (result: ScreenshotCaptureResult) => void;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    capturedScreenshots = [];
    emittedScreenshots = [];
    captureCount = 0;

    // Default capture callback returns unique screenshots
    captureCallback = async () => {
      captureCount++;
      const data = `screenshot-${captureCount}`;
      capturedScreenshots.push(data);
      return { success: true, data };
    };

    emitCallback = (result: ScreenshotCaptureResult) => {
      if (result.data) {
        emittedScreenshots.push(result.data);
      }
    };
  });

  describe("startBackoffSequence", () => {
    it("emits the full capture result so screenshot metadata is preserved", async () => {
      const emittedResults: ScreenshotCaptureResult[] = [];
      const scheduler = new DefaultScreenshotBackoffScheduler(
        async () => ({
          success: true,
          data: "jpeg-frame",
          checksum: "jpeg-checksum",
          screenshotMimeType: "image/jpeg",
          screenshotFormat: "jpeg",
          screenshotCaptureSource: "android_ctrlproxy_a11y",
          screenshotFallback: false,
        }),
        result => {
          emittedResults.push(result);
        },
        { intervals: [0], keepAliveIntervalMs: null },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);

      expect(emittedResults).toEqual([
        {
          success: true,
          data: "jpeg-frame",
          checksum: "jpeg-checksum",
          screenshotMimeType: "image/jpeg",
          screenshotFormat: "jpeg",
          screenshotCaptureSource: "android_ctrlproxy_a11y",
          screenshotFallback: false,
        },
      ]);
    });

    it("schedules captures at default intervals", () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        undefined,
        fakeTimer
      );

      scheduler.startBackoffSequence();

      // Should have 6 pending captures (0, 100, 300, 500, 800, 1300)
      expect(scheduler.getPendingCount()).toBe(6);
      expect(scheduler.isActive()).toBe(true);
    });

    it("captures immediately at t=0", async () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        undefined,
        fakeTimer
      );

      scheduler.startBackoffSequence();

      // Advance to t=0 (immediate)
      await fakeTimer.advanceTimersByTimeAsync(0);

      expect(capturedScreenshots).toEqual(["screenshot-1"]);
      expect(emittedScreenshots).toEqual(["screenshot-1"]);
    });

    it("captures at all backoff intervals", async () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        undefined,
        fakeTimer
      );

      scheduler.startBackoffSequence();

      // Advance through all intervals
      await fakeTimer.advanceTimersByTimeAsync(0);    // t=0
      await fakeTimer.advanceTimersByTimeAsync(100);  // t=100
      await fakeTimer.advanceTimersByTimeAsync(200);  // t=300
      await fakeTimer.advanceTimersByTimeAsync(200);  // t=500
      await fakeTimer.advanceTimersByTimeAsync(300);  // t=800
      await fakeTimer.advanceTimersByTimeAsync(500);  // t=1300

      expect(capturedScreenshots).toHaveLength(6);
      expect(emittedScreenshots).toHaveLength(6);
      expect(scheduler.isActive()).toBe(true);
      expect(scheduler.getPendingCount()).toBe(0);
    });

    it("uses custom intervals when provided", async () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 50, 150] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      expect(scheduler.getPendingCount()).toBe(3);

      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(50);
      await fakeTimer.advanceTimersByTimeAsync(100);

      expect(capturedScreenshots).toHaveLength(3);
    });

    it("cancels previous sequence when starting new one", async () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100, 200] },
        fakeTimer
      );

      // Start first sequence
      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0); // Capture at t=0

      // Start second sequence before first completes
      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0); // Capture at t=0 of new sequence

      // Advance past where first sequence would have captured
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      // Should have: 1 from first (t=0), 2 from second (t=0, t=100)
      // The t=100 and t=200 from first sequence should be cancelled
      expect(capturedScreenshots).toHaveLength(4); // 1 + 3
    });
  });

  describe("keepalive captures", () => {
    it("emits duplicate screenshots after burst sequence completes", async () => {
      captureCallback = async () => {
        capturedScreenshots.push("same-data");
        return { success: true, data: "same-data" };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100], keepAliveIntervalMs: 1000 },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);

      expect(capturedScreenshots).toHaveLength(2);
      expect(emittedScreenshots).toEqual(["same-data"]);
      expect(scheduler.isActive()).toBe(true);
      expect(scheduler.getPendingCount()).toBe(0);

      await fakeTimer.advanceTimersByTimeAsync(1000);
      await fakeTimer.advanceTimersByTimeAsync(1000);

      expect(capturedScreenshots).toHaveLength(4);
      expect(emittedScreenshots).toEqual(["same-data", "same-data", "same-data"]);
    });

    it("stops keepalive captures when subscribers are no longer active", async () => {
      let hasSubscribers = true;
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0], keepAliveIntervalMs: 1000 },
        fakeTimer,
        () => hasSubscribers
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);

      expect(capturedScreenshots).toHaveLength(1);
      expect(scheduler.isActive()).toBe(true);

      hasSubscribers = false;
      await fakeTimer.advanceTimersByTimeAsync(1000);

      expect(capturedScreenshots).toHaveLength(1);
      expect(scheduler.isActive()).toBe(false);
    });

    it("resets pending keepalive when a new sequence starts", async () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0], keepAliveIntervalMs: 1000 },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(500);

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(999);

      expect(capturedScreenshots).toHaveLength(2);

      await fakeTimer.advanceTimersByTimeAsync(1);

      expect(capturedScreenshots).toHaveLength(3);
    });

    it("uses dynamic keepalive interval when provided", async () => {
      let keepAliveIntervalMs = 500;
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0], keepAliveIntervalMs: 1000, getKeepAliveIntervalMs: () => keepAliveIntervalMs },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);

      expect(fakeTimer.getPendingTimeouts()).toEqual([500]);

      keepAliveIntervalMs = 250;
      await fakeTimer.advanceTimersByTimeAsync(500);

      expect(capturedScreenshots).toHaveLength(2);
      expect(fakeTimer.getPendingTimeouts()).toEqual([250]);
    });

    it("reschedules a pending keepalive when cadence changes", async () => {
      let keepAliveIntervalMs = 3000;
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0], getKeepAliveIntervalMs: () => keepAliveIntervalMs },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);

      expect(fakeTimer.getPendingTimeouts()).toEqual([3000]);

      keepAliveIntervalMs = 250;
      scheduler.rescheduleKeepAlive();

      expect(fakeTimer.getPendingTimeouts()).toEqual([250]);
      await fakeTimer.advanceTimersByTimeAsync(250);

      expect(capturedScreenshots).toHaveLength(2);
    });

    it("starts keepalive when cadence changes without a pending keepalive", async () => {
      const keepAliveIntervalMs = 250;
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0], getKeepAliveIntervalMs: () => keepAliveIntervalMs },
        fakeTimer,
        () => true
      );

      expect(fakeTimer.getPendingTimeouts()).toEqual([]);

      scheduler.rescheduleKeepAlive();

      expect(fakeTimer.getPendingTimeouts()).toEqual([250]);
      await fakeTimer.advanceTimersByTimeAsync(250);

      expect(capturedScreenshots).toHaveLength(1);
    });

    it("stops keepalive when the dynamic provider returns null despite a static interval", async () => {
      // A configured provider is authoritative: returning null means "stop",
      // and must NOT fall back to the static keepAliveIntervalMs (issue #4172).
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0], keepAliveIntervalMs: 3000, getKeepAliveIntervalMs: () => null },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);

      expect(capturedScreenshots).toHaveLength(1);
      // No keepalive scheduled, so nothing captures even well past the static cadence.
      expect(fakeTimer.getPendingTimeouts()).toEqual([]);
      await fakeTimer.advanceTimersByTimeAsync(3000);
      expect(capturedScreenshots).toHaveLength(1);
    });
  });

  describe("duplicate detection", () => {
    it("skips emitting duplicate screenshots", async () => {
      // Return same screenshot data every time
      captureCallback = async () => {
        captureCount++;
        capturedScreenshots.push("same-data");
        return { success: true, data: "same-data" };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100, 200] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      // All 3 captures happened
      expect(capturedScreenshots).toHaveLength(3);
      // But only 1 was emitted (first one)
      expect(emittedScreenshots).toHaveLength(1);
      expect(emittedScreenshots[0]).toBe("same-data");
    });

    it("emits when the capture identity changes even if image bytes are unchanged", async () => {
      // Issue #3348: navigating to a same-size screen whose pixels happen to be byte-identical
      // still starts a new capture. Discarding those frames as duplicates would leave the desktop
      // holding the new hierarchy id with NO screenshot bound to it — stuck in UnpairedHierarchy
      // until the ~3s keepalive, which can outlast the post-input refresh timeout.
      const emittedResults: ScreenshotCaptureResult[] = [];
      const captures: ScreenshotCaptureResult[] = [
        { success: true, data: "same-data", captureBinding: { captureSequence: 7, width: 1080, height: 2340 } },
        // Same bytes, same geometry, NEW capture: a different frame as far as pairing is concerned.
        { success: true, data: "same-data", captureBinding: { captureSequence: 8, width: 1080, height: 2340 } },
        // Same bytes AND same capture: a genuine duplicate, still skipped.
        { success: true, data: "same-data", captureBinding: { captureSequence: 8, width: 1080, height: 2340 } },
      ];
      let index = 0;

      const scheduler = new DefaultScreenshotBackoffScheduler(
        async () => captures[index++],
        (result: ScreenshotCaptureResult) => {
          emittedResults.push(result);
        },
        { intervals: [0, 100, 200] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      expect(emittedResults.map(r => r.captureBinding?.captureSequence)).toEqual([7, 8]);
    });

    it("emits when screenshot metadata changes even if image bytes are unchanged", async () => {
      const emittedResults: ScreenshotCaptureResult[] = [];
      const captures: ScreenshotCaptureResult[] = [
        {
          success: true,
          data: "same-data",
          screenshotMimeType: "image/jpeg",
          screenshotFormat: "jpeg",
          screenshotCaptureSource: "android_ctrlproxy_a11y",
          screenshotFallback: false,
        },
        {
          success: true,
          data: "same-data",
          screenshotMimeType: "image/png",
          screenshotFormat: "png",
          screenshotCaptureSource: "android_adb_screencap",
          screenshotFallback: true,
          screenshotFallbackReason: "websocket_unavailable",
        },
        {
          success: true,
          data: "same-data",
          screenshotMimeType: "image/png",
          screenshotFormat: "png",
          screenshotCaptureSource: "android_adb_screencap",
          screenshotFallback: true,
          screenshotFallbackReason: "websocket_unavailable",
        },
      ];
      let captureIndex = 0;
      captureCallback = async () => captures[captureIndex++]!;

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        result => {
          emittedResults.push(result);
        },
        { intervals: [0, 100, 200], keepAliveIntervalMs: null },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      expect(emittedResults).toEqual([captures[0], captures[1]]);
    });

    it("emits when rotation provenance changes even if image bytes are unchanged", async () => {
      const emittedResults: ScreenshotCaptureResult[] = [];
      const captures: ScreenshotCaptureResult[] = [
        {
          success: true,
          data: "same-data",
          captureBinding: { captureSequence: 7, width: 1080, height: 2340 },
          rotation: null,
        },
        {
          success: true,
          data: "same-data",
          captureBinding: { captureSequence: 7, width: 1080, height: 2340 },
          rotation: 1,
        },
      ];
      let captureIndex = 0;
      const scheduler = new DefaultScreenshotBackoffScheduler(
        async () => captures[captureIndex++]!,
        result => {
          emittedResults.push(result);
        },
        { intervals: [0, 100], keepAliveIntervalMs: null },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);

      expect(emittedResults).toEqual(captures);
    });

    it("emits when screenshot changes", async () => {
      let screenshotIndex = 0;
      const screenshots = ["frame1", "frame1", "frame2", "frame2", "frame3"];

      captureCallback = async () => {
        const data = screenshots[screenshotIndex++] || "default";
        capturedScreenshots.push(data);
        return { success: true, data };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100, 200, 300, 400] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      // 5 captures
      expect(capturedScreenshots).toHaveLength(5);
      // 3 emits (frame1, frame2, frame3 - duplicates skipped)
      expect(emittedScreenshots).toEqual(["frame1", "frame2", "frame3"]);
    });

    it("uses provided checksum if available", async () => {
      let callCount = 0;
      captureCallback = async () => {
        callCount++;
        // Return different data but same checksum for calls 1 and 2
        return {
          success: true,
          data: `data-${callCount}`,
          checksum: callCount <= 2 ? "same-checksum" : `checksum-${callCount}`,
        };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100, 200] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      // Only 2 emits: data-1 (checksum same-checksum) and data-3 (checksum-3)
      // data-2 skipped because checksum matches data-1
      expect(emittedScreenshots).toEqual(["data-1", "data-3"]);
    });
  });

  describe("cancelPendingCaptures", () => {
    it("cancels all pending captures", async () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100, 200, 300] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0); // t=0 fires

      expect(scheduler.getPendingCount()).toBe(3); // 100, 200, 300 remaining

      scheduler.cancelPendingCaptures();

      expect(scheduler.getPendingCount()).toBe(0);
      expect(scheduler.isActive()).toBe(false);

      // Advance time - no more captures should happen
      await fakeTimer.advanceTimersByTimeAsync(500);

      expect(capturedScreenshots).toHaveLength(1); // Only the t=0 capture
    });

    it("handles cancel when no sequence is active", () => {
      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        undefined,
        fakeTimer
      );

      // Should not throw
      scheduler.cancelPendingCaptures();
      expect(scheduler.isActive()).toBe(false);
    });
  });

  describe("error handling", () => {
    it("handles capture failures gracefully", async () => {
      let callCount = 0;
      captureCallback = async () => {
        callCount++;
        if (callCount === 2) {
          return { success: false, error: "Capture failed" };
        }
        return { success: true, data: `screenshot-${callCount}` };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100, 200] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      // Should emit 2 screenshots (1st and 3rd), 2nd failed
      expect(emittedScreenshots).toEqual(["screenshot-1", "screenshot-3"]);
    });

    it("handles capture exceptions gracefully", async () => {
      let callCount = 0;
      captureCallback = async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Capture exception");
        }
        return { success: true, data: `screenshot-${callCount}` };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0, 100, 200] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      await fakeTimer.advanceTimersByTimeAsync(100);
      await fakeTimer.advanceTimersByTimeAsync(100);

      // Should still emit other screenshots
      expect(emittedScreenshots).toEqual(["screenshot-1", "screenshot-3"]);
    });
  });

  describe("sequence invalidation", () => {
    it("does not emit a frame whose sequence was superseded mid-capture", async () => {
      // Gate the first capture so a second sequence can start while it is still
      // in flight. When the first capture finally resolves, its frame must be
      // discarded (the sequence id moved on) -- only sequence 2's frame emits.
      let releaseFirstCapture: () => void = () => {};
      const firstCaptureGate = new Promise<void>(resolve => {
        releaseFirstCapture = resolve;
      });

      captureCallback = async () => {
        captureCount++;
        const thisCapture = captureCount;
        if (thisCapture === 1) {
          await firstCaptureGate;
        }
        return { success: true, data: `screenshot-${thisCapture}` };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0] },
        fakeTimer
      );

      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0); // Capture 1 starts, blocks on gate.

      scheduler.startBackoffSequence(); // Supersede: sequence id bumps.
      await fakeTimer.advanceTimersByTimeAsync(0); // Capture 2 runs and emits.

      // Let the stale capture 1 resolve now that its sequence is superseded.
      releaseFirstCapture();
      await Promise.resolve();
      await Promise.resolve();

      expect(emittedScreenshots).toEqual(["screenshot-2"]);
    });
  });

  describe("resetLastChecksum", () => {
    it("allows re-emitting same screenshot after reset", async () => {
      captureCallback = async () => {
        return { success: true, data: "same-data" };
      };

      const scheduler = new DefaultScreenshotBackoffScheduler(
        captureCallback,
        emitCallback,
        { intervals: [0] },
        fakeTimer
      );

      // First sequence
      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      expect(emittedScreenshots).toHaveLength(1);

      // Second sequence - same data, should be skipped
      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      expect(emittedScreenshots).toHaveLength(1);

      // Reset checksum
      scheduler.resetLastChecksum();

      // Third sequence - same data but checksum reset, should emit
      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(0);
      expect(emittedScreenshots).toHaveLength(2);
    });
  });
});

describe("DefaultScreenshotBackoffScheduler minCaptureIntervalMs throttle", () => {
  // The Android accessibility takeScreenshot() API rate-limits calls below a platform floor.
  // With minCaptureIntervalMs set, the scheduler must never issue two captures closer than the
  // floor — no matter how dense the burst intervals are or how often the sequence restarts.
  const FLOOR = 350;

  function makeThrottledScheduler(fakeTimer: FakeTimer, captureTimes: number[]) {
    return new DefaultScreenshotBackoffScheduler(
      async () => {
        captureTimes.push(fakeTimer.now());
        return { success: true, data: `frame-${captureTimes.length}` };
      },
      () => {},
      {
        intervals: [0, 100, 300, 500, 800, 1300],
        keepAliveIntervalMs: null,
        minCaptureIntervalMs: FLOOR,
      },
      fakeTimer
    );
  }

  function assertNeverBelowFloor(captureTimes: number[]) {
    for (let i = 1; i < captureTimes.length; i++) {
      expect(captureTimes[i] - captureTimes[i - 1]).toBeGreaterThanOrEqual(FLOOR);
    }
  }

  it("never captures two frames closer than the floor across a single front-loaded burst", async () => {
    const fakeTimer = new FakeTimer();
    const captureTimes: number[] = [];
    const scheduler = makeThrottledScheduler(fakeTimer, captureTimes);

    scheduler.startBackoffSequence();
    for (let t = 0; t < 2000; t += 50) {
      await fakeTimer.advanceTimersByTimeAsync(50);
    }

    expect(captureTimes.length).toBeGreaterThanOrEqual(2);
    expect(captureTimes[0]).toBe(0); // leading edge fires immediately
    assertNeverBelowFloor(captureTimes);
  });

  it("holds the floor through a restart storm and still captures the settled frame", async () => {
    const fakeTimer = new FakeTimer();
    const captureTimes: number[] = [];
    const scheduler = makeThrottledScheduler(fakeTimer, captureTimes);

    // Simulate an animation: a new hierarchy every 50ms restarts the sequence for ~1s.
    for (let t = 0; t < 1000; t += 50) {
      scheduler.startBackoffSequence();
      await fakeTimer.advanceTimersByTimeAsync(50);
    }
    // Let the trailing (settle) capture land after the storm ends.
    for (let t = 0; t < 800; t += 50) {
      await fakeTimer.advanceTimersByTimeAsync(50);
    }

    expect(captureTimes.length).toBeGreaterThanOrEqual(2); // liveness during the storm
    assertNeverBelowFloor(captureTimes);
    // A capture must land at/after the last restart so the settled UI is not dropped.
    expect(Math.max(...captureTimes)).toBeGreaterThanOrEqual(950);
  });

  it("does not throttle when the floor is unset (default behavior preserved)", async () => {
    const fakeTimer = new FakeTimer();
    const captureTimes: number[] = [];
    const scheduler = new DefaultScreenshotBackoffScheduler(
      async () => {
        captureTimes.push(fakeTimer.now());
        return { success: true, data: `frame-${captureTimes.length}` };
      },
      () => {},
      { intervals: [0, 100, 300, 500, 800, 1300], keepAliveIntervalMs: null },
      fakeTimer
    );

    scheduler.startBackoffSequence();
    for (let t = 0; t < 1400; t += 50) {
      await fakeTimer.advanceTimersByTimeAsync(50);
    }

    // All six front-loaded intervals fire, including sub-floor gaps (100ms, 200ms).
    expect(captureTimes).toEqual([0, 100, 300, 500, 800, 1300]);
  });
});

describe("DefaultScreenshotBackoffScheduler stop() vs cancelPendingCaptures()", () => {
  // cancelPendingCaptures must preserve the trailing capture (restart-storm survival), but stop()
  // must clear it so a disconnect genuinely quiesces the scheduler (issue #4927, Finding 1).
  const FLOOR = 350;

  function makeScheduler(fakeTimer: FakeTimer, captureTimes: number[]) {
    return new DefaultScreenshotBackoffScheduler(
      async () => {
        captureTimes.push(fakeTimer.now());
        return { success: true, data: `frame-${captureTimes.length}` };
      },
      () => {},
      { intervals: [0, 100], keepAliveIntervalMs: null, minCaptureIntervalMs: FLOOR },
      fakeTimer
    );
  }

  it("cancelPendingCaptures lets an already-armed trailing capture still fire", async () => {
    const fakeTimer = new FakeTimer();
    const captureTimes: number[] = [];
    const scheduler = makeScheduler(fakeTimer, captureTimes);

    scheduler.startBackoffSequence();
    await fakeTimer.advanceTimersByTimeAsync(0); // leading capture at t=0
    await fakeTimer.advanceTimersByTimeAsync(100); // t=100 tick defers -> arms trailing at t=350
    scheduler.cancelPendingCaptures(); // restart-storm semantics: trailing survives
    await fakeTimer.advanceTimersByTimeAsync(300); // reach t=350

    expect(captureTimes).toEqual([0, 350]);
  });

  it("stop() clears the trailing capture so nothing fires after quiesce", async () => {
    const fakeTimer = new FakeTimer();
    const captureTimes: number[] = [];
    const scheduler = makeScheduler(fakeTimer, captureTimes);

    scheduler.startBackoffSequence();
    await fakeTimer.advanceTimersByTimeAsync(0); // leading capture at t=0
    await fakeTimer.advanceTimersByTimeAsync(100); // arms trailing at t=350
    scheduler.stop(); // disconnect semantics: trailing must NOT survive
    await fakeTimer.advanceTimersByTimeAsync(1000);

    expect(captureTimes).toEqual([0]);
    expect(scheduler.isActive()).toBe(false);
  });
});

describe("DefaultScreenshotBackoffScheduler keepalive respects the floor", () => {
  // A subscriber can request a keepalive cadence below the platform floor; keepalive captures must
  // not bypass the throttle or they keep tripping the rate limit in steady state (issue #4927 P1).
  const FLOOR = 350;

  it("never issues keepalive captures faster than the floor even at a sub-floor cadence", async () => {
    const fakeTimer = new FakeTimer();
    const captureTimes: number[] = [];
    const scheduler = new DefaultScreenshotBackoffScheduler(
      async () => {
        captureTimes.push(fakeTimer.now());
        return { success: true, data: `frame-${captureTimes.length}` };
      },
      () => {},
      { intervals: [0], keepAliveIntervalMs: 250, minCaptureIntervalMs: FLOOR },
      fakeTimer
    );

    scheduler.startBackoffSequence();
    for (let t = 0; t < 1200; t += 50) {
      await fakeTimer.advanceTimersByTimeAsync(50);
    }

    expect(captureTimes[0]).toBe(0);
    expect(captureTimes.length).toBeGreaterThan(1); // keepalive still provides liveness
    for (let i = 1; i < captureTimes.length; i++) {
      expect(captureTimes[i] - captureTimes[i - 1]).toBeGreaterThanOrEqual(FLOOR);
    }
  });
});
