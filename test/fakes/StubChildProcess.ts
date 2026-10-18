import { ChildProcess } from "node:child_process";

export interface StubChildProcessOptions {
  pid?: number;
  /** Invoked by kill(); its return value is kill()'s result, and true also emits `exit`. Defaults to a no-op returning false. */
  onKill?: () => boolean;
}

/**
 * A real (never spawned) ChildProcess with a configurable pid and kill(), so tests
 * can hand a ChildProcess to code under test without casting a partial object.
 */
export class StubChildProcess extends ChildProcess {
  override pid: number | undefined;
  private readonly onKill: () => boolean;

  constructor({ pid = 12345, onKill = () => false }: StubChildProcessOptions = {}) {
    super();
    this.pid = pid;
    this.onKill = onKill;
  }

  /** A kill that onKill reports as delivered makes the process exit, as a real signal would. */
  override kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    const delivered = this.onKill();
    if (delivered) {
      this.emit("exit", null, signal);
    }
    return delivered;
  }
}
