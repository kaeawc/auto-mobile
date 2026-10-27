import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { describe, expect, test } from "bun:test";
import {
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
} from "../../src/daemon/wire/constants";
import type { RefusedOwnedSessionRestore } from "../../src/daemon/devicePool";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { FakeTimer } from "../fakes/FakeTimer";
import { StubMcpClient } from "./helpers/fakeMcpClient";
import { FakeSocket } from "../fakes/FakeNetServer";

// #11107: a refused owned-session restore skips that session instead of failing an unrelated
// call; the call fails only when it targets the refused session or its device.

const OTHER_SESSION = "11111111-1111-4111-8111-111111111111";
const MINE = "22222222-2222-4222-8222-222222222222";
const REFUSED: RefusedOwnedSessionRestore = {
  sessionId: OTHER_SESSION,
  deviceId: "emulator-5556",
  reason: "owned-by-other-connection",
};

/** A daemon state that only serves the given device pool. */
function stateWithPool(pool: ReturnType<DaemonStateAccess["getDevicePool"]>): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: () => false,
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => pool,
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
}

function serverRefusing(autolockRestores: string[][]): UnixSocketServerHarness {
  const pool = {
    refreshDevices: async () => 0,
    getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
    releaseDevice: async () => {},
    restoreOwnedDeviceSessionsForMcpSession: async () => [REFUSED],
    restoreAutolockSessionsForMcpSession: async (ids: readonly string[]) => {
      autolockRestores.push([...ids]);
    },
    releaseMcpSessionBindings: () => {},
  };
  return createHarnessServer("/tmp/never-listened.sock", stateWithPool(pool), new FakeTimer());
}

function restore(server: UnixSocketServerHarness, args: Record<string, unknown>): Promise<void> {
  return server.restoreSessions(
    { ...args, [DAEMON_OWNED_SESSIONS_PARAM]: [OTHER_SESSION, MINE] },
    "client",
  );
}

describe("refused owned-session restore", () => {
  test("forwards a token-only call while uninitialized without resolving the pool or declaring ownership", async () => {
    const declarations: string[] = [];
    let poolReads = 0;
    const pool = {
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      declareMcpSessionLivenessOwnerToken: (_id: string, token: string) => {
        declarations.push(token);
      },
    };
    const server = createHarnessServer(
      "/tmp/never-listened.sock",
      {
        ...stateWithPool(pool),
        isInitialized: () => false,
        getDevicePool: () => {
          poolReads += 1;
          return pool;
        },
      },
      new FakeTimer(),
    );
    const forwarded: Record<string, unknown>[] = [];
    server.mcpClientFactory = async () =>
      new StubMcpClient({
        callTool: async ({ arguments: args }) => {
          forwarded.push(args ?? {});
          return { content: [{ type: "text", text: "forwarded" }] };
        },
      });
    server.allowRequests();
    const socket = new FakeSocket();
    server.connect(socket);
    const socketId = server.sessionIds[0]!;
    try {
      const response = await server.dispatchRequest(
        socketId,
        socket,
        {
          id: "token-only",
          type: "mcp_request",
          method: "tools/call",
          params: {
            name: "listDevices",
            arguments: { platform: "android", [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "owner" },
          },
        },
        Date.now(),
      );
      expect(response).toMatchObject({
        success: true,
        result: { content: [{ type: "text", text: "forwarded" }] },
      });
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({ platform: "android" });
      expect(forwarded[0]).not.toHaveProperty(DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM);
      expect(poolReads).toBe(0);
      expect(declarations).toEqual([]);
    } finally {
      socket.destroy();
    }
  });

  test("declares a token before restore, including token-only calls; malformed arguments stay harmless", async () => {
    const events: string[] = [];
    const pool = {
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      declareMcpSessionLivenessOwnerToken: (id: string, token: string) => {
        events.push(`${id}:${token}`);
      },
      restoreOwnedDeviceSessionsForMcpSession: async () => {
        events.push("restore");
        return [];
      },
    };
    const server = createHarnessServer(
      "/tmp/never-listened.sock",
      stateWithPool(pool),
      new FakeTimer(),
    );
    server.allowRequests();
    const socket = new FakeSocket();
    server.connect(socket);
    const socketId = server.sessionIds[0]!;
    const seam = { restoreSelectorSessions: server.restoreSessions.bind(server) };
    try {
      for (const args of [
        undefined,
        null,
        [],
        {},
        { [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: " " },
      ]) {
        await seam.restoreSelectorSessions(args, socketId);
      }
      expect(events).toEqual([]);
      await seam.restoreSelectorSessions(
        { [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "owner" },
        socketId,
      );
      expect(events).toEqual([`${socketId}:owner`]);
      events.length = 0;
      const ownedArgs = {
        [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "owner",
        [DAEMON_OWNED_SESSIONS_PARAM]: [MINE],
      };
      await seam.restoreSelectorSessions(ownedArgs, socketId);
      expect(events).toEqual([`${socketId}:owner`, "restore"]);

      socket.destroy();
      expect(server.state.clientSockets.has(socketId)).toBe(false);
      events.length = 0;
      await seam.restoreSelectorSessions(
        { [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "owner" },
        socketId,
      );
      expect(events).toEqual([]);
      await seam.restoreSelectorSessions(ownedArgs, socketId);
      expect(events).toEqual(["restore"]);
    } finally {
      socket.destroy();
    }
  });

  test("does not fail a call that targets a different device", async () => {
    const restores: string[][] = [];
    const server = serverRefusing(restores);

    await restore(server, { deviceId: "emulator-5554" });
    await restore(server, { platform: "android" });
    await restore(server, { sessionUuid: MINE });

    expect(restores).toHaveLength(3);
  });

  test("excludes the refused session from the autolock restore (#11164)", async () => {
    const restores: string[][] = [];

    await restore(serverRefusing(restores), { deviceId: "emulator-5554" });

    expect(restores).toEqual([[MINE]]);
  });

  test("fails a call that names the refused session", async () => {
    await expect(restore(serverRefusing([]), { sessionUuid: OTHER_SESSION })).rejects.toMatchObject(
      { code: "device_owned_by_other_session" },
    );
  });

  test("fails a call that targets the refused session's device", async () => {
    await expect(restore(serverRefusing([]), { deviceId: "emulator-5556" })).rejects.toMatchObject({
      code: "device_owned_by_other_session",
    });
  });
});
