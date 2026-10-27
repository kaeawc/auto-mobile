import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/wire/constants";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest } from "../../src/daemon/types";
import { createFakeDaemonState, createFakeSession } from "./helpers/inputSocketHarness";

function createServer(): UnixSocketServerHarness {
  // session-a is a live daemon session; session-b is not known to the daemon session manager.
  const sessions = new Map([["session-a", createFakeSession("session-a", "device-1", "android")]]);
  return createHarnessServer(
    join(tmpdir(), `ide-route-${randomUUID()}.sock`),
    createFakeDaemonState(sessions),
    new FakeTimer(),
  );
}

function bindSocketToSessionA(server: UnixSocketServerHarness, socketSessionId: string): void {
  server.bindClient(socketSessionId, {
    clientKey: `socket:${socketSessionId}:session:session-a`,
    executionKey: "device:device-1",
    sessionUuid: "session-a",
    requiresLiveDaemonSession: true,
  });
}

async function route(
  server: UnixSocketServerHarness,
  request: DaemonRequest,
  socketSessionId: string,
) {
  return await server.forwardRouteFor(request, socketSessionId);
}

describe("UnixSocketServer ide/getNavigationGraph cross-session routing", () => {
  test("an explicit sessionUuid B does not repurpose the socket's bound (session-a) client", async () => {
    const server = createServer();
    const socketSessionId = "socket-A";
    bindSocketToSessionA(server, socketSessionId);

    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "ide/getNavigationGraph",
      params: { sessionUuid: "session-b" },
    };
    const resolved = await route(server, request, socketSessionId);

    // The read must route to session-b's OWN client, never session-a's bound
    // transport (whose SessionToolBinding would otherwise be rebound to B).
    expect(resolved.clientKey).toBe(`socket:${socketSessionId}:session:session-b`);
    expect(resolved.sessionUuid).toBe("session-b");
    expect(resolved.executionKey).toBe("session:session-b");
  });

  test("no-sessionUuid getNavigationGraph still reuses the socket's bound client", async () => {
    const server = createServer();
    const socketSessionId = "socket-A";
    bindSocketToSessionA(server, socketSessionId);

    const request: DaemonRequest = {
      id: "2",
      type: "mcp_request",
      method: "ide/getNavigationGraph",
      params: {},
    };
    const resolved = await route(server, request, socketSessionId);

    expect(resolved.clientKey).toBe(`socket:${socketSessionId}:session:session-a`);
    expect(resolved.sessionUuid).toBe("session-a");
  });

  test("an explicit sessionUuid equal to the bound session keeps routing to that session", async () => {
    const server = createServer();
    const socketSessionId = "socket-A";
    bindSocketToSessionA(server, socketSessionId);

    const request: DaemonRequest = {
      id: "3",
      type: "mcp_request",
      method: "ide/getNavigationGraph",
      params: { sessionUuid: "session-a" },
    };
    const resolved = await route(server, request, socketSessionId);

    expect(resolved.clientKey).toBe(`socket:${socketSessionId}:session:session-a`);
    expect(resolved.sessionUuid).toBe("session-a");
  });
});

describe("tools/call selector forwarding", () => {
  test.each([{ platform: "ios" }, { platform: "ios", deviceId: "iphone" }])(
    "does not seed an implicit selector from the socket's previous binding: %j",
    async (args) => {
      const server = createServer();
      bindSocketToSessionA(server, "socket-A");
      const resolved = await route(
        server,
        {
          id: "selector",
          type: "mcp_request",
          method: "tools/call",
          params: { name: "observe", arguments: args },
        },
        "socket-A",
      );
      expect(resolved.sessionUuid).toBeUndefined();
      const forwarded = server.withAutolockKey(args, "socket-A", 1000);
      expect(forwarded.sessionUuid).toBeUndefined();
      expect(forwarded.__mcpSessionId).toBe("socket-A");
    },
  );

  test("a pinned proxy's injected UUID keeps the bound transport", async () => {
    const server = createServer();
    bindSocketToSessionA(server, "socket-A");
    const args = {
      platform: "ios",
      deviceId: "iphone",
      sessionUuid: "session-a",
      [DAEMON_BOUND_SESSION_PARAM]: "session-a",
    };
    const resolved = await route(
      server,
      {
        id: "pinned",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "observe", arguments: args },
      },
      "socket-A",
    );
    expect(resolved.sessionUuid).toBe("session-a");
    const forwarded = server.withAutolockKey(args, "socket-A", 1000);
    const binding = new SessionToolBinding(resolved.sessionUuid);
    expect(() =>
      binding.resolveDeviceSessionUuid(undefined, forwarded, () => ({
        deviceId: "device-1",
        platform: "android",
      })),
    ).toThrow("device_outside_bound_session");
  });

  test("preserves an explicit UUID matching the prior binding over a conflicting platform", async () => {
    const server = createServer();
    bindSocketToSessionA(server, "socket-A");
    const args = { sessionUuid: "session-a", platform: "ios" };
    const resolved = await route(
      server,
      {
        id: "explicit",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "observe", arguments: args },
      },
      "socket-A",
    );
    const forwarded = server.withAutolockKey(args, "socket-A", 1000);
    const binding = new SessionToolBinding(resolved.sessionUuid);
    expect(forwarded.sessionUuid).toBe("session-a");
    expect(
      binding.resolveDeviceSessionUuid(undefined, forwarded, () => ({
        deviceId: "device-1",
        platform: "android",
      })),
    ).toBe("session-a");
  });
});
