import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonManager } from "../../src/daemon/manager";
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
    expect(clients).toHaveLength(1);
    expect(clients[0].connectCallCount).toBe(1);
    expect(clients[0].closeCallCount).toBe(1);
    expect(existsSync(socketPath)).toBe(false);
  });

  test("does not remove a socket path when a readiness probe fails", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    writePidFile(pidPath, socketPath);

    const server = createServer();
    servers.push(server);
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

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
    expect(clients).toHaveLength(3);
    expect(existsSync(socketPath)).toBe(true);
  });
});
