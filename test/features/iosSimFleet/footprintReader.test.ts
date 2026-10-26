import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import { CommandFleetHostSource } from "../../../src/features/iosSimFleet/FleetHostSource";
import {
  CachedFootprintReader,
  FOOTPRINT_CACHE_TTL_MS,
  FOOTPRINT_MAX_WAIT_MS,
  FOOTPRINT_RUN_TIMEOUT_MS,
} from "../../../src/features/iosSimFleet/footprintSnapshot";
import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../src/features/bootAdmission/BootAdmissionGate";
import { logger } from "../../../src/utils/logger";
import type { FleetCostReport } from "../../../src/features/iosSimFleet/types";
import type { ExecResult } from "../../../src/models";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import type { SimulatorInventoryEntry } from "../../../src/features/iosSimFleet/types";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SeededRandom } from "../../fakes/SeededRandom";

// #15307: with 16+ booted simulators one `top -l 1` costs 2.5-4.4 s, concurrent runs serialize in
// the kernel (4 take 12.5 s), and the sample budget is 15 s. Every provision sampled afresh.

const PS = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-sim-fleet/ps-captured-one-booted-simulator.txt"),
  "utf8",
);
const TOP = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-sim-fleet/top-captured-one-booted-simulator.txt"),
  "utf8",
);

function exec(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: () => false,
  };
}

/** `top` stays open until the test finishes it; every other command answers at once. */
class ScriptedExecutor implements HostCommandExecutor {
  readonly topCalls: Array<HostCommandOptions | undefined> = [];
  private readonly topWaiters: Array<{ ok: () => void; fail: (e: Error) => void }> = [];

  executeCommand(
    command: string,
    _args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    if (command !== "top") {
      return Promise.resolve(exec(command === "ps" ? PS : "1"));
    }
    this.topCalls.push(options);
    return new Promise((resolve, reject) => {
      this.topWaiters.push({ ok: () => resolve(exec(TOP)), fail: reject });
    });
  }

  finishTop(): void {
    this.topWaiters.splice(0).forEach((w) => w.ok());
  }

