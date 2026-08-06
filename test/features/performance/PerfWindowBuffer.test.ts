import { describe, it, expect } from "bun:test";
import { PerfWindowBuffer, PerfSample } from "../../../src/features/performance/PerfWindowBuffer";

/** Build a sample with sensible defaults; override only what a test cares about. */
function sample(overrides: Partial<PerfSample> & { t: number }): PerfSample {
  return {
    fps: null,
    frameTimeMs: null,
    jankFrames: null,
    touchLatencyMs: null,
    cpuUsagePercent: null,
    memoryUsageMb: null,
    ...overrides,
  };
}

describe("PerfWindowBuffer", () => {
  describe("empty / warm-up", () => {
    it("returns an empty snapshot with null sub-objects when no samples exist", () => {
      const buffer = new PerfWindowBuffer();
      const snap = buffer.snapshot("device-1", 1000, 5000);

      expect(snap.windowMs).toBe(5000);
      expect(snap.sampleCount).toBe(0);
      expect(snap.oldestSampleAgeMs).toBeNull();
      expect(snap.fps).toBeNull();
      expect(snap.jank).toBeNull();
      expect(snap.touchLatencyMs).toBeNull();
      expect(snap.cpu).toBeNull();
      expect(snap.memoryMb).toBeNull();
    });

    it("reports oldestSampleAgeMs relative to the snapshot time", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1000, fps: 60 }));
      buffer.record("device-1", sample({ t: 1500, fps: 60 }));

      const snap = buffer.snapshot("device-1", 2000, 5000);
      expect(snap.sampleCount).toBe(2);
      expect(snap.oldestSampleAgeMs).toBe(1000); // 2000 - 1000
    });
  });

  describe("windowing", () => {
    it("excludes samples older than the window", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1000, fps: 30 })); // outside 5s window at now=7000
      buffer.record("device-1", sample({ t: 3000, fps: 60 })); // inside
      buffer.record("device-1", sample({ t: 6000, fps: 60 })); // inside

      const snap = buffer.snapshot("device-1", 7000, 5000); // cutoff = 2000
      expect(snap.sampleCount).toBe(2);
      expect(snap.fps).not.toBeNull();
      // The 30fps outlier is excluded, so percentiles reflect only the 60s.
      expect(snap.fps!.p50).toBe(60);
    });

    it("prunes out-of-window samples from storage as a side effect", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1000, fps: 30 }));
      buffer.record("device-1", sample({ t: 6000, fps: 60 }));

      buffer.snapshot("device-1", 7000, 5000); // prunes t=1000

      // A later snapshot with a wide window still cannot see the pruned sample.
      const snap = buffer.snapshot("device-1", 7000, 100000);
      expect(snap.sampleCount).toBe(1);
    });

    it("isolates samples per device", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1000, fps: 60 }));
      buffer.record("device-2", sample({ t: 1000, fps: 20 }));

      expect(buffer.snapshot("device-1", 1000, 5000).fps!.p50).toBe(60);
      expect(buffer.snapshot("device-2", 1000, 5000).fps!.p50).toBe(20);
    });

    it("clear() drops a device's samples", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1000, fps: 60 }));
      buffer.clear("device-1");
      expect(buffer.snapshot("device-1", 1000, 5000).sampleCount).toBe(0);
    });
  });

  describe("percentiles", () => {
    it("computes fps p50/p90/p95/p99 over the window", () => {
      const buffer = new PerfWindowBuffer();
      // 1..10 fps at t=1..10; window covers all at now=10.
      for (let i = 1; i <= 10; i += 1) {
        buffer.record("device-1", sample({ t: i, fps: i }));
      }
      const snap = buffer.snapshot("device-1", 10, 100);
      // computePercentile uses linear interpolation over [1..10].
      expect(snap.fps!.p50).toBe(5.5);
      expect(snap.fps!.p90).toBeCloseTo(9.1, 5);
      expect(snap.fps!.p95).toBeCloseTo(9.55, 5);
      expect(snap.fps!.p99).toBeCloseTo(9.91, 5);
    });

    it("skips null fps values so percentiles reflect only real frames", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1, fps: 60 }));
      buffer.record("device-1", sample({ t: 2, fps: null })); // idle tick
      buffer.record("device-1", sample({ t: 3, fps: 60 }));

      const snap = buffer.snapshot("device-1", 3, 100);
      expect(snap.sampleCount).toBe(3); // all three counted as samples
      expect(snap.fps!.p50).toBe(60); // but only the two 60s feed the percentile
    });

    it("returns null fps when every sample lacks a frame reading", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1, cpuUsagePercent: 10 }));
      const snap = buffer.snapshot("device-1", 1, 100);
      expect(snap.fps).toBeNull();
      expect(snap.cpu).not.toBeNull();
    });
  });

  describe("jank", () => {
    it("sums jank frames and derives a per-second rate over the covered span", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1000, jankFrames: 2 }));
      buffer.record("device-1", sample({ t: 1500, jankFrames: 3 }));
      buffer.record("device-1", sample({ t: 2000, jankFrames: 5 }));

      const snap = buffer.snapshot("device-1", 3000, 5000);
      expect(snap.jank!.total).toBe(10);
      // 3 samples span 1000ms across 2 gaps → coverage = 1000 * 3/2 = 1500ms
      // (includes the oldest sample's own interval) → 10 / 1.5s = 6.67/s.
      expect(snap.jank!.perSecond).toBeCloseTo(6.67, 2);
    });

    it("counts the oldest sample's interval in the rate (no off-by-one)", () => {
      const buffer = new PerfWindowBuffer();
      // Two 500ms samples totaling 5 janks → 1s of coverage → 5/s, not 10/s.
      buffer.record("device-1", sample({ t: 1000, jankFrames: 2 }));
      buffer.record("device-1", sample({ t: 1500, jankFrames: 3 }));

      const snap = buffer.snapshot("device-1", 2000, 5000);
      expect(snap.jank!.total).toBe(5);
      expect(snap.jank!.perSecond).toBe(5);
    });

    it("falls back to total as the rate when the span is zero", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1000, jankFrames: 4 }));
      const snap = buffer.snapshot("device-1", 1000, 5000); // now == sample.t → zero span
      expect(snap.jank!.total).toBe(4);
      expect(snap.jank!.perSecond).toBe(4);
    });
  });

  describe("touch latency, cpu, memory", () => {
    it("summarizes touch latency as p50/p95/latest", () => {
      const buffer = new PerfWindowBuffer();
      [10, 20, 30, 40].forEach((v, i) => buffer.record("device-1", sample({ t: i + 1, touchLatencyMs: v })));
      const snap = buffer.snapshot("device-1", 10, 100);
      expect(snap.touchLatencyMs!.p50).toBe(25);
      expect(snap.touchLatencyMs!.latest).toBe(40);
    });

    it("summarizes cpu and memory as avg/latest", () => {
      const buffer = new PerfWindowBuffer();
      buffer.record("device-1", sample({ t: 1, cpuUsagePercent: 10, memoryUsageMb: 100 }));
      buffer.record("device-1", sample({ t: 2, cpuUsagePercent: 30, memoryUsageMb: 200 }));

      const snap = buffer.snapshot("device-1", 2, 100);
      expect(snap.cpu!.avg).toBe(20);
      expect(snap.cpu!.latest).toBe(30);
      expect(snap.memoryMb!.avg).toBe(150);
      expect(snap.memoryMb!.latest).toBe(200);
    });
  });

  describe("bounded memory", () => {
    it("caps retained samples per device at MAX_SAMPLES_PER_DEVICE", () => {
      const buffer = new PerfWindowBuffer();
      const total = PerfWindowBuffer.MAX_SAMPLES_PER_DEVICE + 50;
      for (let i = 0; i < total; i += 1) {
        buffer.record("device-1", sample({ t: i, fps: 60 }));
      }
      // A window wide enough to include everything still only sees the cap.
      const snap = buffer.snapshot("device-1", total, total * 10);
      expect(snap.sampleCount).toBe(PerfWindowBuffer.MAX_SAMPLES_PER_DEVICE);
    });
  });
});
