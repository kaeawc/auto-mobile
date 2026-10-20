import { beforeEach, describe, expect, test } from "bun:test";
import { pollSearchUntil } from "../../../src/features/action/searchUntilPoller";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("pollSearchUntil", () => {
  let timer: FakeTimer;
  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  const base = (extra: Partial<Parameters<typeof pollSearchUntil<number>>[0]> = {}) => ({
    timer,
    startTime: timer.now(),
    durationMs: 500,
    intervalMs: 100,
    pacing: "cadence" as const,
    discardLateResult: false,
    fetch: async () => null as number | null,
    accept: () => false,
    ...extra,
  });

  test("cadence pacing polls immediately, then every interval until the window closes", async () => {
    const polledAt: number[] = [];
    const { requestCount } = await pollSearchUntil(
      base({
        fetch: async () => {
          polledAt.push(timer.now());
          return null;
        },
      }),
    );
    expect(polledAt).toEqual([0, 100, 200, 300, 400]);
    expect(requestCount).toBe(5);
  });

  test("sleepFirst pacing waits one interval before every poll including the first", async () => {
    const polledAt: number[] = [];
    await pollSearchUntil(
      base({
        pacing: "sleepFirst",
        fetch: async () => {
          polledAt.push(timer.now());
          return null;
        },
      }),
    );
    expect(polledAt).toEqual([100, 200, 300, 400]);
  });

  test("stops as soon as accept returns true", async () => {
    let n = 0;
    const { requestCount } = await pollSearchUntil(
      base({ fetch: async () => ++n, accept: (value) => value === 2 }),
    );
    expect(requestCount).toBe(2);
  });

  test("a null result still counts as a request and is never offered to accept", async () => {
    let accepted = 0;
    const { requestCount } = await pollSearchUntil(
      base({
        maxRequests: 3,
        accept: () => {
          accepted += 1;
          return false;
        },
      }),
    );
    expect(requestCount).toBe(3);
    expect(accepted).toBe(0);
  });

  test("the request ceiling stops polling even when the window is still open", async () => {
    const { requestCount } = await pollSearchUntil(
      base({ durationMs: 10_000, maxRequests: 2, fetch: async () => 1 }),
    );
    expect(requestCount).toBe(2);
  });

  test("passes the time left in the window to fetch", async () => {
    const remaining: number[] = [];
    await pollSearchUntil(
      base({
        durationMs: 250,
        fetch: async (ms) => {
          remaining.push(ms);
          return null;
        },
      }),
    );
    expect(remaining).toEqual([250, 150, 50]);
  });

  test("discardLateResult refuses a result that arrives after the deadline", async () => {
    const seen: number[] = [];
    await pollSearchUntil(
      base({
        durationMs: 150,
        pacing: "sleepFirst",
        discardLateResult: true,
        fetch: async () => {
          await timer.sleep(100);
          return 7;
        },
        accept: (value) => {
          seen.push(value);
          return true;
        },
      }),
    );
    expect(seen).toEqual([]);
  });

  test("without discardLateResult a late result is still offered to accept", async () => {
    const seen: number[] = [];
    await pollSearchUntil(
      base({
        durationMs: 150,
        fetch: async () => {
          await timer.sleep(200);
          return 7;
        },
        accept: (value) => {
          seen.push(value);
          return true;
        },
      }),
    );
    expect(seen).toEqual([7]);
  });

  test("throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pollSearchUntil(base({ signal: controller.signal }))).rejects.toThrow();
  });
});
