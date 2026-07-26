import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { AdbProcess } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

/**
 * Controllable fake for a long-lived ADB process returned by {@link AdbExecutor.spawn}.
 * Satisfies the narrow {@link AdbProcess} surface (stdin/stdout/stderr, exit code,
 * kill, and the `once`/`on`/`off`/`removeListener` event methods) without spawning
 * a real process. Tests configure how the process terminates and the fake emits
 * the corresponding `exit` / `error` event after the caller has attached its
 * listeners (via `setImmediate`, so a `once("exit")` registered right after the
 * spawn resolves is guaranteed to observe the event).
 */
export class FakeAdbProcess extends EventEmitter implements AdbProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor() {
    super();
    this.stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.signalCode = typeof signal === "number" ? null : (signal ?? "SIGTERM");
    return true;
  }

  /** Schedule a clean/failed exit that fires once the caller's listeners attach. */
  scheduleExit(code: number, signal: NodeJS.Signals | null = null): void {
    setImmediate(() => {
      this.exitCode = code;
      this.signalCode = signal;
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit("exit", code, signal);
    });
  }

  /** Schedule an error event (e.g. adb binary missing) after listeners attach. */
  scheduleError(error: Error): void {
    setImmediate(() => this.emit("error", error));
  }
}
