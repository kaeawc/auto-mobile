import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { LoopbackHelperProcess } from "../../src/features/audio/loopbackHelperProcess";

/**
 * A scripted audio-loopback helper. Stdin accepts one chunk per event-loop turn, like a pipe the
 * helper drains in real time, so a looping writer yields instead of spinning.
 */
export class FakeLoopbackHelperProcess extends EventEmitter implements LoopbackHelperProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Buffer[] = [];
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  stdinEnded = false;
  readonly stdin: Writable;
  /** Set by tests that deliver stderr themselves after the exit event. */
  private holdStderr = false;

  constructor(readonly args: string[]) {
    super();
    // A real process's stderr pipe ends with it, whoever emitted the exit.
    this.on("exit", () => {
      setImmediate(() => {
        if (!this.holdStderr) {
          this.stderr.end();
        }
      });
    });
    this.stdin = new Writable({
      highWaterMark: 1,
      write: (chunk: Buffer, _encoding, callback) => {
        this.written.push(chunk);
        setImmediate(callback);
      },
      final: (callback) => {
        this.stdinEnded = true;
        callback();
      },
    });
  }

  ready(deviceName = "BlackHole 2ch"): void {
    this.stderr.write(`audio-loopback-ready: ${deviceName}\n`);
  }

  warn(message: string): void {
    this.stderr.write(`audio-loopback-warning: ${message}\n`);
  }

  report(code: string, message: string): void {
    this.stderr.write(`audio-loopback-error: ${code} ${message}\n`);
  }

  /** Exits, then closes stdout a turn later, as a real process's pipes may still be draining. */
  exit(code: number | null): void {
    setImmediate(() => {
      this.emit("exit", code);
      setImmediate(() => this.stdout.end());
    });
  }

  /** Exits first, then delivers a final stderr line and closes the pipes a turn later. */
  exitThenReport(code: number | null, code2: string, message: string): void {
    this.holdStderr = true;
    setImmediate(() => {
      this.emit("exit", code);
      setImmediate(() => {
        this.stderr.write(`audio-loopback-error: ${code2} ${message}\n`);
        this.stderr.end();
        this.stdout.end();
      });
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.exit(null);
    return true;
  }

  writtenFrames(): number {
    return this.written.reduce((sum, chunk) => sum + chunk.byteLength, 0) / 2;
  }
}
