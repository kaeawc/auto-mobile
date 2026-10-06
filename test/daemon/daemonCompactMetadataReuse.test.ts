import { describe, expect, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DAEMON_VERSION,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
} from "../../src/daemon/constants";
import type { DaemonOptions } from "../../src/daemon/types";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

function presentationClient(profileUuid: string): FakeDaemonClient {
  return new FakeDaemonClient({
    daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    toolResultFor: (name) =>
      name === "setToolEnabled"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({ sessionUuid: profileUuid, scope: "connection-profile" }),
              },
            ],
          }
        : undefined,
  });
}

describe("compact metadata daemon reuse", () => {
  test.each<{ running: DaemonOptions; requested: boolean | undefined }>([
    { running: {}, requested: true }, // Existing --actions-compact-metadata configs.
    { running: {}, requested: false },
    { running: { actionsCompactMetadata: true }, requested: false },
    { running: { actionsCompactMetadata: false }, requested: true },
    { running: { actionsCompactMetadata: false }, requested: undefined },
  ])(
    "presentation preference $requested never restarts daemon with $running",
    async ({ running, requested }) => {
      const manager = new FakeDaemonManager();
      manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION, options: running };
      const client = presentationClient("profile-a");
      const timer = new FakeTimer();
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: manager,
        daemonAvailabilityProbe: async () => true,
        daemonOptions: { actionsCompactMetadata: requested },
        timer,
      });
      try {
        await proxy.listTools();
        expect(manager.restartCalled).toBe(false);
        expect(timer.getSleepHistory()).toEqual([]);
        if (requested !== undefined) {
          expect(client.callToolCalls[0]?.params[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]).toBe(
            requested,
          );
        } else {
          expect(client.callToolCalls).toEqual([]);
        }
      } finally {
        await proxy.close();
      }
    },
  );

  test("opposing clients share one daemon and relay independent connection preferences", async () => {
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION, options: {} };
    const clients = [presentationClient("compact-profile"), presentationClient("full-profile")];
    const proxies = clients.map(
      (client, index) =>
        new DaemonMcpProxy({
          clientFactory: () => client,
          daemonManager: manager,
          daemonAvailabilityProbe: async () => true,
          daemonOptions: { actionsCompactMetadata: index === 0 },
          timer: new FakeTimer(),
        }),
    );
    try {
      await Promise.all(proxies.map((proxy) => proxy.listTools()));
      expect(manager.restartCalled).toBe(false);
      for (const [index, client] of clients.entries()) {
        expect(client.callToolCalls[0]?.params[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]).toBe(
          index === 0,
        );
        expect(
          client.callDaemonMethodCalls.at(-1)?.params[DAEMON_TOOL_SELECTION_PROFILE_PARAM],
        ).toBe(index === 0 ? "compact-profile" : "full-profile");
      }
      // External tool arguments cannot forge the proxy's private preference.
      await proxies[1].callTool("probe", { [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: true });
      expect(clients[1].callToolCalls.at(-1)?.params).not.toHaveProperty(
        INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
      );
    } finally {
      await Promise.all(proxies.map((proxy) => proxy.close()));
    }
  });

  test("an unrelated restart excludes both old and requested presentation preferences", async () => {
    const manager = new FakeDaemonManager();
    const running = {
      ...manager.statusResult,
      version: DAEMON_VERSION,
      options: { actionsCompactMetadata: true },
    };
    const successor = { ...running, options: { embeddedSdk: true } };
    manager.statusResults = [running, running, running, successor];
    manager.statusResult = successor;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = presentationClient("full-profile");
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: manager,
      daemonAvailabilityProbe: async () => true,
      daemonOptions: { embeddedSdk: true, actionsCompactMetadata: false },
      timer,
    });
    try {
      await proxy.listTools();
      expect(manager.restartCalled).toBe(true);
      expect(manager.restartOptions).toEqual({ embeddedSdk: true });
      expect(client.callToolCalls[0]?.params[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]).toBe(false);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});
