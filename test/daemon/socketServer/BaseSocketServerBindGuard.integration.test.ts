import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  linkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS,
  BaseSocketServer,
} from "../../../src/daemon/socketServer/BaseSocketServer";
import type { DaemonSocketReachabilityLike } from "../../../src/daemon/client/daemonSocketReachability";
import { AuxiliarySocketHeldError } from "../../../src/daemon/AuxiliarySocketHeldError";
import { AuxiliarySocketOwner } from "../../../src/daemon/auxiliarySocketOwner";
import {
  statFileIdentity,
  type SocketFileIdentity,
  type SocketPathFs,
} from "../../../src/daemon/socketFileIdentity";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DEVICE_DATA_STREAM_SOCKET_CONFIG } from "../../../src/daemon/daemonFiles";
import { testOverrides } from "../../../src/utils/testOverrides";
import { AuxiliarySocketBindConflict } from "../../../src/daemon/auxiliarySocketAvailability";

const isWindows = platform() === "win32";

class TestServer extends BaseSocketServer {
  constructor(
    socketPath: string,
    reachability?: DaemonSocketReachabilityLike,
    owner?: AuxiliarySocketOwner,
  ) {
    super(socketPath, new FakeTimer(), "BindGuardTest", 0, {
      socketReachability: reachability,
      socketOwner: owner,
    });
  }

  protected async processLine(_socket: Socket, _line: string): Promise<void> {
    // This test only exercises the bind lifecycle.
  }
}

class WindowsStatDeniedTestServer extends TestServer {
  protected override readonly platform: NodeJS.Platform = "win32";
  protected override readonly socketPathFs: SocketPathFs = {
    exists: existsSync,
    stat: () => {
      throw Object.assign(new Error("stat denied"), { code: "EACCES" });
    },
  };
}

