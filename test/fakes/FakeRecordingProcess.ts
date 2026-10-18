import { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";

/** How a kill request ends the process: the `exit` event arguments, or undefined to ignore it. */
export type RecordingProcessExit = { code: number | null; signal: NodeJS.Signals | number | null };

export interface FakeRecordingProcessOptions {
  /** The stream a test writes `simctl`/ffmpeg stderr output into. */
  stderr?: PassThrough;
  pid?: number;
  /** Called on every `kill()`; return an exit to emit `exit` then `close` on a microtask. */
  onKill?: (signal?: NodeJS.Signals | number) => RecordingProcessExit | undefined;
}

/**
 * A `ChildProcess` that never spawns: stderr is a test-owned stream, stdout/stdin are absent
 * (the `simctl io recordVideo` stdio shape), and `kill()` is scripted per test.
 */
export class FakeRecordingProcess extends ChildProcess {
  override stderr: Readable;
  override stdout: Readable | null = null;
  override stdin: null = null;
  override killed = false;
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  override pid: number | undefined;

  constructor(private readonly options: FakeRecordingProcessOptions = {}) {
    super();
    this.stderr = options.stderr ?? new PassThrough();
    this.pid = options.pid;
  }

  /** Records the exit code a test wants visible to `exitCode` readers. */
  setExitCode(code: number): void {
    this.exitCode = code;
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    const exit = this.options.onKill?.(signal);
    if (exit) {
      this.killed = true;
      queueMicrotask(() => {
        this.emit("exit", exit.code, exit.signal);
        this.emit("close");
      });
    }
    return true;
  }
}
