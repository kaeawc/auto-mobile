import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonManager } from "../../src/daemon/manager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonSpawner } from "../fakes/FakeDaemonSpawner";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { runDaemonManagerContract, type ScriptedDaemonManager } from "./DaemonManagerContract";

function scriptedFake(): ScriptedDaemonManager {
  const fake = new FakeDaemonManager();
  return {
    manager: fake,
    setDaemonRecorded: (recorded) => {
      fake.statusResult = recorded
        ? { running: true, pid: 1234, port: 3000, socketPath: "/tmp/test.sock" }
        : { running: false };
    },
    setSocketReachable: (reachable) => {
      fake.waitForReadyResult = reachable;
    },
    setStartupLockHeld: (held) => {
      fake.startupLockHeldByLiveProcess = held;
    },
    dispose: () => {},
  };
}

// The real manager runs over a temp dir and faked process, signal and socket-client
// seams: no daemon, no ~/.auto-mobile, never the resident daemon's socket.
function scriptedReal(): ScriptedDaemonManager {
  const dir = mkdtempSync(join(tmpdir(), "daemon-manager-contract-"));
  const previous = {
    data: process.env.AUTOMOBILE_DATA_DIR,
    log: process.env.AUTOMOBILE_LOG_DIR,
  };
  process.env.AUTOMOBILE_DATA_DIR = dir;
  process.env.AUTOMOBILE_LOG_DIR = join(dir, "logs");
  const lockFilePath = join(dir, "daemon.lock");
  const pidFilePath = join(dir, "daemon.pid");
  const socketPath = join(dir, "daemon.sock");
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let reachable = false;
  const spawner = new FakeDaemonSpawner();
  const build = (token: string) =>
    new DaemonManager({
      timer,
      lockFilePath,
      pidFilePath,
      socketPath,
      idGenerator: new FakeIdGenerator([token]),
      processFinder: {
        findDaemonProcesses: () => [],
        isProcessRunning: (pid) => pid === process.pid,
      },
      processSpawner: { spawn: (...args) => spawner.spawn(...args) as never },
      processSignaler: { signal: () => {} },
      clientFactory: () => {
        const client = new FakeDaemonClient();
        client.shouldFailConnect = !reachable;
        return client;
      },
    });
  const manager = build("manager-token");
  // A sibling manager in this process plays "another live process holding the lock".
  const holder = build("holder-token");
  return {
    manager,
    setDaemonRecorded: (recorded) => {
      rmSync(pidFilePath, { force: true });
      if (recorded) {
        writeFileSync(
          pidFilePath,
          JSON.stringify({ pid: process.pid, socketPath, port: 3000, startedAt: 100 }),
        );
        writeFileSync(socketPath, "");
      }
    },
    setSocketReachable: (value) => {
      reachable = value;
      if (value) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(socketPath, "");
      } else {
        rmSync(socketPath, { force: true });
      }
    },
    setStartupLockHeld: (held) => {
      if (held) {
        holder.acquireLock();
      } else {
        holder.releaseLock();
      }
    },
    dispose: () => {
      holder.releaseLock();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of [
        ["AUTOMOBILE_DATA_DIR", previous.data],
        ["AUTOMOBILE_LOG_DIR", previous.log],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

runDaemonManagerContract("FakeDaemonManager", scriptedFake);
runDaemonManagerContract("DaemonManager", scriptedReal);
