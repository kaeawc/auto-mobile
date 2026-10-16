import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { describe, expect, test } from "bun:test";
import {
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
} from "../../src/daemon/constants";
import type { RefusedOwnedSessionRestore } from "../../src/daemon/devicePool";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { type UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";
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

/** The socket server's private restore step, the only seam this test drives. */
interface RestoreSeam {
  restoreSelectorSessions(args: unknown, socketSessionId: string): Promise<void>;
}

function serverRefusing(autolockRestores: string[][]): UnixSocketServer {
  const pool = {
    refreshDevices: async () => 0,
    getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
    releaseDevice: async () => {},
    restoreOwnedDeviceSessionsForMcpSession: async () => [REFUSED],
    restoreAutolockSessionsForMcpSession: async (ids: string[]) => {
      autolockRestores.push(ids);
    },
    releaseMcpSessionBindings: () => {},
  };
  return createTestUnixSocketServer(
    "/tmp/never-listened.sock",
    "http://localhost:0/mcp",
    { isInitialized: () => true, getDevicePool: () => pool } as unknown as DaemonStateAccess,
    new FakeTimer(),
  );
}

function restore(server: UnixSocketServer, args: Record<string, unknown>): Promise<void> {
  return (server as unknown as RestoreSeam).restoreSelectorSessions(
    { ...args, [DAEMON_OWNED_SESSIONS_PARAM]: [OTHER_SESSION, MINE] },
    "client",
  );
}

describe("refused owned-session restore", () => {
  test("forwards a token-only call while uninitialized without resolving the pool or declaring ownership", async () => {
    const declarations: string[] = [];
    let poolReads = 0;
    const server = createTestUnixSocketServer(
      "/tmp/never-listened.sock",
      "http://localhost:0/mcp",
      {
        isInitialized: () => false,
        getDevicePool: () => {
          poolReads += 1;
          return {
            refreshDevices: async () => 0,
            getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
            declareMcpSessionLivenessOwnerToken: (_id: string, token: string) => {
              declarations.push(token);
            },
          };
        },
      },
      new FakeTimer(),
    );
    const forwarded: Record<string, unknown>[] = [];
    server.mcpClientFactory = async () => ({
      callTool: async ({ arguments: args }) => {
        forwarded.push(args ?? {});
        return { content: [{ type: "text", text: "forwarded" }] };
      },
    });
    server["acceptingRequests"] = true;
    const socket = new FakeSocket();
    server["handleConnection"](socket);
    const socketId = [...server["sessions"].keys()][0]!;
    try {
      const response = await server["handleRequest"](socketId, socket, {
        id: "token-only",
        type: "mcp_request",
        method: "tools/call",
        params: {
          name: "listDevices",
          arguments: { platform: "android", [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "owner" },
        },
      });
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
      declareMcpSessionLivenessOwnerToken: (id: string, token: string) => {
        events.push(`${id}:${token}`);
      },
      restoreOwnedDeviceSessionsForMcpSession: async () => {
        events.push("restore");
        return [];
      },
    };
    const server = createTestUnixSocketServer(
      "/tmp/never-listened.sock",
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getDevicePool: () => pool,
      } as unknown as DaemonStateAccess,
      new FakeTimer(),
    );
    server["acceptingRequests"] = true;
    const socket = new FakeSocket();
    server["handleConnection"](socket);
    const socketId = [...server["sessions"].keys()][0]!;
    const seam = server as unknown as RestoreSeam;
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
      expect(server["clientSockets"].has(socketId)).toBe(false);
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
