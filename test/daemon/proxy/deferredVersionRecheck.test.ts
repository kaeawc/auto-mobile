import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as constants from "../../../src/daemon/wire/constants";
import { DaemonClient } from "../../../src/daemon/client/client";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import type { DaemonStatus } from "../../../src/daemon/types";
import { logger } from "../../../src/utils/logger";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeTimer } from "../../fakes/FakeTimer";

const CLEAN = "0.0.87+g15404adf7979";
const DIRTY = `${CLEAN}.dirty.47e2e3e8f6a5`;
const BUILD = { entryScript: "/checkout/src/index.ts", buildId: "same-build" };
const COOLDOWN_MS = constants.DAEMON_VERSION_RESTART_COOLDOWN_MS;

// #18099: a same-checkout daemon reused inside the restart cooldown (#18090) must be
// reconciled again by a later call on the established connection, after the cooldown.
describe("cooldown-deferred version reconciliation on an established connection (#18099)", () => {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    const settled = spyOn(constants, "syncSettledDaemonVersion").mockReturnValue(true);
    const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(
      () => settled.mockRestore(),
      () => available.mockRestore(),
      () => warn.mockRestore(),
    );
  });
  afterEach(() => restores.splice(0).forEach((restore) => restore()));

  function connectedProxy() {
    const timer = new FakeTimer();
    timer.advanceTime(100_000);
    const manager = new FakeDaemonManager();
    const young: DaemonStatus = {
      running: true,
      pid: 1234,
      socketPath: "/tmp/test.sock",
      startedAt: timer.now() - COOLDOWN_MS / 2,
      version: CLEAN,
      ...BUILD,
    };
    manager.statusResult = young;
    let clients = 0;
    const proxy = new DaemonMcpProxy({
      clientFactory: () => {
        clients++;
        return new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
      },
      daemonManager: manager,
      autoStartDaemon: true,
      timer,
      clientVersion: DIRTY,
      buildIdentity: BUILD,
    });
    return { clientCount: () => clients, manager, proxy, timer, young };
  }

  test("a call after the cooldown restarts the reused daemon and reconnects", async () => {
    const { clientCount, manager, proxy, timer, young } = connectedProxy();
    try {
      await proxy.ensureConnected();
      expect(manager.restartCallCount).toBe(0);
      expect(clientCount()).toBe(1);

      // Still inside the cooldown: the established connection is reused as is.
      await proxy.ensureConnected();
      expect(manager.restartCallCount).toBe(0);

      timer.advanceTime(COOLDOWN_MS);
      const restarted: DaemonStatus = {
        ...young,
        pid: 5678,
        startedAt: timer.now(),
        version: DIRTY,
      };
      manager.statusResults = [young, restarted, restarted, restarted];
      await proxy.ensureConnected();
      expect(manager.restartCallCount).toBe(1);
      expect(clientCount()).toBe(2);

      // The deferral is spent: later calls reuse the new connection.
      await proxy.ensureConnected();
      expect(manager.restartCallCount).toBe(1);
      expect(clientCount()).toBe(2);
    } finally {
      await proxy.close();
    }
  });

  test("a daemon that already matches after the cooldown keeps the connection", async () => {
    const { clientCount, manager, proxy, timer, young } = connectedProxy();
    try {
      await proxy.ensureConnected();
      timer.advanceTime(COOLDOWN_MS);
      // A sibling client restarted the daemon to this client's version meanwhile.
      manager.statusResult = { ...young, pid: 5678, version: DIRTY };
      await proxy.ensureConnected();
      await proxy.ensureConnected();
      expect(manager.restartCallCount).toBe(0);
      expect(clientCount()).toBe(1);
    } finally {
      await proxy.close();
    }
  });
});
