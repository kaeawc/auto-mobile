import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server as NetServer } from "node:net";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";

const isWindows = platform() === "win32";

function createFakeDaemonState() {
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

describe("UnixSocketServer close", () => {
  let socketPath: string;
  let server: UnixSocketServer;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `socket-close-${randomUUID()}.sock`);
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      new FakeTimer(),
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  (isWindows ? test.skip : test)("removes its own socket file on close", async () => {
    await server.close();

    expect(existsSync(socketPath)).toBe(false);
  });

  (isWindows ? test.skip : test)("does not remove a replacement socket at the socket path", async () => {
    await unlink(socketPath);
    const replacementServer = await listenOnSocket(socketPath);

    try {
      await server.close();

      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await closeServer(replacementServer);
    }
  });
});

function listenOnSocket(socketPath: string): Promise<NetServer> {
  const replacementServer = createServer();
  return new Promise((resolve, reject) => {
    replacementServer.once("error", reject);
    replacementServer.listen(socketPath, () => {
      replacementServer.off("error", reject);
      resolve(replacementServer);
    });
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}
