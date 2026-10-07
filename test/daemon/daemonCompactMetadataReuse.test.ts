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
    { running: {}, requested: undefined },
    { running: {}, requested: true }, // Main treats an unrecorded running value as on.
    { running: {}, requested: false },
    { running: { actionsCompactMetadata: true }, requested: false },
    { running: { actionsCompactMetadata: false }, requested: true },
    { running: { actionsCompactMetadata: false }, requested: undefined },
  ])(
    "tri-state preference $requested respects startup policy with $running",
    async ({ running, requested }) => {
      const manager = new FakeDaemonManager();
      const initial = { ...manager.statusResult, version: DAEMON_VERSION, options: running };
      const needsRestart =
        requested !== undefined && requested !== (running.actionsCompactMetadata ?? true);
      const successor = { ...initial, options: { actionsCompactMetadata: requested } };
      manager.statusResults = needsRestart ? [initial, initial, initial, successor] : [];
      manager.statusResult = needsRestart ? successor : initial;
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
        expect(manager.restartCalled).toBe(needsRestart);
        if (needsRestart) {
          expect(manager.restartOptions).toEqual({ actionsCompactMetadata: requested });
        }
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

  test("external tool arguments cannot forge the private connection preference", async () => {
    const manager = new FakeDaemonManager();
    manager.statusResult = {
      ...manager.statusResult,
      version: DAEMON_VERSION,
      options: { actionsCompactMetadata: false },
    };
    const client = presentationClient("full-profile");
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: manager,
      daemonAvailabilityProbe: async () => true,
      daemonOptions: { actionsCompactMetadata: false },
      timer: new FakeTimer(),
    });
    try {
      await proxy.listTools();
      expect(manager.restartCalled).toBe(false);
      expect(client.callDaemonMethodCalls.at(-1)?.params[DAEMON_TOOL_SELECTION_PROFILE_PARAM]).toBe(
        "full-profile",
      );
      await proxy.callTool("probe", { [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: true });
      expect(client.callToolCalls.at(-1)?.params).not.toHaveProperty(
        INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
      );
    } finally {
      await proxy.close();
    }
  });

  test("an unrelated restart relays the explicit compact preference alongside process options", async () => {
    const manager = new FakeDaemonManager();
    const running = {
      ...manager.statusResult,
      version: DAEMON_VERSION,
      options: { actionsCompactMetadata: true },
    };
    const successor = { ...running, options: { embeddedSdk: true, actionsCompactMetadata: false } };
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
      expect(manager.restartOptions).toEqual({ embeddedSdk: true, actionsCompactMetadata: false });
      expect(client.callToolCalls[0]?.params[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]).toBe(false);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});
