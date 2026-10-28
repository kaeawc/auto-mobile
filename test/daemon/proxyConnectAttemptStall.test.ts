import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client/client";
import {
  DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_VERSION,
} from "../../src/daemon/wire/constants";
import { DaemonConnectAttemptStalledError } from "../../src/daemon/proxy/DaemonConnectAttemptStalledError";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #15019: a connection attempt that never settles held the proxy's single-flight slot, so every
// later caller (including a broker acquisition's reconnect) joined it and waited on an unrelated
// outer deadline: initialize hung for minutes with no request reaching the daemon.

class StalledConnectClient extends FakeDaemonClient {
  override connect(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

describe("proxy stalled connection attempt (#15019)", () => {
  let timer: FakeTimer;
  let isAvailableSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    timer = new FakeTimer();
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  });

  afterEach(() => {
    isAvailableSpy.mockRestore();
  });

  function proxyWith(clients: FakeDaemonClient[], stalledAttempts: number): DaemonMcpProxy {
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    return new DaemonMcpProxy({
      clientFactory: () => {
        const client =
          clients.length < stalledAttempts ? new StalledConnectClient() : new FakeDaemonClient();
        clients.push(client);
        return client;
      },
      daemonManager: manager,
      autoStartDaemon: false,
      timer,
    });
  }

  test("a stalled attempt fails typed at its bound and the next call starts a fresh attempt", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients, 1);
    try {
      const first = proxy.ensureConnected().then(
        () => "connected" as const,
        (error: unknown) => error,
      );
      const joined = proxy.ensureConnected().then(
        () => "connected" as const,
        (error: unknown) => error,
      );
      await drainMicrotasks(50);
      expect(clients).toHaveLength(1);

      timer.advanceTime(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS - 1);
      await drainMicrotasks(50);
      expect(clients).toHaveLength(1);

      timer.advanceTime(1);
      for (const outcome of [await first, await joined]) {
        expect(outcome).toBeInstanceOf(DaemonConnectAttemptStalledError);
        // Typed unavailable, so every reconnect path treats it as retryable.
        expect(outcome).toBeInstanceOf(DaemonUnavailableError);
      }

      await proxy.ensureConnected();
      expect(clients).toHaveLength(2);
      expect(clients[0]!.isConnected()).toBe(false);
      expect(clients[1]!.isConnected()).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  test("a stalled attempt settling late cannot clobber its successor", async () => {
    const clients: FakeDaemonClient[] = [];
    let releaseStalled: (() => void) | undefined;
    class LateConnectClient extends FakeDaemonClient {
      override connect(): Promise<void> {
        return new Promise<void>((resolve) => {
          releaseStalled = () => resolve(super.connect());
        });
      }
    }
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const proxy = new DaemonMcpProxy({
      clientFactory: () => {
        const client = clients.length === 0 ? new LateConnectClient() : new FakeDaemonClient();
        clients.push(client);
        return client;
      },
      daemonManager: manager,
      autoStartDaemon: false,
      timer,
    });
    try {
      const first = proxy.ensureConnected().catch((error: unknown) => error);
      await drainMicrotasks(50);
      timer.advanceTime(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS);
      expect(await first).toBeInstanceOf(DaemonConnectAttemptStalledError);

      await proxy.ensureConnected();
      releaseStalled?.();
      await drainMicrotasks(100);

      expect(clients[1]!.isConnected()).toBe(true);
      expect(clients[0]!.isConnected()).toBe(false);
      // The healthy successor is still the proxy's connection.
      await proxy.ensureConnected();
      expect(clients).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  test("a shutdown barrier that never settles stops holding callers at the attempt bound", async () => {
    const clients: FakeDaemonClient[] = [];
    let stallProbe = false;
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const proxy = new DaemonMcpProxy({
      clientFactory: () => {
        const client = new FakeDaemonClient();
        clients.push(client);
        return client;
      },
      daemonAvailabilityProbe: () =>
        stallProbe ? new Promise<boolean>(() => {}) : Promise.resolve(true),
      daemonManager: manager,
      autoStartDaemon: false,
      timer,
    });
    try {
      await proxy.ensureConnected();
      expect(clients).toHaveLength(1);

      // The daemon announced shutdown: the barrier waits out its EOF bound, then probes forever.
      stallProbe = true;
      proxy.getInternalsForTesting().daemonShutdownBarrier.arm();
      timer.advanceTime(DAEMON_SHUTDOWN_TIMEOUT_MS);
      await drainMicrotasks(50);
      expect(proxy.getInternalsForTesting().daemonShutdownBarrier.pending).not.toBeNull();

      const outcome = proxy.ensureConnected().then(
        () => "connected" as const,
        (error: unknown) => error,
      );
      await drainMicrotasks(50);
      expect(clients).toHaveLength(1);

      stallProbe = false;
      timer.advanceTime(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS);
      expect(await outcome).toBe("connected");
      expect(clients).toHaveLength(2);
      expect(clients[1]!.isConnected()).toBe(true);
    } finally {
      await proxy.close();
    }
  });
});
