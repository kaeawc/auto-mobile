import { describe, expect, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

function createFakeDaemonState(): any {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

/**
 * Minimal stand-in for the connected net.Socket. handleConnection only needs
 * setTimeout + event registration to wire a session; no real I/O is required to
 * observe which session id it minted.
 */
function createFakeSocket(): any {
  return {
    setTimeout() {},
    on() {},
    destroy() {},
  };
}

describe("UnixSocketServer session id comes from the injected IdGenerator", () => {
  test("handleConnection keys the session on the injected generator", () => {
    const idGenerator = new CountingIdGenerator("session");
    const server = new UnixSocketServer(
      "/tmp/never-listened.sock",
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      new FakeTimer(),
      null,
      {},
      idGenerator,
    );

    (server as any).handleConnection(createFakeSocket());
    (server as any).handleConnection(createFakeSocket());

    expect(Array.from((server as any).sessions.keys())).toEqual(["session-1", "session-2"]);
  });
});
