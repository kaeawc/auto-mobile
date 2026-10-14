import type { NativeHelperProcessControl } from "../../src/utils/nativeHelpers/NativeHelperProcessControl";

export class FakeNativeHelperProcessControl implements NativeHelperProcessControl {
  readonly processes = new Map<number, string | undefined>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals; group: boolean }> = [];
  onSignal?: (pid: number, signal: NodeJS.Signals) => void;
  isRunning(pid: number): boolean {
    return this.processes.has(pid);
  }
  readStartIdentity(pid: number): string | undefined {
    return this.processes.get(pid);
  }
  signal(pid: number, signal: NodeJS.Signals, options: { group: boolean }): void {
    this.signals.push({ pid, signal, group: options.group });
    this.onSignal?.(pid, signal);
  }
}
