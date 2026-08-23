import { describe, it, expect } from "bun:test";
import { RecompositionTracker } from "../../../src/features/performance/RecompositionTracker";
import type { BootedDevice, ObserveResult, RecompositionNodeInfo } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * These tests deliberately omit any package name (no activeWindow.appId and no
 * viewHierarchy.packageName), so processObservation computes and attaches the
 * summary but storeEntries returns before it ever calls getDatabase() — keeping
 * the whole suite DB-free (issue #3067) while still exercising the summary math.
 */

const device: BootedDevice = { deviceId: "device-1" } as BootedDevice;

/** A view-hierarchy node carrying recomposition info (CtrlProxy JSON shape, no `$`). */
function node(recomposition: RecompositionNodeInfo, children: unknown[] = []): unknown {
  return { recomposition, node: children };
}

function observation(nodes: unknown[], updatedAt?: number): ObserveResult {
  return {
    viewHierarchy: { hierarchy: { node: nodes } },
    ...(updatedAt === undefined ? {} : { updatedAt }),
  } as unknown as ObserveResult;
}

describe("RecompositionTracker", () => {
  it("summarizes total recompositions from a fresh observation without a database", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    const result = observation(
      [
        node({ id: "a", composableName: "Alpha", total: 10, rolling1sAverage: 0 }),
        node({ id: "b", composableName: "Beta", total: 5, rolling1sAverage: 0 }),
      ],
      0,
    );

    await tracker.processObservation(result, device);

    const summary = result.recompositionSummary;
    expect(summary).toBeDefined();
    // First observation: sinceLastObservation === total (no prior totals).
    expect(summary?.totalRecompositions).toBe(15);
    expect(summary?.topRecompositions.map((e) => e.recompositionId)).toEqual(["a", "b"]);
  });

  it("ranks the top recompositions by count and caps the list at ten", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    // 12 composables with counts 12..1 so the two smallest must be dropped.
    const nodes = Array.from({ length: 12 }, (_v, i) =>
      node({ id: `c${i}`, total: 12 - i, rolling1sAverage: 0 }),
    );

    const result = observation(nodes, 0);
    await tracker.processObservation(result, device);

    const top = result.recompositionSummary?.topRecompositions ?? [];
    expect(top).toHaveLength(10);
    expect(top.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(top[0].recompCount).toBe(12);
    expect(top[9].recompCount).toBe(3);
    expect(top.map((e) => e.recompositionId)).not.toContain("c10");
    expect(top.map((e) => e.recompositionId)).not.toContain("c11");
  });

  it("breaks a count tie by recompositions-per-second", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    const result = observation(
      [
        node({ id: "slow", total: 8, rolling1sAverage: 1 }),
        node({ id: "fast", total: 8, rolling1sAverage: 9 }),
      ],
      0,
    );

    await tracker.processObservation(result, device);

    const top = result.recompositionSummary?.topRecompositions ?? [];
    expect(top.map((e) => e.recompositionId)).toEqual(["fast", "slow"]);
  });

  it("derives per-second rates from the elapsed time between observations", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());

    // First observation establishes a baseline total of 10 at t=1000ms.
    await tracker.processObservation(
      observation([node({ id: "a", total: 10, rolling1sAverage: 0 })], 1000),
      device,
    );

    // Second observation 2s later: +20 recompositions over 2s → 10/s.
    const second = observation([node({ id: "a", total: 30, rolling1sAverage: 0 })], 3000);
    await tracker.processObservation(second, device);

    const summary = second.recompositionSummary;
    expect(summary?.totalRecompositions).toBe(20);
    expect(summary?.averagePerSecond).toBe(10);
    expect(summary?.topRecompositions[0].recompPerSecond).toBe(10);
  });

  it("prefers the reported rolling 1s average over the elapsed-time estimate", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    await tracker.processObservation(
      observation([node({ id: "a", total: 10, rolling1sAverage: 0 })], 1000),
      device,
    );

    const second = observation([node({ id: "a", total: 30, rolling1sAverage: 42 })], 3000);
    await tracker.processObservation(second, device);

    expect(second.recompositionSummary?.topRecompositions[0].recompPerSecond).toBe(42);
  });

  it("averages recomposition durations only over entries that report one", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    const result = observation(
      [
        node({ id: "a", total: 4, rolling1sAverage: 0, durationMs: 10 }),
        node({ id: "b", total: 4, rolling1sAverage: 0, durationMs: 30 }),
        node({ id: "c", total: 4, rolling1sAverage: 0 }),
      ],
      0,
    );

    await tracker.processObservation(result, device);

    expect(result.recompositionSummary?.averageRecompositionDurationMs).toBe(20);
  });

  it("falls back to the injected clock for the observation timestamp when updatedAt is absent", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const tracker = new RecompositionTracker(timer);

    // Baseline at fake time 1000ms.
    await tracker.processObservation(
      observation([node({ id: "a", total: 10, rolling1sAverage: 0 })]),
      device,
    );

    // Advance the fake clock 4s, then observe again with no updatedAt.
    timer.advanceTime(4000);
    const second = observation([node({ id: "a", total: 50, rolling1sAverage: 0 })]);
    await tracker.processObservation(second, device);

    // +40 over 4s → 10/s, proving the clock (not a real timer) drove the delta.
    expect(second.recompositionSummary?.averagePerSecond).toBe(10);
  });

  it("ignores nodes without recomposition info and produces no summary when none qualify", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    const result = observation([{ node: [] }, { text: "plain" }], 0);

    await tracker.processObservation(result, device);

    expect(result.recompositionSummary).toBeUndefined();
  });

  it("clamps count deltas to zero when a total decreases (process restart)", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    await tracker.processObservation(
      observation([node({ id: "a", total: 100, rolling1sAverage: 0 })], 0),
      device,
    );

    const second = observation([node({ id: "a", total: 5, rolling1sAverage: 0 })], 1000);
    await tracker.processObservation(second, device);

    expect(second.recompositionSummary?.totalRecompositions).toBe(0);
    expect(second.recompositionSummary?.topRecompositions[0].recompCount).toBe(0);
  });

  it("does not expose a summary via getLatestSummary when the package name is unknown", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    await tracker.processObservation(
      observation([node({ id: "a", total: 10, rolling1sAverage: 0 })], 0),
      device,
    );

    expect(tracker.getLatestSummary("device-1", "com.example")).toBeUndefined();
  });

  it("coerces numeric recomposition totals provided as strings", async () => {
    const tracker = new RecompositionTracker(new FakeTimer());
    const result = observation(
      [node({ id: "a", total: "7" as unknown as number, rolling1sAverage: 0 })],
      0,
    );

    await tracker.processObservation(result, device);

    expect(result.recompositionSummary?.totalRecompositions).toBe(7);
  });
});
