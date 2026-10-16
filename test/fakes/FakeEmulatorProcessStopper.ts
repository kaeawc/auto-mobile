import type {
  EmulatorHostProcessRow,
  EmulatorProcessIdentity,
  EmulatorProcessSignaler,
  EmulatorProcessStopOutcome,
  EmulatorProcessStopper,
  EmulatorProcessTableSource,
} from "../../src/utils/android-cmdline-tools/EmulatorProcessStop";

export class FakeEmulatorProcessStopper implements EmulatorProcessStopper {
  readonly identifyCalls: Parameters<EmulatorProcessStopper["identify"]>[] = [];
  readonly stopCalls: Parameters<EmulatorProcessStopper["stop"]>[] = [];
  readonly describeCalls: Parameters<EmulatorProcessStopper["describeSerial"]>[] = [];
  identity: EmulatorProcessIdentity = { kind: "absent" };
  outcome: EmulatorProcessStopOutcome = { kind: "unidentified", identity: { kind: "absent" } };
  candidates: { pid: number; command: string }[] = [];
  /** When set, describeSerial reports an unreadable process table instead of `candidates`. */
  describeUnreadable?: string;
  identities: EmulatorProcessIdentity[] = [];
  outcomes: EmulatorProcessStopOutcome[] = [];
  onStop?: () => void;

  async identify(
    ...args: Parameters<EmulatorProcessStopper["identify"]>
  ): Promise<EmulatorProcessIdentity> {
    args[1].signal?.throwIfAborted();
    this.identifyCalls.push(args);
    return this.identities.shift() ?? this.identity;
  }
  async describeSerial(...args: Parameters<EmulatorProcessStopper["describeSerial"]>) {
    args[1].signal?.throwIfAborted();
    this.describeCalls.push(args);
    return this.describeUnreadable === undefined
      ? { kind: "read" as const, candidates: this.candidates }
      : { kind: "unreadable" as const, detail: this.describeUnreadable };
  }
  async stop(
    ...args: Parameters<EmulatorProcessStopper["stop"]>
  ): Promise<EmulatorProcessStopOutcome> {
    args[1].signal?.throwIfAborted();
    this.stopCalls.push(args);
    this.onStop?.();
    return this.outcomes.shift() ?? this.outcome;
  }
}

export class FakeEmulatorProcessTableSource implements EmulatorProcessTableSource {
  readonly calls: Parameters<EmulatorProcessTableSource["read"]>[0][] = [];
  results: { value?: EmulatorHostProcessRow[]; error?: string }[] = [];
  rows: EmulatorHostProcessRow[] = [];
  pending = false;
  async read(options: Parameters<EmulatorProcessTableSource["read"]>[0]) {
    options.signal?.throwIfAborted();
    this.calls.push(options);
    if (this.pending) {
      return new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    }
    return this.results.shift() ?? { value: this.rows };
  }
}

export class FakeEmulatorProcessSignaler implements EmulatorProcessSignaler {
  readonly signals: { pid: number; signal: "SIGTERM" | "SIGKILL" }[] = [];
  readonly deliveredSignals: { pid: number; signal: "SIGTERM" | "SIGKILL" }[] = [];
  readonly probes: number[] = [];
  running = true;
  exitOn: "SIGTERM" | "SIGKILL" | undefined = "SIGTERM";
  errorCode?: string;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push({ pid, signal });
    if (this.errorCode) {
      throw Object.assign(new Error(this.errorCode), { code: this.errorCode });
    }
    this.deliveredSignals.push({ pid, signal });
    if (signal === this.exitOn) {
      this.running = false;
    }
  }
  isRunning(pid: number): boolean {
    this.probes.push(pid);
    return this.running;
  }
}
