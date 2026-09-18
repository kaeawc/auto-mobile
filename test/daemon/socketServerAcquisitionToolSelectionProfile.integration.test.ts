import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_TOOL_SELECTION_PROFILE_PARAM } from "../../src/daemon/constants";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

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
    join(tmpdir(), `fix-sessionless-provision-tool-profile-${randomUUID()}.sock`),
    "http://localhost:0/mcp",
    createFakeDaemonState(),
    new FakeTimer(),
  );
}

function route(
  server: UnixSocketServer,
  socketSessionId: string,
  profileUuid: string | undefined,
): McpForwardRoute {
  const arguments_ = {
    ...(profileUuid ? { [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: profileUuid } : {}),
  };
  const request: DaemonRequest = {
    id: randomUUID(),
    method: "tools/call",
    params: { name: "provisionDevice", arguments: arguments_ },
  };
  return (
    server as unknown as {
      getMcpForwardRoute: (request: DaemonRequest, socketSessionId: string) => McpForwardRoute;
    }
  ).getMcpForwardRoute(request, socketSessionId);
}

describe("UnixSocketServer sessionless acquisition tool-selection forwarding", () => {
  test("carries a connection profile from setToolEnabled to sessionless provisionDevice", () => {
    const server = createServer();
    const socketSessionId = "socket-enabled";
    const profileUuid = "profile-enabled";
    const enableRequest: DaemonRequest = {
      id: "enable",
      method: "tools/call",
      params: { name: "setToolEnabled", arguments: { toolName: "provisionDevice", enabled: true } },
    };
    const enableRoute = (
      server as unknown as {
        getMcpForwardRoute: (request: DaemonRequest, socketSessionId: string) => McpForwardRoute;
      }
    ).getMcpForwardRoute(enableRequest, socketSessionId);
    (
      server as unknown as {
        recordBoundMcpClientKey: (
          request: DaemonRequest,
          socketSessionId: string,
          route: McpForwardRoute,
          sessionWasActiveBeforeForward: boolean,
          response: unknown,
        ) => void;
      }
    ).recordBoundMcpClientKey(enableRequest, socketSessionId, enableRoute, false, {
      content: [{ type: "text", text: JSON.stringify({ sessionUuid: profileUuid }) }],
    });

    // DaemonMcpProxy remembers this profile from the preceding setToolEnabled
    // response and attaches it to the following sessionless acquisition call.
    const resolved = route(server, socketSessionId, profileUuid);

    expect(resolved).toEqual({
      executionKey: `socket:${socketSessionId}:acquisition:provisionDevice`,
      clientKey: `socket:${socketSessionId}:acquisition:provisionDevice:tool-selection:${profileUuid}`,
      toolSelectionProfileUuid: profileUuid,
    });
  });

  test("keeps an unenabled sessionless provisionDevice unseeded", () => {
    const resolved = route(createServer(), "socket-unenabled", undefined);

    expect(resolved).toEqual({
      executionKey: "socket:socket-unenabled:acquisition:provisionDevice",
      clientKey: "socket:socket-unenabled:acquisition:provisionDevice",
    });
  });

  test("keeps different socket profiles isolated for the same acquisition tool", () => {
    const server = createServer();
    const first = route(server, "socket-a", "profile-a");
    const unenabledSecond = route(server, "socket-b", undefined);
    const enabledSecond = route(server, "socket-b", "profile-b");

    expect(first.clientKey).not.toBe(enabledSecond.clientKey);
    expect(first.toolSelectionProfileUuid).toBe("profile-a");
    expect(unenabledSecond.toolSelectionProfileUuid).toBeUndefined();
    expect(enabledSecond.toolSelectionProfileUuid).toBe("profile-b");
  });
});
