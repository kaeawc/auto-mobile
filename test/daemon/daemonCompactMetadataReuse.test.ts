import { describe, expect, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import type { DaemonOptions } from "../../src/daemon/types";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

describe("compact metadata daemon reuse", () => {
  test.each<{ running: DaemonOptions; requested: DaemonOptions; expected: DaemonOptions }>([
    {
      running: { actionsCompactMetadata: true },
      requested: { actionsCompactMetadata: false },
      expected: { actionsCompactMetadata: false },
    },
    {
      running: {},
      requested: { actionsCompactMetadata: false },
      expected: { actionsCompactMetadata: false },
    },
    {
      running: { actionsCompactMetadata: false },
      requested: { actionsCompactMetadata: true },
      expected: { actionsCompactMetadata: true },
    },
    {
      running: { actionsCompactMetadata: false },
      requested: { embeddedSdk: true, actionsCompactMetadata: undefined },
      expected: { actionsCompactMetadata: false, embeddedSdk: true },
    },
  ])(
    "explicit compact-metadata preference survives restart merging: $requested",
    async ({ running, requested, expected }) => {
      const manager = new FakeDaemonManager();
      const status = {
        ...manager.statusResult,
        version: DAEMON_VERSION,
        options: { ...running, actionsDiffObserve: true },
      };
      const successor = { ...status, options: { ...expected, actionsDiffObserve: true } };
      manager.statusResults = [status, status, status, successor];
      manager.statusResult = successor;
      const client = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: manager,
        daemonAvailabilityProbe: async () => true,
        daemonOptions: requested,
        timer,
      });
      try {
        await proxy.listTools();
        expect(manager.restartCalled).toBe(true);
        expect(manager.restartOptions).toEqual({ ...expected, actionsDiffObserve: true });
        expect(timer.getSleepHistory()).toEqual([]);
      } finally {
        await proxy.close();
      }
    },
  );

  test.each<{ running: boolean; requested: DaemonOptions }>([
    { running: false, requested: { actionsCompactMetadata: false } },
    { running: false, requested: { actionsCompactMetadata: undefined } },
    { running: true, requested: { actionsCompactMetadata: undefined, actionsDiffObserve: false } },
  ])(
    "matching or unspecified preferences preserve running $running",
    async ({ running, requested }) => {
      const manager = new FakeDaemonManager();
      manager.statusResult = {
        ...manager.statusResult,
        version: DAEMON_VERSION,
        options: { actionsCompactMetadata: running, actionsDiffObserve: true },
      };
      const client = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const timer = new FakeTimer();
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: manager,
        daemonAvailabilityProbe: async () => true,
        daemonOptions: requested,
        timer,
      });
      try {
        await proxy.listTools();
        expect(manager.restartCalled).toBe(false);
        expect(timer.getSleepHistory()).toEqual([]);
      } finally {
        await proxy.close();
      }
    },
  );
});
