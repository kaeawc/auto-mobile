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

  constructor(readonly args: string[]) {
    super();
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

  report(code: string, message: string): void {
    this.stderr.write(`audio-loopback-error: ${code} ${message}\n`);
  }

  exit(code: number | null): void {
    // Stderr is delivered before exit, as a real process's buffered pipe would be.
    setImmediate(() => this.emit("exit", code));
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
