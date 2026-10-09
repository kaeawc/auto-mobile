import { SafeDaemonManager as DaemonManager } from "../fakes/SafeDaemonManager";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumePrivateDaemonOrphanExitRecord,
  orphanExitRecordPath,
  writePrivateDaemonOrphanExitRecord,
} from "../../src/daemon/privateDaemonOrphanExitRecord";
import { FakeTimer } from "../fakes/FakeTimer";

// #11074: a harness private daemon stopped by its orphan watchdog must not be silently replaced
// by a daemon on a different port when the next client auto-starts one.
describe("private daemon orphan exit record", () => {
  let dir: string;
  let socketPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orphan-exit-"));
    socketPath = join(dir, "daemon.sock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  type Inheriting = {
    inheritOrphanExitSettings(o: object): Promise<object>;
    portFreeProbe: (port: number) => Promise<boolean>;
  };

  function managerWithSocket(timer = new FakeTimer()): Inheriting {
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      join(dir, "daemon.lock"),
      join(dir, "daemon.pid"),
      socketPath,
    ) as unknown as Inheriting;
    manager.portFreeProbe = async () => true;
    return manager;
  }

  test("a record round-trips once and is consumed", () => {
    writePrivateDaemonOrphanExitRecord(socketPath, { port: 3171, exitedAtMs: 5 });

    expect(consumePrivateDaemonOrphanExitRecord(socketPath)).toEqual({
      port: 3171,
      exitedAtMs: 5,
    });
    expect(existsSync(orphanExitRecordPath(socketPath))).toBe(false);
    expect(consumePrivateDaemonOrphanExitRecord(socketPath)).toBeUndefined();
  });

  test("the replacement for an orphan-stopped daemon binds the same port strictly", async () => {
    writePrivateDaemonOrphanExitRecord(socketPath, { port: 3171, exitedAtMs: 5 });

    expect(await managerWithSocket().inheritOrphanExitSettings({ debug: true })).toEqual({
      debug: true,
      port: 3171,
      strictPort: true,
    });
  });

  test("an explicit port wins and still consumes the record", async () => {
    writePrivateDaemonOrphanExitRecord(socketPath, { port: 3171, exitedAtMs: 5 });

    expect(await managerWithSocket().inheritOrphanExitSettings({ port: 4000 })).toEqual({
      port: 4000,
    });
    expect(existsSync(orphanExitRecordPath(socketPath))).toBe(false);
  });

  test("a start with no record keeps its own settings", async () => {
    expect(await managerWithSocket().inheritOrphanExitSettings({})).toEqual({});
  });

  test("a record older than the TTL is ignored", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(31 * 60 * 1000);
    writePrivateDaemonOrphanExitRecord(socketPath, { port: 3171, exitedAtMs: 0 });

    expect(await managerWithSocket(timer).inheritOrphanExitSettings({ debug: true })).toEqual({
      debug: true,
    });
  });

  test("a busy inherited port falls back to non-strict binding", async () => {
    writePrivateDaemonOrphanExitRecord(socketPath, { port: 3171, exitedAtMs: 5 });
    const manager = managerWithSocket();
    manager.portFreeProbe = async () => false;

    expect(await manager.inheritOrphanExitSettings({})).toEqual({ port: 3171 });
  });
});
