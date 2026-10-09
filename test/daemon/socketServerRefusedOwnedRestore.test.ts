import { describe, expect, test } from "bun:test";
import { DAEMON_OWNED_SESSIONS_PARAM } from "../../src/daemon/constants";
import type { RefusedOwnedSessionRestore } from "../../src/daemon/devicePool";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";

// #11107: a refused owned-session restore skips that session instead of failing an unrelated
// call; the call fails only when it targets the refused session or its device.

const OTHER_SESSION = "11111111-1111-4111-8111-111111111111";
const MINE = "22222222-2222-4222-8222-222222222222";
const REFUSED: RefusedOwnedSessionRestore = {
  sessionId: OTHER_SESSION,
  deviceId: "emulator-5556",
  reason: "owned-by-other-connection",
};

function serverRefusing(autolockRestores: string[][]): UnixSocketServer {
  const pool = {
    restoreOwnedDeviceSessionsForMcpSession: async () => [REFUSED],
    restoreAutolockSessionsForMcpSession: async (ids: string[]) => {
      autolockRestores.push(ids);
    },
    releaseMcpSessionBindings: () => {},
  };
  return new UnixSocketServer(
    "/tmp/never-listened.sock",
    "http://localhost:0/mcp",
    { isInitialized: () => true, getDevicePool: () => pool } as any,
    new FakeTimer(),
  );
}

function restore(server: UnixSocketServer, args: Record<string, unknown>): Promise<void> {
  return (server as any).restoreSelectorSessions(
    { ...args, [DAEMON_OWNED_SESSIONS_PARAM]: [OTHER_SESSION, MINE] },
    "client",
  );
}

describe("refused owned-session restore", () => {
  test("does not fail a call that targets a different device", async () => {
    const restores: string[][] = [];
    const server = serverRefusing(restores);

    await restore(server, { deviceId: "emulator-5554" });
    await restore(server, { platform: "android" });
    await restore(server, { sessionUuid: MINE });

    expect(restores).toHaveLength(3);
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
