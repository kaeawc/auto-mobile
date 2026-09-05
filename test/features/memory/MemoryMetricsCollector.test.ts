import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryMetricsCollector } from "../../../src/features/memory/MemoryMetricsCollector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

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
      expect(result[0].durationMs).toBeCloseTo(0.213, 5);
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
    test("should query logcat without the over-narrow dalvikvm/art tag filter", async function () {
      fakeAdb.setCommandResponse("logcat -d -v time", {
        stdout:
          "09-05 12:00:00.123  1234  1234 I com.example.app: Background concurrent copying GC freed 4180(230KB) AllocSpace objects, 0(0B) LOS objects, 49% free, 2MB/4MB, paused 213us,45us total 42.3ms",
        stderr: "",
      } as any);

      const events = await collector.captureGCEvents(0, Date.now());

      expect(events.length).toBe(1);
      expect(events[0].freedKb).toBe(230);
      expect(events[0].durationMs).toBeCloseTo(0.213, 5);

      const executed = fakeAdb.getExecutedCommands();
      const gcCommand = executed.find((cmd) => cmd.includes("logcat"));
      expect(gcCommand).toBeDefined();
      expect(gcCommand).not.toContain("-s dalvikvm:I art:I");
      expect(gcCommand).not.toContain('"GC_"');
    });

    test("should return zero events (not throw) when logcat has no GC lines", async function () {
      fakeAdb.setCommandResponse("logcat -d -v time", { stdout: "", stderr: "" } as any);

      const events = await collector.captureGCEvents(0, Date.now());

      expect(events).toEqual([]);
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
