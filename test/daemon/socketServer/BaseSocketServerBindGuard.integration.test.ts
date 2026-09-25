import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS,
  BaseSocketServer,
} from "../../../src/daemon/socketServer/BaseSocketServer";
import type { DaemonSocketReachabilityLike } from "../../../src/daemon/daemonSocketReachability";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DEVICE_DATA_STREAM_SOCKET_CONFIG } from "../../../src/daemon/daemonFiles";
import { testOverrides } from "../../../src/utils/testOverrides";

const isWindows = platform() === "win32";

class TestServer extends BaseSocketServer {
  constructor(socketPath: string, reachability?: DaemonSocketReachabilityLike) {
    super(socketPath, new FakeTimer(), "BindGuardTest", 0, reachability);
  }

  protected async processLine(_socket: Socket, _line: string): Promise<void> {
    // This test only exercises the bind lifecycle.
  }
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
  let peerIdentity: { dev: number; ino: number };

  beforeAll(async () => {
    if (isWindows) {
      return;
    }
    peerDirectory = mkdtempSync(join(tmpdir(), "aux-socket-peer-"));
    peerSocketPath = join(peerDirectory, "observation-stream.sock");
    peer = await listenOnSocket(peerSocketPath);
    const original = statSync(peerSocketPath);
    peerIdentity = { dev: original.dev, ino: original.ino };
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

  (isWindows ? test.skip : test)("refuses to unlink a live peer socket", async () => {
    const previousDir = testOverrides.auxSocketDir;
    testOverrides.auxSocketDir = peerDirectory;
    const contestedPath = DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath;
    testOverrides.auxSocketDir = previousDir;
    expect(contestedPath).toBe(peerSocketPath);
    expect(DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath).not.toBe(contestedPath);
    server = new TestServer(contestedPath, { isReachable: async () => true });

    const start = server.start();
    await expect(start).rejects.toBeInstanceOf(ActionableError);
    await expect(start).rejects.toThrow("BindGuardTest");
    await expect(start).rejects.toThrow(peerSocketPath);
    await expect(start).rejects.toThrow("--daemon restart");

    const current = statSync(peerSocketPath);
    expect({ dev: current.dev, ino: current.ino }).toEqual(peerIdentity);
    expect(peer.listening).toBe(true);
  });

  (isWindows ? test.skip : test)("reclaims an unreachable path and binds", async () => {
    directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
    const socketPath = join(directory, "stream.sock");
    writeFileSync(socketPath, "stale");
    const probes: Array<{ socketPath: string; timeoutMs: number }> = [];
    const reachability: DaemonSocketReachabilityLike = {
      isReachable: async (path, timeoutMs) => {
        probes.push({ socketPath: path, timeoutMs });
        return false;
      },
    };
    server = new TestServer(socketPath, reachability);

    await server.start();

    expect(probes).toEqual([{ socketPath, timeoutMs: AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS }]);
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(server.hasActiveSocketPath()).toBe(true);
  });

  (isWindows ? test.skip : test)("binds if the path disappears during the probe", async () => {
    directory = mkdtempSync(join(tmpdir(), "aux-socket-bind-"));
    const socketPath = join(directory, "stream.sock");
    writeFileSync(socketPath, "stale");
    const reachability: DaemonSocketReachabilityLike = {
      isReachable: async () => {
        unlinkSync(socketPath);
        return false;
      },
    };
    server = new TestServer(socketPath, reachability);

    await server.start();

    expect(server.hasActiveSocketPath()).toBe(true);
  });
});
