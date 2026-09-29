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
      setImmediate(() => this.onSpawn!(this.process));
    }
    return this.process;
  }
}
