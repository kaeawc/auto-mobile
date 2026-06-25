import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonManager } from "../../src/daemon/manager";
import { READINESS_PROBE_MAX_ATTEMPTS } from "../../src/daemon/constants";
import type { DaemonClientLike } from "../../src/daemon/client";
import type { PidFileData } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

class ProbeClient implements DaemonClientLike {
  connectCallCount = 0;
  closeCallCount = 0;

  constructor(private readonly canConnect: boolean) {}

  async connect(): Promise<void> {
    this.connectCallCount++;
    if (!this.canConnect) {
      throw new Error("socket not accepting connections");
    }
  }

  async close(): Promise<void> {
    this.closeCallCount++;
  }

  async callTool(): Promise<any> {
    throw new Error("not used");
  }

  async readResource(): Promise<any> {
    throw new Error("not used");
  }

  async callDaemonMethod(): Promise<any> {
    throw new Error("not used");
  }
}

describe("DaemonManager readiness", () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  function createPaths(): { dir: string; lockPath: string; pidPath: string; socketPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-readiness-test-"));
    tempDirs.push(dir);
    return {
      dir,
      lockPath: join(dir, "daemon.lock"),
      pidPath: join(dir, "daemon.pid"),
      socketPath: join(dir, "daemon.sock"),
    };
  }

  function writePidFile(pidPath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: process.pid,
      socketPath,
      port: 31879,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidPath, JSON.stringify(pidData), { mode: 0o600 });
  }

  afterEach(async () => {
    await Promise.all(
      servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))
    );
    servers.length = 0;

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("reports ready only after the daemon socket accepts a connection", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "socket placeholder");

    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(true);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    await expect(manager.waitForReady(100)).resolves.toBe(true);
    expect(clients).toHaveLength(1);
    expect(clients[0].connectCallCount).toBe(1);
    expect(clients[0].closeCallCount).toBe(1);
    expect(existsSync(socketPath)).toBe(true);
  });

  test("removes an invalid non-socket path and keeps waiting when the PID is alive", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "stale socket placeholder");

    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(false);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    await expect(manager.waitForReady(250)).resolves.toBe(false);
    // The probe is retried before the socket is treated as dead, so a fully
    // unreachable socket is probed READINESS_PROBE_MAX_ATTEMPTS times.
    expect(clients).toHaveLength(READINESS_PROBE_MAX_ATTEMPTS);
    expect(clients[0].connectCallCount).toBe(1);
    expect(clients[0].closeCallCount).toBe(1);
    expect(existsSync(socketPath)).toBe(false);
  });

  // A daemon killed with SIGKILL leaves its Unix socket pathname behind as a
  // socket inode. If the PID is later reused, status() reports running, but the
  // readiness probe still cannot connect. The stale socket inode must be removed
  // so the loop does not spin until timeout (and so a fresh daemon can bind it).
  // Gated off Windows: net.Server.listen(path) there means a named pipe, not a
  // filesystem socket inode, so a real socket inode cannot be created this way.
  test.skipIf(process.platform === "win32")(
    "removes a stale socket inode when the readiness probe cannot connect",
    async () => {
      const { lockPath, pidPath, socketPath } = createPaths();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const clients: ProbeClient[] = [];
      writePidFile(pidPath, socketPath);

      // Bind a real Unix socket so the path is a genuine socket inode (the case
      // the previous isSocket() guard wrongly preserved). The probe still fails
      // because it cannot complete the daemon handshake, so the inode is stale
      // from the client's perspective and must be removed. Left listening for
      // afterEach cleanup; closing here would unlink the inode itself.
      const server = createServer();
      servers.push(server);
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      expect(existsSync(socketPath)).toBe(true);

      const manager = new DaemonManager(
        () => {
          const client = new ProbeClient(false);
          clients.push(client);
          return client;
        },
        undefined,
        fakeTimer,
        lockPath,
        pidPath,
        socketPath
      );

      await expect(manager.waitForReady(250)).resolves.toBe(false);
      expect(clients).toHaveLength(READINESS_PROBE_MAX_ATTEMPTS);
      expect(clients[0].connectCallCount).toBe(1);
      expect(clients[0].closeCallCount).toBe(1);
      expect(existsSync(socketPath)).toBe(false);
    }
  );

  // Regression guard for "devices not found after daemon start/restart": a LIVE
  // daemon can transiently refuse the readiness probe (backlog overflow, slow
  // first accept after a restart). The probe must retry and recover instead of
  // unlinking the healthy daemon's socket — otherwise every later client connect
  // throws "Daemon socket not found" and all device calls fail.
  test("recovers on a later retry without removing a live daemon's socket", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "socket placeholder");

    // Fail the first attempts, then accept — simulating a transient blip.
    let attempt = 0;
    const manager = new DaemonManager(
      () => {
        attempt++;
        const client = new ProbeClient(attempt >= READINESS_PROBE_MAX_ATTEMPTS);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    await expect(manager.waitForReady(1000)).resolves.toBe(true);
    expect(clients).toHaveLength(READINESS_PROBE_MAX_ATTEMPTS);
    // The socket of a daemon that recovered must be preserved.
    expect(existsSync(socketPath)).toBe(true);
  });
});
