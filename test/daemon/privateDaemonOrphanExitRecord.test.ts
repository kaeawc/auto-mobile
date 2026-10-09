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

  function managerWithSocket(): { inheritOrphanExitSettings(o: object): object } {
    return new DaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(dir, "daemon.lock"),
      join(dir, "daemon.pid"),
      socketPath,
    ) as unknown as { inheritOrphanExitSettings(o: object): object };
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

  test("the replacement for an orphan-stopped daemon binds the same port strictly", () => {
    writePrivateDaemonOrphanExitRecord(socketPath, { port: 3171, exitedAtMs: 5 });

    expect(managerWithSocket().inheritOrphanExitSettings({ debug: true })).toEqual({
      debug: true,
      port: 3171,
      strictPort: true,
    });
  });

  test("an explicit port wins and still consumes the record", () => {
    writePrivateDaemonOrphanExitRecord(socketPath, { port: 3171, exitedAtMs: 5 });

    expect(managerWithSocket().inheritOrphanExitSettings({ port: 4000 })).toEqual({ port: 4000 });
    expect(existsSync(orphanExitRecordPath(socketPath))).toBe(false);
  });

  test("a start with no record keeps its own settings", () => {
    expect(managerWithSocket().inheritOrphanExitSettings({})).toEqual({});
  });
});
