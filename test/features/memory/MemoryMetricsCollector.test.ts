import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryMetricsCollector } from "../../../src/features/memory/MemoryMetricsCollector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("MemoryMetricsCollector - Unit Tests", function () {
  let collector: MemoryMetricsCollector;
  let fakeAdb: FakeAdbExecutor;

  beforeEach(function () {
    // Use FakeAdbExecutor to avoid starting real adb daemon
    fakeAdb = new FakeAdbExecutor();
    collector = new MemoryMetricsCollector(
      { deviceId: "test-device", name: "test", platform: "android" },
      fakeAdb as any,
    );
  });

  describe("parseMeminfo", function () {
    test("should parse Java heap from meminfo output", function () {
      const output = `
        Applications Memory Usage (in Kilobytes):
        Uptime: 12345678 Realtime: 23456789

        ** MEMINFO in pid 1234 [com.example.app] **
                   Pss  Private  Private  SwapPss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------
          Java Heap:    10240        0        0        0    20480    15360     5120
          Native Heap:   5120        0        0        0
          TOTAL:        50000
      `;

      const result = (collector as any).parseMeminfo(output);

      expect(result.javaHeapMb).toBe(10); // 10240 KB = 10 MB
      expect(result.nativeHeapMb).toBe(5); // 5120 KB = 5 MB
      expect(result.totalPssMb).toBe(48.828125); // 50000 KB ≈ 48.83 MB
    });

    test("should handle missing Java heap gracefully", function () {
      const output = `
        Native Heap:   5120
        TOTAL:        50000
      `;

      const result = (collector as any).parseMeminfo(output);

      expect(result.javaHeapMb).toBe(0);
      expect(result.nativeHeapMb).toBe(5);
      expect(result.totalPssMb).toBe(48.828125);
    });

    test("should handle missing Native heap gracefully", function () {
      const output = `
        Java Heap:    10240
        TOTAL:        50000
      `;

      const result = (collector as any).parseMeminfo(output);

      expect(result.javaHeapMb).toBe(10);
      expect(result.nativeHeapMb).toBe(0);
      expect(result.totalPssMb).toBe(48.828125);
    });

    test("should handle missing TOTAL gracefully", function () {
      const output = `
        Java Heap:    10240
        Native Heap:   5120
      `;

      const result = (collector as any).parseMeminfo(output);

      expect(result.javaHeapMb).toBe(10);
      expect(result.nativeHeapMb).toBe(5);
      expect(result.totalPssMb).toBe(0);
    });

    test("should handle alternative TOTAL PSS format", function () {
      const output = `
        Java Heap:    10240
        Native Heap:   5120
        TOTAL PSS:    50000
      `;

      const result = (collector as any).parseMeminfo(output);

      expect(result.totalPssMb).toBe(48.828125);
    });
  });

  describe("parseGCEvents", function () {
    test("should parse Dalvik-era GC events from logcat output", function () {
      const output = `
        I/dalvikvm: GC_FOR_ALLOC freed 1234K, 50% free 5678K/11356K, paused 123ms
        I/dalvikvm: GC_EXPLICIT freed 3456K, 40% free 7890K/13579K, paused 345ms
      `;

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(2);
      expect(result[0].type).toBe("FOR_ALLOC");
      expect(result[0].freedKb).toBe(1234);
      expect(result[0].durationMs).toBe(123);
      expect(result[1].type).toBe("EXPLICIT");
      expect(result[1].freedKb).toBe(3456);
      expect(result[1].durationMs).toBe(345);
    });

    test("should parse modern ART GC lines under the app's process tag (pause in us)", function () {
      // Real-world shape from a Pixel running API 34: pause is reported as
      // "213us,45us total 42.3ms" and the freed size is parenthesized after
      // the object count, under the app's own process tag (not "art").
      const output =
        "09-05 12:00:00.123  1234  1234 I com.example.app: Background concurrent copying GC freed 4180(230KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 213us,45us total 42.3ms";

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(1);
      expect(result[0].type).toBe("Background concurrent copying");
      expect(result[0].freedKb).toBe(230);
      // Sums both stop-the-world components (213us + 45us), not just the first.
      expect(result[0].durationMs).toBeCloseTo(0.258, 5);
    });

    test("should parse older ART GC lines with a bare KB size and pause in ms", function () {
      const output =
        "I/art: Background concurrent mark sweep GC freed 1234KB, 50% free, 5678KB/11356KB, paused 123ms";

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(1);
      expect(result[0].type).toBe("Background concurrent mark sweep");
      expect(result[0].freedKb).toBe(1234);
      expect(result[0].durationMs).toBe(123);
    });

    test("should normalize an adaptively-scaled MB freed size to KB", function () {
      // ART scales the parenthesized size to whichever unit is most readable
      // (B/KB/MB/GB) — a large collection freeing tens of MB must not be
      // mis-parsed as if the number were already in KB.
      const output =
        "09-05 12:00:00.000  1234  1234 I com.example.app: Explicit concurrent copying GC freed 716275(24MB) AllocSpace objects, 0(0B) LOS objects, 55% free, 30MB/60MB, paused 1.5ms";

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(1);
      expect(result[0].freedKb).toBe(24 * 1024);
      expect(result[0].durationMs).toBe(1.5);
    });

    test("should sum multiple comma-separated ART pause components", function () {
      const output =
        "09-05 12:00:00.000  1234  1234 I com.example.app: Background concurrent copying GC freed 500(50KB) AllocSpace objects, 0(0B) LOS objects, 60% free, 1MB/2MB, paused 213us,45us total 42.3ms";

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(1);
      // (213 + 45) us = 258us = 0.258ms — not just the first component (0.213ms).
      expect(result[0].durationMs).toBeCloseTo(0.258, 5);
    });

    test("should parse a mix of Dalvik and ART lines in one logcat capture", function () {
      const output = [
        "I/dalvikvm: GC_FOR_ALLOC freed 1234K, 50% free 5678K/11356K, paused 123ms",
        "09-05 12:00:01.000  1234  1234 I com.example.app: Explicit concurrent copying GC freed 500(50KB) AllocSpace objects, 0(0B) LOS objects, 60% free, 1MB/2MB, paused 500us total 1.2ms",
      ].join("\n");

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(2);
      expect(result[0].type).toBe("FOR_ALLOC");
      expect(result[1].type).toBe("Explicit concurrent copying");
      expect(result[1].freedKb).toBe(50);
      expect(result[1].durationMs).toBeCloseTo(0.5, 5);
    });

    test("should drop GC lines from a different process when scoped to a pid (device-wide buffer)", function () {
      // A device-wide logcat capture (e.g. --pid unsupported on this device)
      // carries GC lines from other processes; only the audited pid's lines
      // must be attributed to it.
      const output = [
        "1725000000.000  1234  1234 I com.example.app: Background concurrent copying GC freed 4180(230KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 213us",
        "1725000000.500  9999  9999 I com.other.app: Background concurrent copying GC freed 9000(900KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 999us",
      ].join("\n");

      const result = (collector as any).parseGCEvents(output, 0, Date.now(), "1234");

      expect(result.length).toBe(1);
      expect(result[0].freedKb).toBe(230);
    });

    test("should drop an event whose parsed epoch timestamp falls outside [start, end]", function () {
      const inWindowMs = 1725000010000; // 1725000010.000s
      const outOfWindowMs = 1725000090000; // 1725000090.000s — 80s later, outside the window
      const output = [
        `1725000010.000  1234  1234 I com.example.app: Background concurrent copying GC freed 100(10KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 100us`,
        `1725000090.000  1234  1234 I com.example.app: Background concurrent copying GC freed 200(20KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 200us`,
      ].join("\n");

      const result = (collector as any).parseGCEvents(output, inWindowMs - 1000, inWindowMs + 1000);

      expect(result.length).toBe(1);
      expect(result[0].freedKb).toBe(10);
      expect(result[0].timestamp).toBe(inWindowMs);
      expect(outOfWindowMs).toBeGreaterThan(inWindowMs + 1000); // sanity: fixture is truly outside
    });

    test("should handle empty logcat output", function () {
      const output = "";

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(0);
    });

    test("should handle logcat output with no GC events without crashing", function () {
      const output = `
        I/some-tag: Some other log message
        D/another-tag: Another log message
      `;

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(0);
    });
  });

  describe("captureGCEvents", function () {
    test("should query logcat scoped to the audited process's pid, without the over-narrow dalvikvm/art tag filter", async function () {
      fakeAdb.setCommandResponse("pidof com.example.app", { stdout: "1234", stderr: "" } as any);
      fakeAdb.setCommandResponse("logcat -d -v epoch", {
        stdout:
          "1725000000.000  1234  1234 I com.example.app: Background concurrent copying GC freed 4180(230KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 213us,45us total 42.3ms",
        stderr: "",
      } as any);

      const events = await collector.captureGCEvents(
        "com.example.app",
        1724999999000,
        1725000001000,
      );

      expect(events.length).toBe(1);
      expect(events[0].freedKb).toBe(230);
      expect(events[0].durationMs).toBeCloseTo(0.258, 5);

      const executed = fakeAdb.getExecutedCommands();
      const gcCommand = executed.find((cmd) => cmd.includes("logcat"));
      expect(gcCommand).toBeDefined();
      expect(gcCommand).not.toContain("-s dalvikvm:I art:I");
      expect(gcCommand).not.toContain('"GC_"');
      expect(gcCommand).toContain("--pid=1234");
    });

    test("should skip capture (not throw) when the audited app has no resolvable pid", async function () {
      fakeAdb.setCommandResponse("pidof com.example.app", { stdout: "", stderr: "" } as any);

      const events = await collector.captureGCEvents("com.example.app", 0, Date.now());

      expect(events).toEqual([]);
      const executed = fakeAdb.getExecutedCommands();
      expect(executed.some((cmd) => cmd.includes("logcat"))).toBe(false);
    });

    test("should return zero events (not throw) when logcat has no GC lines", async function () {
      fakeAdb.setCommandResponse("pidof com.example.app", { stdout: "1234", stderr: "" } as any);
      fakeAdb.setCommandResponse("logcat -d -v epoch", { stdout: "", stderr: "" } as any);

      const events = await collector.captureGCEvents("com.example.app", 0, Date.now());

      expect(events).toEqual([]);
    });

    test("should count an event whose device-epoch timestamp falls within the given bounds", async function () {
      // captureGCEvents' startTimestamp/endTimestamp are now expected to
      // already be in the DEVICE's clock domain (read via
      // getDeviceTimestampMs at the actual audit boundaries — see
      // collectMetrics), so no host<->device translation happens inside
      // captureGCEvents itself; the bounds are compared directly against
      // the device-stamped log line's epoch.
      fakeAdb.setCommandResponse("pidof com.example.app", { stdout: "1234", stderr: "" } as any);
      fakeAdb.setCommandResponse("logcat -d -v epoch", {
        stdout:
          "105000.000  1234  1234 I com.example.app: Background concurrent copying GC freed 100(10KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 100us",
        stderr: "",
      } as any);

      const events = await collector.captureGCEvents(
        "com.example.app",
        105_000_000 - 500,
        105_000_000 + 500,
      );

      expect(events.length).toBe(1);
      expect(events[0].freedKb).toBe(10);
    });

    test("should drop an event whose device-epoch timestamp falls outside the given bounds", async function () {
      fakeAdb.setCommandResponse("pidof com.example.app", { stdout: "1234", stderr: "" } as any);
      fakeAdb.setCommandResponse("logcat -d -v epoch", {
        stdout:
          // 80s after the window end.
          "105080.000  1234  1234 I com.example.app: Background concurrent copying GC freed 100(10KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 100us",
        stderr: "",
      } as any);

      const events = await collector.captureGCEvents(
        "com.example.app",
        105_000_000 - 500,
        105_000_000 + 500,
      );

      expect(events).toEqual([]);
    });

    test("should treat the device-clock window bounds as inclusive", async function () {
      fakeAdb.setCommandResponse("pidof com.example.app", { stdout: "1234", stderr: "" } as any);
      fakeAdb.setCommandResponse("logcat -d -v epoch", {
        stdout: [
          "100.000  1234  1234 I com.example.app: Background concurrent copying GC freed 1(1KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 1us", // exactly at start
          "200.000  1234  1234 I com.example.app: Background concurrent copying GC freed 2(2KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 1us", // exactly at end
        ].join("\n"),
        stderr: "",
      } as any);

      const events = await collector.captureGCEvents("com.example.app", 100_000, 200_000);

      expect(events.length).toBe(2);
    });

    test("should use a pre-resolved pid instead of re-querying pidof (survives a mid-action process restart)", async function () {
      // Simulates resolving the audited pid BEFORE the action (as
      // collectMetrics now does): pid 1111 was alive during the action, but
      // if captureGCEvents queried pidof itself afterward it would get 2222
      // (the app restarted). Passing the pre-resolved pid must win.
      fakeAdb.setCommandResponse("pidof com.example.app", { stdout: "2222", stderr: "" } as any);
      fakeAdb.setCommandResponse("logcat -d -v epoch --pid=1111", {
        stdout:
          "1000.000  1111  1111 I com.example.app: Background concurrent copying GC freed 100(10KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 100us",
        stderr: "",
      } as any);
      fakeAdb.setCommandResponse("logcat -d -v epoch --pid=2222", {
        stdout:
          "1000.000  2222  2222 I com.example.app: Background concurrent copying GC freed 999(999KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 999us",
        stderr: "",
      } as any);

      const events = await collector.captureGCEvents(
        "com.example.app",
        999_500,
        1_000_500,
        undefined,
        "1111",
      );

      expect(events.length).toBe(1);
      expect(events[0].freedKb).toBe(10); // the pid-1111 fixture, not pid-2222's

      const executed = fakeAdb.getExecutedCommands();
      expect(executed.some((cmd) => cmd.includes("pidof"))).toBe(false);
      const gcCommand = executed.find((cmd) => cmd.includes("logcat"));
      expect(gcCommand).toContain("--pid=1111");
    });

    test("should sum AllocSpace and LOS freed sizes into freedKb", function () {
      // ART reports large-object frees as two separate scaled quantities;
      // both must be summed rather than only the (regular-object) AllocSpace figure.
      const output =
        "09-05 12:00:00.000 I com.example.app: Explicit concurrent copying GC freed 123(4MB) AllocSpace objects, 45(2MB) LOS objects, 50% free, 6MB/8MB, paused 1ms";

      const result = (collector as any).parseGCEvents(output, 0, Date.now());

      expect(result.length).toBe(1);
      expect(result[0].freedKb).toBe(4 * 1024 + 2 * 1024); // 4MB AllocSpace + 2MB LOS = 6144KB
      expect(result[0].durationMs).toBe(1);
    });
  });

  describe("collectMetrics pid retention and device-clock boundary capture", function () {
    test("scopes GC capture to the pid resolved before the action, and reads the GC window directly from device-clock boundary reads", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const restartCollector = new MemoryMetricsCollector(
        { deviceId: "test-device", name: "test", platform: "android" },
        fakeAdb as any,
        fakeTimer,
      );

      // First pidof call (collectMetrics, pre-action) sees pid 1111; any
      // later pidof call (e.g. triggerGC, post-action) sees 2222 — simulating
      // the audited app restarting partway through the action.
      fakeAdb.setCommandResponseSequence("pidof com.example.app", [
        { stdout: "1111", stderr: "" } as any,
        { stdout: "2222", stderr: "" } as any,
      ]);
      fakeAdb.setCommandResponse("dumpsys meminfo com.example.app", {
        stdout: "",
        stderr: "",
      } as any);
      fakeAdb.setCommandResponse("dumpsys meminfo --unreachable com.example.app", {
        stdout: "",
        stderr: "",
      } as any);
      // The device clock is read once immediately before the action starts
      // (500_000) and once immediately after it ends (500_500) — these two
      // reads ARE the GC window, with no host-clock translation involved.
      fakeAdb.setDeviceTimestampMsSequence([500_000, 500_500]);
      fakeAdb.setCommandResponse("logcat -d -v epoch --pid=1111", {
        stdout:
          "500.200  1111  1111 I com.example.app: Background concurrent copying GC freed 100(10KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 100us",
        stderr: "",
      } as any);

      const metrics = await restartCollector.collectMetrics("com.example.app", async () => {});

      expect(metrics.gcCount).toBe(1);
      expect(metrics.gcEvents[0].freedKb).toBe(10);

      const executed = fakeAdb.getExecutedCommands();
      const gcCommand = executed.find((cmd) => cmd.includes("logcat -d -v epoch"));
      expect(gcCommand).toContain("--pid=1111");
    });
  });

  describe("parseUnreachableObjects", function () {
    test("should parse unreachable objects from dumpsys output", function () {
      const output = `
        Unreachable memory: 12345 bytes in 45 unreachable objects
      `;

      const result = (collector as any).parseUnreachableObjects(output);

      expect(result.count).toBe(45);
      expect(result.sizeKb).toBeCloseTo(12.06, 2); // 12345 bytes ≈ 12.06 KB
      expect(result.raw).toBe(output);
    });

    test("should handle missing unreachable pattern", function () {
      const output = `
        Some other text without the specific pattern
      `;

      const result = (collector as any).parseUnreachableObjects(output);

      expect(result.count).toBe(0); // Fallback counting
      expect(result.sizeKb).toBe(0);
    });

    test("should count unreachable occurrences as fallback", function () {
      const output = `
        Found unreachable object A
        Found unreachable object B
        Found unreachable object C
      `;

      const result = (collector as any).parseUnreachableObjects(output);

      expect(result.count).toBe(3); // Counts occurrences of "unreachable"
    });
  });
});
