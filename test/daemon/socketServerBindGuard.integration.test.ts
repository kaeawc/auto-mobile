import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  UnixSocketServer,
  type SocketOwnerLiveness,
  type SocketOwnerStatus,
} from "../../src/daemon/socketServer";
import type { DaemonSocketReachabilityLike } from "../../src/daemon/daemonSocketReachability";
import { FakeTimer } from "../fakes/FakeTimer";

const isWindows = platform() === "win32";

/**
 * Manager and direct launches share proof-before-unlink: an unreachable socket
 * is reclaimable only when a recorded former owner is positively dead.
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

function ownerLiveness(status: SocketOwnerStatus): SocketOwnerLiveness {
  return { getOwnerStatus: () => status };
}

const throwingOwnerLiveness: SocketOwnerLiveness = {
  getOwnerStatus: () => {
    throw new Error("owner-liveness check must not run when the socket is reachable");
  },
};

function makeServer(
  socketPath: string,
  bindGuard: {
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
    "direct bind refuses a LIVE sibling socket and does not unlink it",
    async () => {
      const socketPath = tempSocketPath();
      const sibling = await listenOnSocket(socketPath);
      cleanups.push(() => closeServer(sibling));

      const server = makeServer(socketPath, {
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
    "direct bind refuses an INCONCLUSIVE probe with a live recorded owner",
    async () => {
      const socketPath = tempSocketPath();
      // A socket file whose listener refuses the probe (accept backlog / mid-startup):
      // the probe reports NOT reachable, but a live owner is still recorded, so the
      // refusal is inconclusive and the bind must fail closed rather than unlink.
      writeFileSync(socketPath, "");

      const server = makeServer(socketPath, {
        reachability: reachability(false),
        ownerLiveness: ownerLiveness("live"),
      });

      await expect(server.start()).rejects.toThrow(/Refusing to bind/);

      // The (possibly still live) socket must survive — an inconclusive probe never
      // reclaims it.
      expect(existsSync(socketPath)).toBe(true);
      expect(server.isListening()).toBe(false);
    },
  );

  (isWindows ? test.skip : test)(
    "manager bind refuses a LIVE sibling socket and does not unlink it",
    async () => {
      const socketPath = tempSocketPath();
      const sibling = await listenOnSocket(socketPath);
      cleanups.push(() => closeServer(sibling));

      const server = makeServer(socketPath, {
        reachability: reachability(true),
        ownerLiveness: throwingOwnerLiveness,
      });

      await expect(server.start()).rejects.toThrow(/Refusing to bind/);

      expect(existsSync(socketPath)).toBe(true);
      const client = await connectClient(socketPath);
      expect(client.destroyed).toBe(false);
      client.destroy();
    },
  );

  (isWindows ? test.skip : test)(
    "bind reclaims a socket only when the recorded former owner is dead",
    async () => {
      const socketPath = tempSocketPath();
      writeFileSync(socketPath, "");

      const server = makeServer(socketPath, {
        reachability: reachability(false),
        ownerLiveness: ownerLiveness("dead"),
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
    "refuses an unreachable socket when ownership is unknown",
    async () => {
      const socketPath = tempSocketPath();
      writeFileSync(socketPath, "");
      const server = makeServer(socketPath, {
        reachability: reachability(false),
        ownerLiveness: ownerLiveness("unknown"),
      });

      await expect(server.start()).rejects.toThrow(/positively known to be dead/);
      expect(existsSync(socketPath)).toBe(true);
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
