import { describe, expect, test } from "bun:test";
import {
  createDaemonHealthCheck,
  HEALTH_CHECK_INTERVAL_MS,
  HOST_IO_STALL_MEMORY_MS,
  MAX_IO_STALL_EXCUSED_TIMEOUTS,
  type DaemonHealthCheckDeps,
  type HealthFailureKind,
} from "../../src/daemon/daemonHealthCheck";
import { DatabaseHealthProbeTimeoutError } from "../../src/db/DatabaseHealthProbeTimeoutError";
import { FakeTimer } from "../fakes/FakeTimer";

function harness(overrides: Partial<DaemonHealthCheckDeps> = {}) {
  const timer = new FakeTimer();
  const recovered: HealthFailureKind[] = [];
  let probeCalls = 0;
  let release: (() => void) | null = null;
  let slowProbe = false;
  const deps: DaemonHealthCheckDeps = {
    timer,
    httpServer: () => ({ listening: true }),
    socketServerListening: () => true,
    observationStreamHealthy: () => true,
    retryDegradedObservationStream: async () => {},
    databaseHealthProbe: () => ({
      check: () => {
        probeCalls++;
        return slowProbe
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve();
      },
    }),
    onDatabaseFailureChanged: () => {},
    recover: async (kind) => {
      recovered.push(kind);
    },
    ...overrides,
  };
  const check = createDaemonHealthCheck(deps);
  const tick = async () => {
    timer.setCurrentTime(timer.now() + HEALTH_CHECK_INTERVAL_MS);
    await timer.advanceTimeAsync(0, async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  return {
    timer,
    check,
    tick,
    recovered,
    probeCalls: () => probeCalls,
    setSlow: (slow: boolean) => {
      slowProbe = slow;
    },
    release: () => release?.(),
  };
}

describe("createDaemonHealthCheck", () => {
  test("does not start a probe while the previous one is still running", async () => {
    const h = harness();
    h.setSlow(true);
    h.check.start();

    await h.tick();
    await h.tick();
    await h.tick();

    expect(h.probeCalls()).toBe(1);
    h.release();
    await h.check.stop();
  });

  test("recovers after three consecutive same-kind listener failures", async () => {
    const h = harness({ socketServerListening: () => false });
    h.check.start();

    await h.tick();
    await h.tick();
    expect(h.recovered).toEqual([]);
    await h.tick();

    expect(h.recovered).toEqual(["socket"]);
    await h.check.stop();
  });

  test("reports and clears the database failure message", async () => {
    const messages: Array<string | undefined> = [];
    let failing = true;
    const h = harness({
      databaseHealthProbe: () => ({
        check: async () => {
          if (failing) {
            throw new Error("db down");
          }
        },
      }),
      onDatabaseFailureChanged: (m) => messages.push(m),
    });
    h.check.start();

    await h.tick();
    failing = false;
    await h.tick();

    expect(messages).toEqual(["db down", undefined]);
    await h.check.stop();
  });

  describe("host I/O stall (#11990)", () => {
    const timeoutProbe = () => ({
      check: async () => {
        throw new DatabaseHealthProbeTimeoutError(1000);
      },
    });

    test("on-time probe timeouts while host I/O is stalled never trigger recovery", async () => {
      let stalled = true;
      const h = harness({ databaseHealthProbe: timeoutProbe, hostIoStalled: () => stalled });
      h.check.start();

      for (let i = 0; i < 6; i++) {
        await h.tick();
      }
      expect(h.recovered).toEqual([]);

      // Once the stall clears, genuine timeouts count again from where they stood.
      stalled = false;
      for (let i = 0; i < 3; i++) {
        await h.tick();
      }
      expect(h.recovered).toEqual(["database"]);
      await h.check.stop();
    });

    // Tick 1 starts stalled and clears mid-probe (excused by the start-of-probe reading); ticks 2
    // and 3 are stalled again at judgment. No tick ever counts a strike, so nothing recovers.
    test("a stall that clears before the timeout is judged still spares that probe", async () => {
      let stalled = true;
      const h = harness({
        databaseHealthProbe: () => ({
          check: async () => {
            stalled = false;
            throw new DatabaseHealthProbeTimeoutError(1000);
          },
        }),
        hostIoStalled: () => stalled,
      });
      h.check.start();

      await h.tick();
      stalled = true;
      await h.tick();
      await h.tick();
      expect(h.recovered).toEqual([]);
      await h.check.stop();
    });

    test("hard query errors still count while host I/O is stalled", async () => {
      const h = harness({
        databaseHealthProbe: () => ({
          check: async () => {
            throw new Error("database disk image is malformed");
          },
        }),
        hostIoStalled: () => true,
      });
      h.check.start();

      for (let i = 0; i < 3; i++) {
        await h.tick();
      }
      expect(h.recovered).toEqual(["database"]);
      await h.check.stop();
    });

    test("without a stall signal three on-time timeouts still recover", async () => {
      const h = harness({ databaseHealthProbe: timeoutProbe });
      h.check.start();

      for (let i = 0; i < 3; i++) {
        await h.tick();
      }
      expect(h.recovered).toEqual(["database"]);
      await h.check.stop();
    });

    test("a stall that lapses between ticks keeps excusing timeouts within its memory window", async () => {
      // The log sink abandons a stalled stream after ~30 s, so the live flag drops out for part of
      // every long stall; the daemon's signal remembers the last report for HOST_IO_STALL_MEMORY_MS.
      let lastReportedAt: number | undefined;
      const h = harness({
        databaseHealthProbe: timeoutProbe,
        hostIoStalled: () =>
          lastReportedAt !== undefined && h.timer.now() - lastReportedAt <= HOST_IO_STALL_MEMORY_MS,
      });
      h.check.start();
      // The stall is re-reported every other tick (a fresh write goes unanswered), as the sink
      // does; the ticks in between rely on the remembered report alone.
      for (let i = 0; i < 8; i++) {
        if (i % 2 === 0) {
          lastReportedAt = h.timer.now() + HEALTH_CHECK_INTERVAL_MS;
        }
        await h.tick();
      }
      expect(h.recovered).toEqual([]);
      await h.check.stop();
    });

    test("a stuck stall signal stops excusing timeouts after the cap and recovery resumes", async () => {
      const h = harness({ databaseHealthProbe: timeoutProbe, hostIoStalled: () => true });
      h.check.start();

      for (let i = 0; i < MAX_IO_STALL_EXCUSED_TIMEOUTS; i++) {
        await h.tick();
      }
      expect(h.recovered).toEqual([]);

      for (let i = 0; i < 3; i++) {
        await h.tick();
      }
      expect(h.recovered).toEqual(["database"]);
      await h.check.stop();
    });

    test("a passing probe resets the excused-timeout streak", async () => {
      let healthy = false;
      const h = harness({
        databaseHealthProbe: () => ({
          check: async () => {
            if (!healthy) {
              throw new DatabaseHealthProbeTimeoutError(1000);
            }
          },
        }),
        hostIoStalled: () => true,
      });
      h.check.start();

      for (let i = 0; i < MAX_IO_STALL_EXCUSED_TIMEOUTS - 1; i++) {
        await h.tick();
      }
      healthy = true;
      await h.tick();
      healthy = false;
      for (let i = 0; i < MAX_IO_STALL_EXCUSED_TIMEOUTS; i++) {
        await h.tick();
      }
      expect(h.recovered).toEqual([]);
      await h.check.stop();
    });
  });
});
