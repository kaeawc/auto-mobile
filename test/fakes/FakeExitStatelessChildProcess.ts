import { ChildProcess } from "node:child_process";

/**
 * A process handle that reports no exit state at all (`exitCode` and `signalCode` are
 * `undefined`, not `null`), like the minimal handles some launchers return. `ChildProcess` types
 * both as `number | null`, so the absence cannot be declared as a field; it is defined on the
 * instance, which is the only honest way to model it. Killing it records the signal and leaves it
 * "running": a caller that waits for an exit event would hang, so a test passing proves the caller
 * did not wait.
 */
export class FakeExitStatelessChildProcess extends ChildProcess {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  constructor() {
    super();
    Object.defineProperty(this, "exitCode", { value: undefined, configurable: true });
    Object.defineProperty(this, "signalCode", { value: undefined, configurable: true });
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}
