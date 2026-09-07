import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonSocketReachabilityLike } from "../../src/daemon/daemonSocketReachability";
import { FakeTimer } from "../fakes/FakeTimer";

const isWindows = platform() === "win32";

/**
 * The bind-guard (issue #6232): a LOCK-LESS bind — a daemon launched by hand,
 * bypassing DaemonManager's O_EXCL startup lock — must refuse to unlink a live
 * sibling's socket, while a LOCK-HELD bind keeps today's unconditional
 * stale-socket reclaim. These tests drive the injected liveness probe so the
 * live/stale decision is deterministic and needs no real socket timing.
 */
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

function reachability(result: boolean): DaemonSocketReachabilityLike {
  return { isReachable: async () => result };
}

const throwingReachability: DaemonSocketReachabilityLike = {
  isReachable: async () => {
    throw new Error("liveness probe must not run on a lock-held bind");
  },
};

function makeServer(
  socketPath: string,
  bindGuard: { startupLockHeld?: boolean; reachability?: DaemonSocketReachabilityLike },
): UnixSocketServer {
  return new UnixSocketServer(
    socketPath,
    "http://localhost:0/mcp",
    createFakeDaemonState(),
    new FakeTimer(),
    null,
    undefined,
    undefined,
    bindGuard,
  );
}

describe("UnixSocketServer bind guard (issue #6232)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  (isWindows ? test.skip : test)(
    "lock-less bind refuses a LIVE sibling socket and does not unlink it",
    async () => {
      const socketPath = join(tmpdir(), `socket-bindguard-${randomUUID()}.sock`);
      const sibling = await listenOnSocket(socketPath);
      cleanups.push(() => closeServer(sibling));

      const server = makeServer(socketPath, {
        startupLockHeld: false,
        reachability: reachability(true),
      });

      await expect(server.start()).rejects.toThrow(/Refusing to bind/);

      // The live sibling's socket must survive untouched, and still accept clients.
      expect(existsSync(socketPath)).toBe(true);
      const client = await connectClient(socketPath);
      expect(client.destroyed).toBe(false);
      client.destroy();
    },
  );

  (isWindows ? test.skip : test)(
    "lock-held bind reclaims a stale socket and binds without probing",
    async () => {
      const socketPath = join(tmpdir(), `socket-bindguard-${randomUUID()}.sock`);
      // A leftover post-crash socket file with no live listener behind it.
      writeFileSync(socketPath, "");

      const server = makeServer(socketPath, {
        startupLockHeld: true,
        reachability: throwingReachability,
      });
      cleanups.push(() => server.close());

      await server.start();

      expect(server.isListening()).toBe(true);
      const client = await connectClient(socketPath);
      expect(client.destroyed).toBe(false);
      client.destroy();
    },
  );

  (isWindows ? test.skip : test)(
    "lock-less bind reclaims a genuinely stale (dead) socket and binds",
    async () => {
      const socketPath = join(tmpdir(), `socket-bindguard-${randomUUID()}.sock`);
      writeFileSync(socketPath, "");

      const server = makeServer(socketPath, {
        startupLockHeld: false,
        reachability: reachability(false),
      });
      cleanups.push(() => server.close());

      await server.start();

      expect(server.isListening()).toBe(true);
      const client = await connectClient(socketPath);
      expect(client.destroyed).toBe(false);
      client.destroy();
    },
  );
});

async function connectClient(socketPath: string): Promise<Socket> {
  const client = createConnection(socketPath);
  await once(client, "connect");
  return client;
}

function listenOnSocket(socketPath: string): Promise<NetServer> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