function listenOnSocket(socketPath: string): Promise<NetServer> {
  const peer = createServer();
  return new Promise((resolve, reject) => {
    peer.once("error", reject);
    peer.listen(socketPath, () => resolve(peer));
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("BaseSocketServer bind guard", () => {
  let directory: string;
  let server: TestServer | undefined;
  let peer: NetServer;
  let peerDirectory: string;
  let peerSocketPath: string;
  let peerIdentity: SocketFileIdentity;

  beforeAll(async () => {
    if (isWindows) {
      return;
    }
    peerDirectory = mkdtempSync(join(tmpdir(), "aux-socket-peer-"));
    peerSocketPath = join(peerDirectory, "observation-stream.sock");
    peer = await listenOnSocket(peerSocketPath);
    peerIdentity = statFileIdentity(peerSocketPath);
  });

  afterAll(async () => {
    if (peer) {
      await closeServer(peer);
      rmSync(peerDirectory, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await server?.close();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
    server = undefined;
    directory = "";
  });

  (isWindows ? test.skip : test)("preserves a path when the probe is inconclusive", async () => {
    directory = mkdtempSync(join(tmpdir(), "aux-socket-unknown-"));
    const socketPath = join(directory, "stream.sock");
    writeFileSync(socketPath, "preserve");
    server = new TestServer(socketPath, { probe: async () => "unknown" });
    const start = server.start();
    await expect(start).rejects.toBeInstanceOf(AuxiliarySocketBindConflict);
    await expect(start).rejects.toMatchObject({ reason: "unverified" });
    expect(readFileSync(socketPath, "utf8")).toBe("preserve");
    expect(server.isListening()).toBe(false);
  });

  (isWindows ? test.skip : test)("refuses to unlink a live peer socket", async () => {
    const previousDir = testOverrides.auxSocketDir;
    testOverrides.auxSocketDir = peerDirectory;
    const contestedPath = DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath;
    testOverrides.auxSocketDir = previousDir;
    expect(contestedPath).toBe(peerSocketPath);
    expect(DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath).not.toBe(contestedPath);
    server = new TestServer(contestedPath, { probe: async () => "answered" });

    const start = server.start();
    await expect(start).rejects.toBeInstanceOf(AuxiliarySocketHeldError);
    await expect(start).rejects.toThrow("BindGuardTest");
    await expect(start).rejects.toThrow(peerSocketPath);
    await expect(start).rejects.toThrow("unknown holder");

    expect(statFileIdentity(peerSocketPath)).toEqual(peerIdentity);
    expect(peer.listening).toBe(true);
  });

  (isWindows ? test.skip : test)(
    "names the verified holder and preserves the peer listener",
    async () => {
      const processes = {
        isProcessRunning: (pid: number) => pid === 741,
        readProcessGenerationToken: () => "linux:holder",
      };
      const owner = new AuxiliarySocketOwner(
        {
          read: () =>
            JSON.stringify({
              pid: 741,
              version: "0.0.old",
              socketName: "BindGuardTest",
              socketPath: peerSocketPath,
              // A record from before the exact fields: only the rounded numbers.
              dev: Number(peerIdentity.dev),
              ino: Number(peerIdentity.ino),
              processGenerationToken: "linux:holder",
            }),
          stat: () => peerIdentity,
          lstat: () => ({ isFile: () => true, size: 100 }),
          write: () => {
            throw new Error("conflict must not write");
          },
          remove: () => {
            throw new Error("conflict must not remove");
          },
          rename: () => {
            throw new Error("conflict must not rename");
          },
          link: () => {
            throw new Error("conflict must not link");
          },
          copyExclusive: () => {
            throw new Error("conflict must not copy");
          },
        },
        processes,
      );
      server = new TestServer(peerSocketPath, { probe: async () => "answered" }, owner);
      const start = server.start();
      await expect(start).rejects.toBeInstanceOf(AuxiliarySocketHeldError);
      await expect(start).rejects.toThrow("daemon pid 741 (version 0.0.old; verified)");
      await expect(start).rejects.toThrow("kill 741");
      expect(peer.listening).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "keeps listening when advisory owner publication throws",
    async () => {
      directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
      const socketPath = join(directory, "stream.sock");
      const owner = new AuxiliarySocketOwner({
        read: () => {
          throw new Error("ENOENT");
        },
        lstat: () => ({ isFile: () => true, size: 0 }),
        stat: statFileIdentity,
        remove: unlinkSync,
        rename: renameSync,
        link: linkSync,
        copyExclusive: () => {
          throw new Error("unpublished owner must not copy");
        },
        write: () => {
          throw new Error("ENOSPC");
        },
      });
      server = new TestServer(socketPath, undefined, owner);
      await expect(server.start()).resolves.toBeUndefined();
      expect(server.isListening()).toBe(true);
      expect(server.hasActiveSocketPath()).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "keeps listening with a directory at the owner sidecar path",
    async () => {
      directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
      const socketPath = join(directory, "stream.sock");
      mkdirSync(`${socketPath}.owner.json`);
      server = new TestServer(socketPath);
      await expect(server.start()).resolves.toBeUndefined();
      expect(server.isListening()).toBe(true);
      expect(server.hasActiveSocketPath()).toBe(true);
    },
  );

  (isWindows ? test.skip : test)("reclaims an unreachable path and binds", async () => {
    directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
    const socketPath = join(directory, "stream.sock");
    writeFileSync(socketPath, "stale");
    const probes: Array<{ socketPath: string; timeoutMs: number }> = [];
    const reachability: DaemonSocketReachabilityLike = {
      probe: async (path, timeoutMs) => {
        probes.push({ socketPath: path, timeoutMs });
        return "absent";
      },
    };
    server = new TestServer(socketPath, reachability);

    await server.start();

    expect(probes).toEqual([{ socketPath, timeoutMs: AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS }]);
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(server.hasActiveSocketPath()).toBe(true);
    const ownerPath = `${socketPath}.owner.json`;
    expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({
      pid: process.pid,
      socketPath,
      socketName: "BindGuardTest",
    });
    expect(statSync(ownerPath).mode & 0o777).toBe(0o600);
    await server.close();
    expect(existsSync(ownerPath)).toBe(false);
  });

  (isWindows ? test.skip : test)(
    "preserves a live socket rebound during the stale probe",
    async () => {
      directory = mkdtempSync(join(tmpdir(), "aux-socket-race-"));
      const socketPath = join(directory, "stream.sock");
      writeFileSync(socketPath, "stale");
      let racingPeer: NetServer | undefined;
      let racingIdentity: { dev: number; ino: number } | undefined;
      server = new TestServer(socketPath, {
        probe: async () => {
          // Retain the stale inode so the filesystem cannot immediately recycle it.
          renameSync(socketPath, join(directory, "old.sock"));
          racingPeer = await listenOnSocket(socketPath);
          const identity = statSync(socketPath);
          racingIdentity = { dev: identity.dev, ino: identity.ino };
          return "absent";
        },
      });

      try {
        const start = server.start();
        await expect(start).rejects.toBeInstanceOf(ActionableError);
        await expect(start).rejects.toThrow("another daemon is listening");
        const current = statSync(socketPath);
        expect<typeof racingIdentity>({ dev: current.dev, ino: current.ino }).toEqual(
          racingIdentity,
        );
        expect(racingPeer?.listening).toBe(true);
        expect(server.isListening()).toBe(false);
      } finally {
        await server.close();
        if (racingPeer) {
          await closeServer(racingPeer);
        }
      }
    },
  );

  (isWindows ? test.skip : test)("binds if the path disappears during the probe", async () => {
    directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
    const socketPath = join(directory, "stream.sock");
    writeFileSync(socketPath, "stale");
    const reachability: DaemonSocketReachabilityLike = {
      probe: async () => {
        unlinkSync(socketPath);
        return "absent";
      },
    };
    server = new TestServer(socketPath, reachability);

    await server.start();

    expect(server.hasActiveSocketPath()).toBe(true);
  });

  (isWindows ? test.skip : test)(
    "reclaims a Windows stat-denied stale path after two probes",
    async () => {
      directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
      const socketPath = join(directory, "stream.sock");
      writeFileSync(socketPath, "stale");
      const probes: Array<{ socketPath: string; timeoutMs: number }> = [];
      server = new WindowsStatDeniedTestServer(socketPath, {
        probe: async (path, timeoutMs) => {
          probes.push({ socketPath: path, timeoutMs });
          return "absent";
        },
      });

      await expect(server.start()).resolves.toBeUndefined();

      expect(probes).toEqual([
        { socketPath, timeoutMs: AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS },
        { socketPath, timeoutMs: AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS },
      ]);
      expect(statSync(socketPath).isSocket()).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "preserves a Windows stat-denied path when the second probe answers",
    async () => {
      directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
      const socketPath = join(directory, "stream.sock");
      writeFileSync(socketPath, "stale");
      let probes = 0;
      server = new WindowsStatDeniedTestServer(socketPath, {
        probe: async () => (++probes === 2 ? "answered" : "absent"),
      });

      await expect(server.start()).rejects.toBeInstanceOf(AuxiliarySocketHeldError);

      expect(probes).toBe(2);
      expect(readFileSync(socketPath, "utf8")).toBe("stale");
      expect(server.isListening()).toBe(false);
    },
  );
});
