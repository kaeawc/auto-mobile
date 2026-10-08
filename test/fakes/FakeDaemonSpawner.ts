import type { SpawnOptions } from "node:child_process";
import { writeSync } from "node:fs";
import type { DaemonProcessSpawner } from "../../src/daemon/DaemonLauncher";
import { FakeDaemonProcess } from "./FakeDaemonProcess";

export class FakeDaemonSpawner implements DaemonProcessSpawner {
  readonly calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  readonly spawned = this.calls;
  readonly process: FakeDaemonProcess;
  logText = "";
  onSpawn?: (process: FakeDaemonProcess) => void;

  constructor(exitOnKill = false) {
    this.process = new FakeDaemonProcess(exitOnKill);
  }

  spawn(command: string, args: string[], options: SpawnOptions): FakeDaemonProcess {
    this.calls.push({ command, args, options });
    const logFd =
      Array.isArray(options.stdio) && typeof options.stdio[1] === "number"
        ? options.stdio[1]
        : undefined;
    if (logFd !== undefined && this.logText.length > 0) {
      writeSync(logFd, this.logText);
    }
    if (this.onSpawn) {
      // After the caller wires its listeners, but before an auto-advanced FakeTimer
      // fires its next deadline: the pump lets nextTicks land first, while a
      // setImmediate would always lose to a pending startup timeout.
      queueMicrotask(() => process.nextTick(() => this.onSpawn?.(this.process)));
    }
    return this.process;
  }
}
