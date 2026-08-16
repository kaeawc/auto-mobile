import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { defaultTimer } from "../../src/utils/SystemTimer";
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

  (isWindows ? test.skip : test)("is idempotent after shutdown", async () => {
    await server.close();

    await expect(server.close()).resolves.toBeUndefined();
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

  (isWindows ? test.skip : test)("does not remove a successor socket bound during close", async () => {
    const listener = (server as unknown as { server: NetServer | null }).server;
    expect(listener).not.toBeNull();

    const replacementServer = createServer();
    const originalClose = listener!.close.bind(listener);
    listener!.close = callback => originalClose(error => {
      replacementServer.listen(socketPath, () => callback?.(error));
    });

    try {
      await server.close();

      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await closeServer(replacementServer);
    }
  });

  (isWindows ? test.skip : test)("destroys active clients before waiting for server shutdown", async () => {
    const client = await connectClient(socketPath);
    const clientClosed = once(client, "close");
    const closePromise = server.close();

    try {
      await resolvesWithin(Promise.all([closePromise, clientClosed]), 100);
      expect(client.destroyed).toBe(true);
    } finally {
      if (!client.destroyed) {
        client.destroy();
      }
      await closePromise;
    }
  });
});

async function connectClient(socketPath: string): Promise<Socket> {
  const client = createConnection(socketPath);
  await once(client, "connect");
  return client;
}

function resolvesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = defaultTimer.setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      value => {
        defaultTimer.clearTimeout(timeout);
        resolve(value);
      },
      error => {
        defaultTimer.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

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
