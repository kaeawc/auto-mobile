import { describe, expect, test } from "bun:test";
import { DefaultProcessSupervisor } from "../../src/utils/ProcessSupervisor";
import { sequenceBackoff } from "../../src/utils/Backoff";
import { FakeTimer } from "../fakes/FakeTimer";

const flushMicrotasks = async (count: number = 5): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
};

describe("DefaultProcessSupervisor", function () {
  test("monitors liveness and restarts when the process dies", async function () {
    const timer = new FakeTimer();
    let alive = true;
    let exits = 0;
    let restarts = 0;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {
        restarts++;
        alive = true;
      },
      isAlive: async () => alive,
      onExit: () => {
        exits++;
      },
    });

    await supervisor.start();
    alive = false;

    timer.advanceTime(250);
    await flushMicrotasks();

    expect(exits).toBe(1);
    expect(timer.getPendingTimeouts()).toEqual([100]);

    timer.advanceTime(100);
    await flushMicrotasks();

    expect(restarts).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervals()).toEqual([250]);
  });

  test("uses the injected Backoff policy for retry progression", async function () {
    const timer = new FakeTimer();
    const attemptedAt: number[] = [];
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 1000,
      maxRestartAttempts: 3,
      restartBackoff: sequenceBackoff([100, 200, 400]),
      restart: async () => {
        attemptedAt.push(timer.now());
        throw new Error("still down");
      },
      isAlive: async () => false,
    });

    supervisor.processExited();
    await flushMicrotasks();
    expect(timer.getPendingTimeouts()).toEqual([100]);

    timer.advanceTime(100);
    await flushMicrotasks();
    expect(attemptedAt).toEqual([100]);
    expect(timer.getPendingTimeouts()).toEqual([200]);

    timer.advanceTime(200);
    await flushMicrotasks();
    expect(attemptedAt).toEqual([100, 300]);
    expect(timer.getPendingTimeouts()).toEqual([400]);
  });

  test("stop clears monitor and restart timers and suppresses future restarts", async function () {
    const timer = new FakeTimer();
    let restarts = 0;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {
        restarts++;
      },
      isAlive: async () => false,
    });

    await supervisor.start();
    supervisor.processExited();
    await flushMicrotasks();
    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(timer.getPendingTimeouts()).toEqual([100]);

    supervisor.stop();

    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);

    timer.advanceTime(100);
    await flushMicrotasks();

    expect(restarts).toBe(0);
    supervisor.processExited();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("waits for async exit cleanup before scheduling restart", async function () {
    const timer = new FakeTimer();
    let finishExit!: () => void;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {},
      isAlive: async () => false,
      onExit: async () => {
        await new Promise<void>((resolve) => {
          finishExit = resolve;
        });
      },
    });

    supervisor.processExited();
    await flushMicrotasks();

    expect(timer.getPendingTimeoutCount()).toBe(0);

    finishExit();
    await flushMicrotasks();

    expect(timer.getPendingTimeouts()).toEqual([100]);
  });

  test("does not resume monitoring when stopped while restart is in flight", async function () {
    const timer = new FakeTimer();
    let finishRestart!: () => void;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {
        await new Promise<void>((resolve) => {
          finishRestart = resolve;
        });
      },
      isAlive: async () => false,
    });

    supervisor.processExited();
    await flushMicrotasks();
    timer.advanceTime(100);
    await flushMicrotasks();

    supervisor.stop();
    finishRestart();
    await flushMicrotasks();

    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("does not schedule another retry when auto-restart is disabled during an in-flight restart", async function () {
    const timer = new FakeTimer();
    let failRestart!: () => void;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100, 200]),
      restart: async () => {
        await new Promise<void>((resolve) => {
          failRestart = resolve;
        });
        throw new Error("restart failed");
      },
      isAlive: async () => false,
    });

    supervisor.processExited();
    await flushMicrotasks();
    timer.advanceTime(100);
    await flushMicrotasks();

    supervisor.setAutoRestart(false);
    failRestart();
    await flushMicrotasks();

    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("stops scheduling restarts once the max-attempt cap is reached", async function () {
    const timer = new FakeTimer();
    let restarts = 0;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 1000,
      maxRestartAttempts: 2,
      restartBackoff: sequenceBackoff([100, 200]),
      restart: async () => {
        restarts++;
        throw new Error("still down");
      },
      isAlive: async () => false,
    });

    supervisor.processExited();
    await flushMicrotasks();
    expect(timer.getPendingTimeouts()).toEqual([100]);

    timer.advanceTime(100);
    await flushMicrotasks();
    expect(timer.getPendingTimeouts()).toEqual([200]);

    timer.advanceTime(200);
    await flushMicrotasks();

    // Second failed restart hits the cap: no further restart is scheduled and
    // the runner is left idle rather than retrying forever.
    expect(restarts).toBe(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("resets the attempt counter after the cap so a later exit can restart again", async function () {
    const timer = new FakeTimer();
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 1000,
      maxRestartAttempts: 2,
      restartBackoff: sequenceBackoff([100, 200]),
      restart: async () => {
        throw new Error("still down");
      },
      isAlive: async () => false,
    });

    // Exhaust the cap.
    supervisor.processExited();
    await flushMicrotasks();
    timer.advanceTime(100);
    await flushMicrotasks();
    timer.advanceTime(200);
    await flushMicrotasks();
    expect(timer.getPendingTimeoutCount()).toBe(0);

    // A brand-new exit after the cap must schedule a fresh first-attempt restart,
    // not stay permanently wedged. Guarded by resetting restartAttempts to 0.
    supervisor.processExited();
    await flushMicrotasks();
    expect(timer.getPendingTimeouts()).toEqual([100]);
  });

  test("does not treat a throwing liveness probe as a process death", async function () {
    const timer = new FakeTimer();
    let exits = 0;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {},
      isAlive: async () => {
        throw new Error("adb probe rejected");
      },
      onExit: () => {
        exits++;
      },
    });

    await supervisor.start();
    timer.advanceTime(250);
    await flushMicrotasks();

    // A rejected probe must not schedule a restart of a possibly-healthy runner.
    expect(exits).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervals()).toEqual([250]);
  });

  test("reports liveness through the injected liveness check", async function () {
    const timer = new FakeTimer();
    let alive = true;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {},
      isAlive: async () => alive,
    });

    await expect(supervisor.isAlive()).resolves.toBe(true);
    alive = false;
    await expect(supervisor.isAlive()).resolves.toBe(false);
  });

  test("delegates every isAlive query to the injected probe", async function () {
    const timer = new FakeTimer();
    const probeResults = [true, false, true];
    let calls = 0;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {},
      isAlive: async () => probeResults[calls++],
    });

    await expect(supervisor.isAlive()).resolves.toBe(true);
    await expect(supervisor.isAlive()).resolves.toBe(false);
    await expect(supervisor.isAlive()).resolves.toBe(true);
    expect(calls).toBe(3);
  });
});
