import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer, type SocketOwnerLiveness } from "../../src/daemon/socketServer";
import type { DaemonSocketReachabilityLike } from "../../src/daemon/daemonSocketReachability";
import { FakeTimer } from "../fakes/FakeTimer";

const isWindows = platform() === "win32";

/**
 * The bind-guard (issue #6232): a LOCK-LESS bind — a daemon launched by hand,
 * bypassing DaemonManager's O_EXCL startup lock — must refuse to unlink a live
 * sibling's socket, while a LOCK-HELD bind keeps today's unconditional
 * stale-socket reclaim. A NOT-reachable probe is treated as INCONCLUSIVE (fail
 * closed) unless no live owner is recorded. These tests drive the injected
 * liveness probe and owner-liveness check so the live/stale/inconclusive decision
 * is deterministic and needs no real socket timing.
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

function ownerLiveness(hasLiveForeignOwner: boolean): SocketOwnerLiveness {
  return { hasLiveForeignOwner: () => hasLiveForeignOwner };
}

const throwingReachability: DaemonSocketReachabilityLike = {
  isReachable: async () => {
    throw new Error("liveness probe must not run on a lock-held bind");
  },
};

const throwingOwnerLiveness: SocketOwnerLiveness = {
  hasLiveForeignOwner: () => {
    throw new Error("owner-liveness check must not run on a lock-held bind");
  },
};

function makeServer(
  socketPath: string,
  bindGuard: {
    startupLockHeld?: boolean;
    reachability?: DaemonSocketReachabilityLike;
    ownerLiveness?: SocketOwnerLiveness;
  },
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
  const tempDirs: string[] = [];

  function tempSocketPath(): string {
    // A secure, unique per-test directory (not a predictable os.tmpdir() path)
    // holds the socket, avoiding insecure-temp-file creation (CodeQL).
    const dir = mkdtempSync(join(tmpdir(), "socket-bindguard-"));
    tempDirs.push(dir);
    return join(dir, "daemon.sock");
  }

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  (isWindows ? test.skip : test)(
    "lock-less bind refuses a LIVE sibling socket and does not unlink it",
    async () => {
      const socketPath = tempSocketPath();
      const sibling = await listenOnSocket(socketPath);
      cleanups.push(() => closeServer(sibling));

      const server = makeServer(socketPath, {
        startupLockHeld: false,
        reachability: reachability(true),
        // The reachable branch decides on its own; owner-liveness must not be needed.
        ownerLiveness: throwingOwnerLiveness,
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
    "lock-less bind refuses an INCONCLUSIVE probe (a live owner is still recorded) and does not unlink it",
    async () => {
      const socketPath = tempSocketPath();
      // A socket file whose listener refuses the probe (accept backlog / mid-startup):
      // the probe reports NOT reachable, but a live owner is still recorded, so the
      // refusal is inconclusive and the bind must fail closed rather than unlink.
      writeFileSync(socketPath, "");

      const server = makeServer(socketPath, {
        startupLockHeld: false,
        reachability: reachability(false),
        ownerLiveness: ownerLiveness(true),
      });

      await expect(server.start()).rejects.toThrow(/Refusing to bind/);

      // The (possibly still live) socket must survive — an inconclusive probe never
      // reclaims it.
      expect(existsSync(socketPath)).toBe(true);
      expect(server.isListening()).toBe(false);
    },
  );

  (isWindows ? test.skip : test)(
    "lock-held bind reclaims a stale socket and binds without probing",
    async () => {
      const socketPath = tempSocketPath();
      // A leftover post-crash socket file with no live listener behind it.
      writeFileSync(socketPath, "");

      const server = makeServer(socketPath, {
        startupLockHeld: true,
        reachability: throwingReachability,
        ownerLiveness: throwingOwnerLiveness,
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
      const socketPath = tempSocketPath();
      writeFileSync(socketPath, "");

      const server = makeServer(socketPath, {
        startupLockHeld: false,
        reachability: reachability(false),
        // No live owner recorded: the socket is confidently dead and reclaimable.
        ownerLiveness: ownerLiveness(false),
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
