import type { ChildProcess } from "node:child_process";
import { DaemonManager } from "../../src/daemon/manager";
import { FakeDaemonSpawner } from "./FakeDaemonSpawner";
import { FakeTimer } from "./FakeTimer";

/** Real manager behavior, with fake process I/O as the unit-test default. */
export class SafeDaemonManager extends DaemonManager {
  readonly defaultSpawner: FakeDaemonSpawner;
  readonly defaultSignals: Array<{ pid: number; signal: NodeJS.Signals }>;

  constructor(...args: ConstructorParameters<typeof DaemonManager>) {
    const spawner = new FakeDaemonSpawner();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    args[2] ??= new FakeTimer();
    args[6] ??= {
      findDaemonProcesses: () => [],
      // Lock ownership still needs to recognize this test process.
      isProcessRunning: (pid) => pid === process.pid,
    };
    args[7] ??= {
      // The manager's legacy spawner seam uses ChildProcess; the launcher only
      // consumes the process interface implemented by FakeDaemonProcess.
      spawn: (...spawnArgs) => spawner.spawn(...spawnArgs) as unknown as ChildProcess,
    };
    args[10] ??= {
      signal: (pid, signal) => {
        signals.push({ pid, signal });
      },
    };
    super(...args);
    this.defaultSpawner = spawner;
    this.defaultSignals = signals;
  }
}
