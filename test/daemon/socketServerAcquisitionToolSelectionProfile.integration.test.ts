import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_TOOL_SELECTION_PROFILE_PARAM } from "../../src/daemon/wire/constants";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: () => false,
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
  };
}

function createServer(): UnixSocketServerHarness {
  return createHarnessServer(
    join(tmpdir(), `fix-sessionless-provision-tool-profile-${randomUUID()}.sock`),
    createFakeDaemonState(),
    new FakeTimer(),
  );
}

async function route(
  server: UnixSocketServerHarness,
  socketSessionId: string,
  profileUuid: string | undefined,
) {
  const arguments_ = {
    ...(profileUuid ? { [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: profileUuid } : {}),
  };
  const request: DaemonRequest = {
    id: randomUUID(),
    type: "mcp_request",
    method: "tools/call",
    params: { name: "provisionDevice", arguments: arguments_ },
  };
  return await server.forwardRouteFor(request, socketSessionId);
}

describe("UnixSocketServer sessionless acquisition tool-selection forwarding", () => {
  test("inventory reads with an expired session identity do not bind a socket client", async () => {
    const server = createServer();
    for (const name of ["listDevices", "listDeviceImages"]) {
      const socketSessionId = `socket-${name}`;
      const request: DaemonRequest = {
        id: name,
        type: "mcp_request",
        method: "tools/call",
        params: { name, arguments: { sessionUuid: "expired-session" } },
      };
      const forwardRoute = await server.forwardRouteFor(request, socketSessionId);
      server.recordForwardResult(request, socketSessionId, forwardRoute, {
        sessionWasActiveBeforeForward: false,
        response: { content: [] },
      });
      expect(server.boundClientSocketSessionIds).not.toContain(socketSessionId);
    }
  });

  test("carries a connection profile from setToolEnabled to sessionless provisionDevice", async () => {
    const server = createServer();
    const socketSessionId = "socket-enabled";
    const profileUuid = "profile-enabled";
    const enableRequest: DaemonRequest = {
      id: "enable",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "setToolEnabled", arguments: { toolName: "provisionDevice", enabled: true } },
    };
    const enableRoute = await server.forwardRouteFor(enableRequest, socketSessionId);
    server.recordForwardResult(enableRequest, socketSessionId, enableRoute, {
      sessionWasActiveBeforeForward: false,
      response: { content: [{ type: "text", text: JSON.stringify({ sessionUuid: profileUuid }) }] },
    });

    // DaemonMcpProxy remembers this profile from the preceding setToolEnabled
    // response and attaches it to the following sessionless acquisition call.
    const resolved = await route(server, socketSessionId, profileUuid);

    expect(resolved).toEqual({
      executionKey: `socket:${socketSessionId}:acquisition:provisionDevice`,
      clientKey: `socket:${socketSessionId}:acquisition:provisionDevice:tool-selection:${profileUuid}`,
      toolSelectionProfileUuid: profileUuid,
    });
  });

  test("keeps an unenabled sessionless provisionDevice unseeded", async () => {
    const resolved = await route(createServer(), "socket-unenabled", undefined);

    expect(resolved).toEqual({
      executionKey: "socket:socket-unenabled:acquisition:provisionDevice",
      clientKey: "socket:socket-unenabled:acquisition:provisionDevice",
    });
  });

  test("keeps different socket profiles isolated for the same acquisition tool", async () => {
    const server = createServer();
    const first = await route(server, "socket-a", "profile-a");
    const unenabledSecond = await route(server, "socket-b", undefined);
    const enabledSecond = await route(server, "socket-b", "profile-b");

    expect(first.clientKey).not.toBe(enabledSecond.clientKey);
    expect(first.toolSelectionProfileUuid).toBe("profile-a");
    expect(unenabledSecond.toolSelectionProfileUuid).toBeUndefined();
    expect(enabledSecond.toolSelectionProfileUuid).toBe("profile-b");
  });
});
