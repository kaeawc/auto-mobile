import { describe, expect, test } from "bun:test";
import {
  createDaemonHealthCheck,
  HEALTH_CHECK_INTERVAL_MS,
  type DaemonHealthCheckDeps,
  type HealthFailureKind,
} from "../../src/daemon/daemonHealthCheck";
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
});
