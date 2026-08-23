import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";

const isWindows = platform() === "win32";

function createFakeDaemonState(refreshDevices: () => Promise<number> = async () => 0) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

describe("UnixSocketServer close", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let timer: FakeTimer;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `socket-close-${randomUUID()}.sock`);
    timer = new FakeTimer();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      timer,
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

  (isWindows ? test.skip : test)(
    "does not remove a replacement socket at the socket path",
    async () => {
      await unlink(socketPath);
      const replacementServer = await listenOnSocket(socketPath);

      try {
        await server.close();

        expect(existsSync(socketPath)).toBe(true);
      } finally {
        await closeServer(replacementServer);
      }
    },
  );

  (isWindows ? test.skip : test)(
    "does not remove a successor socket bound during close",
    async () => {
      const listener = (server as unknown as { server: NetServer | null }).server;
      expect(listener).not.toBeNull();

      const replacementServer = createServer();
      const originalClose = listener!.close.bind(listener);
      listener!.close = (callback) =>
        originalClose((error) => {
          replacementServer.listen(socketPath, () => callback?.(error));
        });

      try {
        await server.close();

        expect(existsSync(socketPath)).toBe(true);
      } finally {
        await closeServer(replacementServer);
      }
    },
  );

  (isWindows ? test.skip : test)(
    "destroys active clients before waiting for server shutdown",
    async () => {
      const client = await connectClient(socketPath);
      const clientClosed = once(client, "close");
      const closePromise = server.close();

      try {
        await Promise.all([closePromise, clientClosed]);
        expect(client.destroyed).toBe(true);
      } finally {
        if (!client.destroyed) {
          client.destroy();
        }
        await closePromise;
      }
    },
    1_000,
  );

  (isWindows ? test.skip : test)(
    "drains an in-flight request before shutdown completes",
    async () => {
      let releaseRefresh: () => void;
      const refreshComplete = new Promise<number>((resolve) => {
        releaseRefresh = () => {
          resolve(0);
        };
      });
      let signalRefreshStarted: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        signalRefreshStarted = resolve;
      });

      await server.close();
      timer = new FakeTimer();
      server = new UnixSocketServer(
        socketPath,
        "http://localhost:0/mcp",
        createFakeDaemonState(async () => {
          signalRefreshStarted();
          return refreshComplete;
        }),
        timer,
      );
      await server.start();

      const client = await connectClient(socketPath);
      const clientClosed = once(client, "close");
      client.write(
        `${JSON.stringify({ id: "refresh", type: "mcp_request", method: "daemon/refreshDevices" })}\n`,
      );
      await requestStarted;

      let closeCompleted = false;
      const closePromise = server.close().then(() => {
        closeCompleted = true;
      });

      try {
        await clientClosed;
        await Promise.resolve();
        expect(closeCompleted).toBe(false);

        releaseRefresh();
        await closePromise;
      } finally {
        releaseRefresh();
        if (!client.destroyed) {
          client.destroy();
        }
        await closePromise;
      }
    },
    1_000,
  );

  (isWindows ? test.skip : test)(
    "bounds shutdown while an in-flight request does not settle",
    async () => {
      let releaseRefresh: () => void;
      const refreshComplete = new Promise<number>((resolve) => {
        releaseRefresh = () => {
          resolve(0);
        };
      });
      let signalRefreshStarted: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        signalRefreshStarted = resolve;
      });

      await server.close();
      timer = new FakeTimer();
      server = new UnixSocketServer(
        socketPath,
        "http://localhost:0/mcp",
        createFakeDaemonState(async () => {
          signalRefreshStarted();
          return refreshComplete;
        }),
        timer,
      );
      await server.start();

      const client = await connectClient(socketPath);
      const clientClosed = once(client, "close");
      client.write(
        `${JSON.stringify({ id: "refresh", type: "mcp_request", method: "daemon/refreshDevices" })}\n`,
      );
      await requestStarted;

      const closePromise = server.close();
      try {
        await clientClosed;
        await Promise.resolve();
        expect(timer.getPendingTimeoutCount()).toBe(1);

        timer.advanceTime(1_000);
        await closePromise;
      } finally {
        releaseRefresh();
        if (!client.destroyed) {
          client.destroy();
        }
        await closePromise;
      }
    },
    1_000,
  );
});

async function connectClient(socketPath: string): Promise<Socket> {
  const client = createConnection(socketPath);
  await once(client, "connect");
  return client;
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
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
