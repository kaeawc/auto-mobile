import { describe, expect, test } from "bun:test";
import { settleDoze } from "../../../../src/features/utility/power/PowerSettle";
import type { DozeReading } from "../../../../src/features/utility/power/PowerTypes";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { sequenceBackoff } from "../../../../src/utils/Backoff";
import { FakeTimer } from "../../../fakes/FakeTimer";

const ACTIVE: DozeReading = { mode: "off", deep: "ACTIVE", light: "ACTIVE" };

describe("settleDoze", () => {
  for (const wanted of ["light", "deep"] as const) {
    test(`settles requested ${wanted} mode after sleeping first`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      let reads = 0;
      const final: DozeReading = {
        mode: wanted,
        deep: wanted === "deep" ? "IDLE" : "ACTIVE",
        light: wanted === "light" ? "IDLE" : "OVERRIDE",
      };
      const result = await settleDoze(
        {
          readDoze: async () => {
            expect(timer.getSleepCallCount()).toBe(reads + 1);
            return ++reads === 2 ? final : ACTIVE;
          },
        },
        wanted,
        {
          timer,
          backoff: sequenceBackoff([10, 20]),
          budgetMs: 1000,
          reading: ACTIVE,
        },
      );
      expect(result).toEqual({ reading: final, settled: true, polls: 2, waitedMs: 30 });
      expect(timer.getSleepHistory()).toEqual([10, 20]);
    });
  }

  test("zero budget keeps the initial reading without a read or sleep", async () => {
    const timer = new FakeTimer();
    let reads = 0;
    const result = await settleDoze(
      {
        readDoze: async () => {
          reads++;
          return ACTIVE;
        },
      },
      "deep",
      {
        timer,
        backoff: sequenceBackoff([10]),
        budgetMs: 0,
        reading: ACTIVE,
      },
    );
    expect(result).toEqual({ reading: ACTIVE, settled: false, polls: 0, waitedMs: 0 });
    expect(reads).toBe(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("abort during a sleep prevents the next read", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const controller = new AbortController();
    let reads = 0;
    const result = await runWithAbortSignal(controller.signal, () =>
      settleDoze(
        {
          readDoze: async () => {
            reads++;
            return ACTIVE;
          },
        },
        "deep",
        {
          timer: {
            now: () => timer.now(),
            sleep: async (ms) => {
              await timer.sleep(ms);
              controller.abort();
            },
          },
          backoff: sequenceBackoff([10]),
          budgetMs: 1000,
          reading: ACTIVE,
        },
      ),
    );
    expect(result).toEqual({ reading: ACTIVE, settled: false, polls: 0, waitedMs: 10 });
    expect(reads).toBe(0);
  });
});
