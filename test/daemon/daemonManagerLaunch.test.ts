import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { DaemonManager, type DaemonProcessSpawner } from "../../src/daemon/manager";
import { FakeTimer } from "../fakes/FakeTimer";

describe("DaemonManager launch", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("spawns detached daemon from a stable cwd instead of inheriting the spawner cwd", async () => {
    const spawnerCwd = createTempDir("daemon-spawner-cwd-");
    const stateDir = createTempDir("daemon-launch-state-");
    process.chdir(spawnerCwd);

    let capturedOptions: SpawnOptions | undefined;
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], options: SpawnOptions) => {
        capturedOptions = options;
        return {
          unref() {},
          once() { return this; },
          off() { return this; },
        } as ChildProcess;
      }
    };

    let statusCallCount = 0;
    class TestDaemonManager extends DaemonManager {
      override findAllDaemonProcesses(): number[] { return []; }
      override async status(): Promise<any> {
        statusCallCount++;
        return statusCallCount === 1
          ? { running: false }
          : { running: true, pid: 1234, port: 31847, socketPath: join(stateDir, "daemon.sock") };
      }
      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(stateDir, "daemon.lock"),
      join(stateDir, "daemon.pid"),
      join(stateDir, "daemon.sock"),
      undefined,
      processSpawner
    );

    await manager.start();

    expect(capturedOptions?.cwd).toBeString();
    expect(capturedOptions?.cwd).not.toBe(spawnerCwd);
    expect(existsSync(capturedOptions!.cwd as string)).toBe(true);
  });
});
