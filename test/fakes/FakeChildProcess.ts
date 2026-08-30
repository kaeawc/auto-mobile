import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { defaultTimer, Timer } from "../../src/utils/SystemTimer";

/**
 * Fake ChildProcess for testing without spawning real processes
 * Simulates process lifecycle: spawn -> running -> exit
 */
export class FakeChildProcess
  extends EventEmitter
  implements Partial<ChildProcessWithoutNullStreams>
{
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid: number | undefined;

  private spawnDelay: number = 0;
  private exitDelay: number = 0;
  private shouldError = false;
  private errorMessage = "Process error";
  private stdoutData: Buffer[] = [];
  private stderrData: Buffer[] = [];
  private stdinData: Buffer[] = [];
  private stdinError: Error | null = null;

  constructor(private readonly timer: Timer = defaultTimer) {
    super();
    this.stdout = new Readable({
      read() {
        // No-op: data is pushed manually
      },
    });
    this.stderr = new Readable({
      read() {
        // No-op: data is pushed manually
      },
    });
    this.stdin = new Writable({
      write: (chunk, encoding, callback) => {
        if (this.stdinError) {
          callback(this.stdinError);
          return;
        }
        this.stdinData.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        callback();
      },
    });
  }

  private static nextPid = 1000;

  /**
   * Configure spawn behavior
   */
  setSpawnDelay(ms: number): void {
    this.spawnDelay = ms;
  }

  /**
   * Configure exit behavior
   */
  setExitDelay(ms: number): void {
    this.exitDelay = ms;
  }

  /**
   * Make the process emit an error event instead of spawning
   */
  setSpawnError(message = "Failed to spawn"): void {
    this.shouldError = true;
    this.errorMessage = message;
    this.pid = undefined;
  }

  /**
   * Add data that will be written to stdout when process starts
   */
  addStdoutData(data: Buffer | string): void {
    this.stdoutData.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  /**
   * Add data that will be written to stderr when process starts
   */
  addStderrData(data: Buffer | string): void {
    this.stderrData.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  setStdinError(message = "stdin write failed"): void {
    this.stdinError = new Error(message);
  }

  getStdinData(): Buffer {
    return Buffer.concat(this.stdinData);
  }

  /**
   * Simulate the spawn lifecycle
   */
  simulateSpawn(): void {
    this.timer.setTimeout(() => {
      if (this.shouldError) {
        this.emit("error", new Error(this.errorMessage));
        return;
      }

      // Deterministic fake pid: a fake must not reach for real randomness. A
      // process-wide counter gives every spawned process a reproducible pid.
      this.pid = FakeChildProcess.nextPid++;
      this.emit("spawn");

      // Write any configured stdout/stderr data
      for (const data of this.stdoutData) {
        this.stdout.push(data);
      }
      for (const data of this.stderrData) {
        this.stderr.push(data);
      }
    }, this.spawnDelay);
  }

  /**
   * Simulate process exit
   */
  simulateExit(code: number = 0, signal: NodeJS.Signals | null = null): void {
    this.timer.setTimeout(() => {
      this.exitCode = code;
      this.signalCode = signal;
      this.stdout.push(null); // End stdout stream
      this.stderr.push(null); // End stderr stream
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    }, this.exitDelay);
  }

  /**
   * Kill the process (simulated)
   */
  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.killed || this.exitCode !== null) {
      return false;
    }

    this.killed = true;
    const signalName = typeof signal === "number" ? null : (signal ?? "SIGTERM");

    // Simulate exit after kill
    this.simulateExit(null, signalName);
    return true;
  }

  /**
   * Ref (no-op for testing)
   */
  ref(): this {
    return this;
  }

  /**
   * Unref (no-op for testing)
   */
  unref(): this {
    return this;
  }

  /**
   * Get all other required properties from ChildProcessWithoutNullStreams
   * These are stubs for testing purposes
   */
  channel?: any;
  connected = false;
  disconnect(): void {
    this.connected = false;
  }
  send(): boolean {
    return false;
  }
}
