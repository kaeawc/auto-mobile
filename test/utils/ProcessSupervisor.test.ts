import { describe, expect, test } from "bun:test";
import { DefaultProcessSupervisor } from "../../src/utils/ProcessSupervisor";
import { sequenceBackoff } from "../../src/utils/Backoff";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessSupervisor } from "../fakes/FakeProcessSupervisor";

const flushMicrotasks = async (count: number = 5): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
};

describe("DefaultProcessSupervisor", function() {
  test("monitors liveness and restarts when the process dies", async function() {
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

  test("uses the injected Backoff policy for retry progression", async function() {
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

  test("stop clears monitor and restart timers and suppresses future restarts", async function() {
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

  test("waits for async exit cleanup before scheduling restart", async function() {
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
        await new Promise<void>(resolve => {
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

  test("does not resume monitoring when stopped while restart is in flight", async function() {
    const timer = new FakeTimer();
    let finishRestart!: () => void;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100]),
      restart: async () => {
        await new Promise<void>(resolve => {
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

  test("does not schedule another retry when auto-restart is disabled during an in-flight restart", async function() {
    const timer = new FakeTimer();
    let failRestart!: () => void;
    const supervisor = new DefaultProcessSupervisor({
      name: "test-process",
      timer,
      monitorIntervalMs: 250,
      restartBackoff: sequenceBackoff([100, 200]),
      restart: async () => {
        await new Promise<void>(resolve => {
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

  test("reports liveness through the injected liveness check", async function() {
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
});

describe("FakeProcessSupervisor", function() {
  test("records calls for consumers without timers or real restarts", async function() {
    const supervisor = new FakeProcessSupervisor();

    await supervisor.start();
    supervisor.processExited();
    supervisor.stop();

    expect(supervisor.startCalls).toBe(1);
    expect(supervisor.processExitedCalls).toBe(1);
    expect(supervisor.stopCalls).toBe(1);
  });
});
