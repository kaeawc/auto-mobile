import { EventEmitter } from "node:events";
import type { DaemonLaunchedProcess } from "../../src/daemon/DaemonLauncher";

export class FakeDaemonProcess extends EventEmitter implements DaemonLaunchedProcess {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr: DaemonLaunchedProcess["stderr"] = null;
  killed = false;
  readonly signals: NodeJS.Signals[] = [];
  exitOnSignal: NodeJS.Signals | undefined;
  emitExitImmediately = true;

  constructor(private readonly exitOnKill = false) {
    super();
  }

  unref(): void {}

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.exitOnKill || (this.exitOnSignal === signal && this.emitExitImmediately)) {
      this.emitExit(signal);
    }
    return true;
  }

  emitExit(signal: NodeJS.Signals): void {
    this.exitCode = 0;
    this.signalCode = signal;
    this.emit("exit", 0, signal);
  }
}
