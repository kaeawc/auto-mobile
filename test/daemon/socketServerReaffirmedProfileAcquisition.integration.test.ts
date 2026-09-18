import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_TOOL_SELECTION_PROFILE_PARAM, DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A successful explicit profile reaffirm is remembered by
 * `DaemonMcpProxy.rememberToolSelectionProfile` and replayed by
 * `withToolSelectionProfile` (src/daemon/daemonMcpProxy.ts) on the next
 * sessionless acquisition. `UnixSocketServer.getToolsCallForwardRoute` then
 * passes it to `acquisitionMcpForwardRoute` (src/daemon/socketServer.ts).
 *
 * Non-socket HTTP MCP clients are per-connection; this Unix-socket daemon-proxy
 * coverage does not assert CLI-proxy-level propagation for those clients.
 */

interface McpForwardRoute {
  executionKey: string;
  clientKey: string;
  toolSelectionProfileUuid?: string;
}

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
  };
}

function createServer(): UnixSocketServer {
  return new UnixSocketServer(
    join(tmpdir(), `avd-lifecycle-consistency-eae282-r2-${randomUUID()}.sock`),
    "http://localhost:0/mcp",
    createFakeDaemonState(),
    new FakeTimer(),
  );
}

function createProxy(client: FakeDaemonClient): DaemonMcpProxy {
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  return new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager,
    autoStartDaemon: false,
    timer: new FakeTimer(),
  });
}

function toolSelectionResponse(sessionUuid: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ sessionUuid, scope: "connection-profile" }),
      },
    ],
  };
}

function getRoute(
  server: UnixSocketServer,
  request: DaemonRequest,
  socketSessionId: string,
): McpForwardRoute {
  return (
    server as unknown as {
      getMcpForwardRoute: (request: DaemonRequest, socketSessionId: string) => McpForwardRoute;
    }
  ).getMcpForwardRoute(request, socketSessionId);
}

describe("reaffirmed tool-selection profile acquisition forwarding", () => {
  test("a fresh proxy replays a server-accepted reaffirmed profile to sessionless provisionDevice", async () => {
    const persistedProfileUuid = "profile-persisted";
    const mintClient = new FakeDaemonClient({
      toolResultFor: (toolName) =>
        toolName === "setToolEnabled" ? toolSelectionResponse(persistedProfileUuid) : undefined,
    });
    const reaffirmClient = new FakeDaemonClient({
      toolResultFor: (toolName) =>
        toolName === "setToolEnabled" ? toolSelectionResponse(persistedProfileUuid) : undefined,
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const mintingProxy = createProxy(mintClient);
    const reaffirmingProxy = createProxy(reaffirmClient);

    try {
      await mintingProxy.callTool("setToolEnabled", { toolName: "provisionDevice", enabled: true });
      await reaffirmingProxy.callTool("setToolEnabled", {
        toolName: "provisionDevice",
        enabled: true,
        sessionUuid: persistedProfileUuid,
      });
      await reaffirmingProxy.callTool("provisionDevice", {});

      expect(reaffirmClient.callToolCalls.at(-1)).toEqual({
        toolName: "provisionDevice",
        params: { [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: persistedProfileUuid },
      });
    } finally {
      isAvailableSpy.mockRestore();
      await Promise.all([mintingProxy.close(), reaffirmingProxy.close()]);
    }
  });

  test("does not replay a differing response from an explicit reaffirm", async () => {
    const requestedProfileUuid = "profile-requested";
    const client = new FakeDaemonClient({
      toolResultFor: (toolName) =>
        toolName === "setToolEnabled" ? toolSelectionResponse("profile-different") : undefined,
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = createProxy(client);

    try {
      await proxy.callTool("setToolEnabled", {
        toolName: "provisionDevice",
        enabled: true,
        sessionUuid: requestedProfileUuid,
      });
      await proxy.callTool("provisionDevice", {});

      expect(client.callToolCalls.at(-1)).toEqual({ toolName: "provisionDevice", params: {} });
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("does not replay a device-session tool update as a connection profile", async () => {
    const deviceSessionUuid = "device-session-a";
    const client = new FakeDaemonClient({
      toolResultFor: (toolName) =>
        toolName === "setToolEnabled"
          ? {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ sessionUuid: deviceSessionUuid, scope: "device-session" }),
                },
              ],
            }
          : undefined,
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = createProxy(client);

    try {
      await proxy.callTool("setToolEnabled", {
        toolName: "provisionDevice",
        enabled: true,
        sessionUuid: deviceSessionUuid,
      });
      await proxy.callTool("provisionDevice", {});

      expect(client.callToolCalls.at(-1)).toEqual({ toolName: "provisionDevice", params: {} });
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("routes a profile-bearing sessionless provisionDevice through its profile client key", () => {
    const server = createServer();
    const socketSessionId = "fresh-reaffirm-socket";
    const persistedProfileUuid = "profile-persisted";

    const route = getRoute(
      server,
      {
        id: "acquire",
        method: "tools/call",
        params: {
          name: "provisionDevice",
          arguments: { [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: persistedProfileUuid },
        },
      },
      socketSessionId,
    );

    expect(route.toolSelectionProfileUuid).toBe(persistedProfileUuid);
    expect(route.clientKey).toEndWith(`:tool-selection:${persistedProfileUuid}`);
  });
});
