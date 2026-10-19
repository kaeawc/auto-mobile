import { DaemonManager, type DaemonManagerOptions } from "../../src/daemon/manager";
import { FakeDaemonSpawner } from "./FakeDaemonSpawner";
import { FakeTimer } from "./FakeTimer";
import type { DaemonExitRecordFileSystem } from "../../src/daemon/daemonExitRecord";

export class FakeDaemonExitRecordFileSystem implements DaemonExitRecordFileSystem {
  readonly files = new Map<string, string>();

  readFileSync(path: string, _encoding: "utf8"): string {
    const data = this.files.get(path);
    if (data === undefined) {
      throw new Error("No daemon exit record");
    }
    return data;
  }

  writeFileSync(path: string, data: string): void {
    this.files.set(path, data);
  }

  rmSync(path: string, _options: { force: true }): void {
    this.files.delete(path);
  }
}

/** Real manager behavior, with fake process I/O as the unit-test default. */
type SafeDaemonManagerContract = Pick<DaemonManager, keyof DaemonManager>;

export class SafeDaemonManager extends DaemonManager implements SafeDaemonManagerContract {
  readonly defaultSpawner: FakeDaemonSpawner;
  readonly defaultSignals: Array<{ pid: number; signal: NodeJS.Signals }>;

  constructor(options: DaemonManagerOptions = {}) {
    const spawner = new FakeDaemonSpawner();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    super({
      ...options,
      timer: options.timer ?? new FakeTimer(),
      processFinder: options.processFinder ?? {
        findDaemonProcesses: () => [],
        // Lock ownership still needs to recognize this test process.
        isProcessRunning: (pid) => pid === process.pid,
      },
      processSpawner: options.processSpawner ?? spawner,
      processSignaler: options.processSignaler ?? {
        signal: (pid, signal) => {
          signals.push({ pid, signal });
        },
      },
    });
    this.seams.exitRecordFileSystem = new FakeDaemonExitRecordFileSystem();
    this.defaultSpawner = spawner;
    this.defaultSignals = signals;
  }
}
