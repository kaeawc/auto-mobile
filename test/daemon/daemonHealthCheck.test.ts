import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  AuxiliarySocketBindConflict,
  degradeAuxiliarySocket,
  isAuxiliarySocketUnavailable,
  markAuxiliarySocketAvailable,
} from "../../src/daemon/auxiliarySocketAvailability";
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
import { logger } from "../../src/utils/logger";

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
    onObservationStreamRestored: async () => true,
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
  afterEach(() => {
    markAuxiliarySocketAvailable("observation-stream");
  });

  describe("degraded observation stream restoration", () => {
    const degrade = () =>
      degradeAuxiliarySocket(
        "observation-stream",
        new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream"),
      );

    test("republishes exactly once after a degraded stream is restored", async () => {
      degrade();
      let healthy = false;
      let restored = 0;
      const h = harness({
        observationStreamHealthy: () => healthy,
        retryDegradedObservationStream: async () => {
          markAuxiliarySocketAvailable("observation-stream");
          healthy = true;
        },
        onObservationStreamRestored: async () => {
          expect(isAuxiliarySocketUnavailable("observation-stream")).toBe(false);
          expect(healthy).toBe(true);
          restored++;
          return true;
        },
      });

      await h.check.run();
      expect(restored).toBe(1);
      await h.check.run();
      await h.check.run();
      expect(restored).toBe(1);
      expect(h.probeCalls()).toBe(3);
      expect(h.recovered).toEqual([]);
    });

    test.each(["rejects", "remains degraded", "still unhealthy", "degraded but healthy"])(
      "does not republish when the retry %s",
      async (outcome) => {
        degrade();
        let healthy = false;
        let restored = 0;
        const h = harness({
          observationStreamHealthy: () => healthy,
          retryDegradedObservationStream: async () => {
            if (outcome === "rejects") {
              throw new Error("bind failed");
            }
            if (outcome === "still unhealthy") {
              markAuxiliarySocketAvailable("observation-stream");
            }
            healthy = outcome === "degraded but healthy";
          },
          onObservationStreamRestored: async () => {
            restored++;
            return true;
          },
        });

        await h.check.run();
        expect(restored).toBe(0);
        expect(h.recovered).toEqual([]);
      },
    );

    test.each(["rejects", "declines"])(
      "warns and keeps checking health when identity republish %s",
      async (outcome) => {
        const error = new Error("PID record write failed");
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        let healthy = false;
        let restored = 0;
        const h = harness({
          observationStreamHealthy: () => healthy,
          retryDegradedObservationStream: async () => {
            markAuxiliarySocketAvailable("observation-stream");
            healthy = true;
          },
          onObservationStreamRestored: async () => {
            restored++;
            if (outcome === "rejects") {
              throw error;
            }
            return false;
          },
          // Inconclusive probes do not reset strikes, exposing any accidental health failures.
          databaseHealthProbe: () => ({
            check: async () => {
              throw new DatabaseHealthProbeTimeoutError(1000);
            },
          }),
          hostIoStalled: () => true,
        });
        try {
          for (let i = 0; i < 4; i++) {
            degrade();
            healthy = false;
            await expect(h.check.run()).resolves.toBeUndefined();
          }
          expect(restored).toBe(4);
          expect(h.recovered).toEqual([]);
          if (outcome === "rejects") {
            expect(warn).toHaveBeenCalledWith(
              "Observation stream restored but daemon identity republish failed",
              error,
            );
          } else {
            expect(warn).toHaveBeenCalledWith(
              "Observation stream restored but daemon identity republish was declined",
            );
          }
          expect(
            warn.mock.calls.some(([message]) => message.startsWith("Health check error:")),
          ).toBe(false);
        } finally {
          warn.mockRestore();
        }
      },
    );
  });

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
