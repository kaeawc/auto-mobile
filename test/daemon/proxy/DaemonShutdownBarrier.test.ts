import { describe, expect, test } from "bun:test";
import { DAEMON_SHUTDOWN_TIMEOUT_MS } from "../../../src/daemon/wire/constants";
import {
  DaemonShutdownBarrier,
  type DaemonShutdownBarrierPort,
} from "../../../src/daemon/proxy/DaemonShutdownBarrier";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakePort implements DaemonShutdownBarrierPort {
  client = true;
  reportsPeerClose = true;
  quiesced = 0;
  resets = 0;
  closing = false;
  autoStart = true;
  hasClient = (): boolean => this.client;
  clientReportsPeerClose = (): boolean => this.reportsPeerClose;
  markQuiesced = (): void => {
    this.quiesced += 1;
  };
  resetConnection = async (): Promise<void> => {
    this.resets += 1;
  };
  isClosing = (): boolean => this.closing;
  socketPath = (): string => "/tmp/fake.sock";
  autoStartDaemon = (): boolean => this.autoStart;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(opts: { available?: boolean; running?: boolean; lockHeld?: boolean } = {}) {
  const timer = new FakeTimer();
  const port = new FakePort();
  const barrier = new DaemonShutdownBarrier(port, {
    timer,
    daemonManager: {
      status: async () => ({ running: opts.running ?? false }) as never,
      isStartupLockHeldByLiveProcess: () => opts.lockHeld ?? false,
    },
    daemonAvailabilityProbe: async () => opts.available ?? true,
  });
  return { timer, port, barrier };
}

describe("DaemonShutdownBarrier", () => {
  test("arm without a client does nothing", () => {
    const { port, barrier } = setup();
    port.client = false;
    barrier.arm();
    expect(barrier.pending).toBeNull();
    expect(port.quiesced).toBe(0);
  });

  test("arm quiesces the client and keeps the barrier pending until peer close", async () => {
    const { port, barrier } = setup();
    barrier.arm();
    expect(port.quiesced).toBe(1);
    expect(barrier.pending).not.toBeNull();
    expect(port.resets).toBe(0);

    barrier.complete();
    await barrier.pending;
    await Promise.resolve();
    expect(port.resets).toBe(0);
    expect(barrier.pending).toBeNull();
  });

  test("arm is idempotent while pending", () => {
    const { port, barrier } = setup();
    barrier.arm();
    const first = barrier.pending;
    barrier.arm();
    expect(barrier.pending).toBe(first);
    expect(port.quiesced).toBe(1);
  });

  test("a client that cannot report peer close is reset immediately", () => {
    const { port, barrier } = setup();
    port.reportsPeerClose = false;
    barrier.arm();
    expect(port.resets).toBe(1);
  });

  test("timeout without peer close resets the stalled transport", async () => {
    const { timer, port, barrier } = setup();
    barrier.arm();
    const resolver = barrier.currentResolver;
    timer.advanceTime(DAEMON_SHUTDOWN_TIMEOUT_MS);
    await barrier.pending;
    expect(port.resets).toBe(1);
    // The timed-out resolver is no longer current, so a late complete is a no-op.
    expect(barrier.currentResolver).toBeNull();
    barrier.complete(resolver);
  });

  test("complete ignores a resolver that is no longer current", () => {
    const { port, barrier } = setup();
    barrier.arm();
    barrier.complete(() => undefined);
    expect(barrier.currentResolver).not.toBeNull();
    expect(port.resets).toBe(0);
  });

  test("restart window ends once the daemon socket is reachable", async () => {
    const { barrier } = setup({ available: true });
    barrier.arm();
    barrier.complete();
    await barrier.pending;
    expect(barrier.pending).toBeNull();
  });

  test("restart window ends when the startup lock is held and auto-start can join it", async () => {
    const { barrier } = setup({ available: false, lockHeld: true });
    barrier.arm();
    barrier.complete();
    await barrier.pending;
    expect(barrier.pending).toBeNull();
  });

  test("restart window keeps waiting while a successor runs without a reachable socket", async () => {
    const { timer, port, barrier } = setup({ available: false, running: true });
    port.autoStart = false;
    barrier.arm();
    barrier.complete();
    const pending = barrier.pending as Promise<void>;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    await timer.advanceTimeAsync(1_000);
    await flush();
    expect(settled).toBe(false);
    port.closing = true;
    await timer.advanceTimeAsync(200);
    await flush();
    await timer.advanceTimeAsync(200);
    await pending;
    expect(settled).toBe(true);
  });
});