  failTop(error: Error): void {
    this.topWaiters.splice(0).forEach((w) => w.fail(error));
  }
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function settle<T>(promise: Promise<T>): {
  state: "pending" | "ok" | "err";
  value?: T;
  error?: unknown;
} {
  const result: { state: "pending" | "ok" | "err"; value?: T; error?: unknown } = {
    state: "pending",
  };
  promise.then(
    (value) => Object.assign(result, { state: "ok", value }),
    (error: unknown) => Object.assign(result, { state: "err", error }),
  );
  return result;
}

describe("CachedFootprintReader", () => {
  test("concurrent readers share one top child instead of starting one each", async () => {
    const executor = new ScriptedExecutor();
    const reader = new CachedFootprintReader(executor, new FakeTimer());
    const reads = [reader.read(), reader.read(), reader.read(), reader.read()];
    await tick();
    expect(executor.topCalls.length).toBe(1);

    executor.finishTop();
    const results = await Promise.all(reads);
    expect(results.every((r) => r.size > 0)).toBe(true);
  });

  test("a sample is reused until it ages out, then re-read", async () => {
    const executor = new ScriptedExecutor();
    const timer = new FakeTimer();
    const reader = new CachedFootprintReader(executor, timer);
    const first = reader.read();
    await tick();
    executor.finishTop();
    await first;

    timer.advanceTime(FOOTPRINT_CACHE_TTL_MS - 1);
    await reader.read();
    expect(executor.topCalls.length).toBe(1);

    timer.advanceTime(1);
    const second = reader.read();
    await tick();
    expect(executor.topCalls.length).toBe(2);
    executor.finishTop();
    await second;
  });

  test("the shared child is bounded by its own timeout, not a caller's budget", async () => {
    const executor = new ScriptedExecutor();
    const reader = new CachedFootprintReader(executor, new FakeTimer());
    const read = reader.read({ timeoutMs: 1_000 });
    read.catch(() => {});
    await tick();
    expect(executor.topCalls[0]?.timeoutMs).toBe(FOOTPRINT_RUN_TIMEOUT_MS);
    expect(executor.topCalls[0]?.signal).toBeUndefined();
  });

  test("a slow top ends the wait at the wait cap, leaving most of the sample budget", async () => {
    const executor = new ScriptedExecutor();
    const timer = new FakeTimer();
    const reader = new CachedFootprintReader(executor, timer);
    const read = settle(reader.read({ timeoutMs: DEFAULT_SAMPLE_TIMEOUT_MS }));
    await tick();

    timer.advanceTime(FOOTPRINT_MAX_WAIT_MS - 1);
    await tick();
    expect(read.state).toBe("pending");
    timer.advanceTime(1);
    await tick();
    expect(read.state).toBe("err");
    expect(FOOTPRINT_MAX_WAIT_MS).toBeLessThan(DEFAULT_SAMPLE_TIMEOUT_MS / 2);
  });

  test("an abandoned run is joined by the next caller, which then gets its result", async () => {
    const executor = new ScriptedExecutor();
    const timer = new FakeTimer();
    const reader = new CachedFootprintReader(executor, timer);
    const abandoned = settle(reader.read());
    await tick();
    timer.advanceTime(FOOTPRINT_MAX_WAIT_MS);
    await tick();
    expect(abandoned.state).toBe("err");

    const retry = reader.read();
    await tick();
    expect(executor.topCalls.length).toBe(1);
    executor.finishTop();
    expect((await retry).size).toBeGreaterThan(0);
  });

  test("when the wait runs out the last sample is used rather than failing", async () => {
    const executor = new ScriptedExecutor();
    const timer = new FakeTimer();
    const reader = new CachedFootprintReader(executor, timer);
    const first = reader.read();
    await tick();
    executor.finishTop();
    const sampled = await first;

    timer.advanceTime(FOOTPRINT_CACHE_TTL_MS);
    const stale = settle(reader.read());
    await tick();
    timer.advanceTime(FOOTPRINT_MAX_WAIT_MS);
    await tick();
    expect(stale.state).toBe("ok");
    expect(stale.value).toBe(sampled);
  });

  test("a failed run is not cached, so the next caller tries again", async () => {
    const executor = new ScriptedExecutor();
    const reader = new CachedFootprintReader(executor, new FakeTimer());
    const failed = settle(reader.read());
    await tick();
    executor.failTop(new Error("top killed"));
    await tick();
    expect(failed.state).toBe("err");

    const retry = reader.read();
    await tick();
    expect(executor.topCalls.length).toBe(2);
    executor.finishTop();
    await retry;
  });
});

describe("a slow top no longer fails the capacity sample (#15307)", () => {
  const BOOTED: SimulatorInventoryEntry[] = [
    {
      udid: "18A2D9B1-CDFA-445A-93AA-A532EA4B5498",
      name: "AutoMobile CI iPhone",
      state: "Booted",
      runtime: "iOS-27-0",
      isAvailable: true,
    },
  ];

  test("the report still arrives inside the sample budget, without footprints", async () => {
    const executor = new ScriptedExecutor();
    const timer = new FakeTimer();
    const source = new CommandFleetHostSource(
      executor,
      timer,
      { totalMemoryBytes: () => 128 * 1024 ** 3, cpuCount: () => 16, loadAverage1m: () => 1 },
      new FakeSimctl(),
      new CachedFootprintReader(executor, timer),
    );
    const collector = new IosSimFleetCostCollector(
      { readHostSnapshot: (o) => source.readHostSnapshot(o), readInventory: async () => BOOTED },
      new InMemoryBootDurationHistory(),
      timer,
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const report = settle(
        collector.collectFresh({ deadlineMs: timer.now() + DEFAULT_SAMPLE_TIMEOUT_MS }),
      );
      await tick();
      expect(report.state).toBe("pending");

      timer.advanceTime(FOOTPRINT_MAX_WAIT_MS);
      await tick();
      expect(report.state).toBe("ok");
      const done = report.value as FleetCostReport;
      expect(done.simulators[0]?.quality).toBe("measured");
      expect(done.simulators[0]?.process?.footprintBytes).toBeUndefined();
      expect(done.errors.join(";")).toContain("memory footprint");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a timed-out sample tells the caller when to retry, with jitter", () => {
  test("two refused callers get different retryAfterMs", async () => {
    const hints = new Set<number | undefined>();
    for (const seed of [1, 2]) {
      const timer = new FakeTimer();
      const gate = new IosSimCapacityGate(
        {
          collect: () => new Promise(() => {}),
          collectFresh: () => new Promise(() => {}),
        },
        timer,
        { random: new SeededRandom(seed), env: {} },
      );
      const check = settle(gate.assertCapacityAvailable());
      await tick();
      timer.advanceTime(DEFAULT_SAMPLE_TIMEOUT_MS);
      await tick();
      expect(check.state).toBe("err");
      const error = check.error as { retryable: boolean; retryAfterMs?: number };
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBeGreaterThanOrEqual(5_000);
      expect(error.retryAfterMs).toBeLessThanOrEqual(10_000);
      hints.add(error.retryAfterMs);
    }
    expect(hints.size).toBe(2);
  });
});
