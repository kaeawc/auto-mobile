import { EventEmitter } from "node:events";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createExitTracker,
  getFileSize,
  waitForExit,
  waitForSpawn,
  type TrackedChildProcess,
  type StoppableProcess,
} from "../../src/utils/ChildProcessTracker";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeStoppableProcess extends EventEmitter implements StoppableProcess {
  exitCode: number | null = null;
  killed = false;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(private readonly resolveOnSignal?: NodeJS.Signals | number) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (signal === this.resolveOnSignal) {
      this.exitCode = null;
      this.killed = true;
      this.emit("exit");
    }
    return true;
  }
}

function createExitPromise(process: EventEmitter): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
  });
}

/** Mirrors createExitTracker: resolves on 'exit', rejects on the child 'error' event. */
function createExitOrErrorPromise(process: EventEmitter): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.once("exit", () => resolve());
    process.once("error", (error: Error) => reject(error));
  });
}

describe("ChildProcessTracker", () => {
  describe("createExitTracker", () => {
    test("tracks ignored-stdio processes without a stderr stream", async () => {
      const process = new EventEmitter() as TrackedChildProcess;
      process.exitCode = null;
      process.signalCode = null;
      process.killed = false;
      process.stderr = null;
      process.kill = () => true;

      const stderr: string[] = [];
      const { exitState, exitPromise } = createExitTracker(process, stderr);

      process.emit("exit", 0, null);
      await exitPromise;

      expect(stderr).toEqual([]);
      expect(exitState.exitCode).toBe(0);
      expect(exitState.signal).toBeNull();
    });
  });

  describe("waitForExit", () => {
    test("sends SIGINT first and escalates to SIGKILL after the configured timeout", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess("SIGKILL");
      const waitPromise = waitForExit(process, createExitPromise(process), {
        timeoutMs: 1234,
        timer,
      });

      expect(process.signals).toEqual(["SIGINT"]);
      expect(timer.getPendingTimeouts()).toEqual([1234]);

      timer.advanceTime(1234);
      await waitPromise;

      expect(process.signals).toEqual(["SIGINT", "SIGKILL"]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("does not escalate when the process exits before the timeout", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess();
      const waitPromise = waitForExit(process, createExitPromise(process), {
        timeoutMs: 5000,
        timer,
      });

      expect(process.signals).toEqual(["SIGINT"]);

      process.exitCode = 0;
      process.emit("exit");
      await waitPromise;

      expect(process.signals).toEqual(["SIGINT"]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("does not signal an already-exited process", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess();
      process.exitCode = 0;

      await waitForExit(process, Promise.resolve(), { timer });

      expect(process.signals).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("clears the SIGKILL timer when exitPromise rejects, leaving no stray kill (#3617)", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess();
      const waitPromise = waitForExit(process, createExitOrErrorPromise(process), {
        timeoutMs: 5000,
        timer,
      });

      expect(process.signals).toEqual(["SIGINT"]);
      expect(timer.getPendingTimeoutCount()).toBe(1);

      // The child 'error' event rejects exitPromise and unwinds the race.
      process.emit("error", new Error("spawn failed"));
      await expect(waitPromise).rejects.toThrow("spawn failed");

      // Regression (#3617): the timer must be cleared despite the reject path...
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(process.signals).toEqual(["SIGINT", "SIGKILL"]);

      // ...so advancing past the timeout fires no stray SIGKILL.
      timer.advanceTime(5000);
      expect(process.signals).toEqual(["SIGINT", "SIGKILL"]);
    });
  });

  describe("waitForExit without an initial signal", () => {
    test("waits for normal completion without sending SIGINT", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess();
      const waitPromise = waitForExit(process, createExitPromise(process), {
        timeoutMs: 60000,
        timer,
        signal: null,
      });

      expect(process.signals).toEqual([]);

      process.exitCode = 0;
      process.emit("exit");
      await waitPromise;

      expect(process.signals).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("kills a process that does not complete before timeout", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess("SIGKILL");
      const waitPromise = waitForExit(process, createExitPromise(process), {
        timeoutMs: 60000,
        timer,
        signal: null,
      });

      expect(process.signals).toEqual([]);

      timer.advanceTime(60000);
      await waitPromise;

      expect(process.signals).toEqual(["SIGKILL"]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  });

  describe("waitForSpawn", () => {
    test("resolves when the child already has a pid before listeners attach", async () => {
      const process = new EventEmitter() as EventEmitter & { pid?: number };
      process.pid = 123;

      await expect(waitForSpawn(process)).resolves.toBeUndefined();
      expect(process.listenerCount("spawn")).toBe(0);
      expect(process.listenerCount("error")).toBe(0);
    });

    test("resolves when the process emits spawn", async () => {
      const process = new EventEmitter();
      const spawnPromise = waitForSpawn(process);

      process.emit("spawn");

      await spawnPromise;
    });

    test("rejects when the process emits error before spawn", async () => {
      const process = new EventEmitter();
      const spawnPromise = waitForSpawn(process);
      const error = new Error("spawn failed");

      process.emit("error", error);

      await expect(spawnPromise).rejects.toBe(error);
    });
  });

  describe("createExitTracker stderr + signal attribution", () => {
    test("accumulates stderr chunks emitted by the tracked process", async () => {
      const process = new EventEmitter() as TrackedChildProcess;
      process.exitCode = null;
      process.signalCode = null;
      process.killed = false;
      const stderrEmitter = new EventEmitter();
      process.stderr = stderrEmitter as unknown as TrackedChildProcess["stderr"];
      process.kill = () => true;

      const stderr: string[] = [];
      const { exitPromise } = createExitTracker(process, stderr);

      stderrEmitter.emit("data", Buffer.from("boom "));
      stderrEmitter.emit("data", "second");

      process.emit("exit", 1, null);
      await exitPromise;

      // stderr must be captured so a failed capture reports why it died.
      expect(stderr).toEqual(["boom ", "second"]);
    });

    test("keeps collecting stderr after exit until the child close event", async () => {
      const process = new EventEmitter() as TrackedChildProcess;
      process.exitCode = null;
      process.signalCode = null;
      process.killed = false;
      const stderrEmitter = new EventEmitter();
      process.stderr = stderrEmitter as unknown as TrackedChildProcess["stderr"];
      process.kill = () => true;

      const stderr: string[] = [];
      const { exitPromise } = createExitTracker(process, stderr);

      process.emit("exit", 1, null);
      await exitPromise;
      stderrEmitter.emit("data", "late diagnostic");

      expect(stderr).toEqual(["late diagnostic"]);
      expect(stderrEmitter.listenerCount("data")).toBe(1);

      process.emit("close");
      stderrEmitter.emit("data", "discarded after close");
      expect(stderr).toEqual(["late diagnostic"]);
      expect(stderrEmitter.listenerCount("data")).toBe(0);
    });

    test("attributes the terminating signal when the process has already exited", async () => {
      const process = new EventEmitter() as TrackedChildProcess;
      process.exitCode = 137;
      process.signalCode = "SIGKILL";
      process.killed = true;
      process.stderr = null;
      process.kill = () => true;

      const stderr: string[] = [];
      const { exitState, exitPromise } = createExitTracker(process, stderr);
      await exitPromise;

      // A process reaped before the tracker attached still records how it died.
      expect(exitState.exitCode).toBe(137);
      expect(exitState.signal).toBe("SIGKILL");
    });
  });

  describe("waitForExit killed-but-unreaped guard", () => {
    test("escalates an already-killed process that remains unreaped", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess("SIGKILL");
      process.killed = true;
      process.exitCode = null;

      const wait = waitForExit(process, createExitPromise(process), {
        timeoutMs: 123,
        timer,
      });

      expect(process.signals).toEqual([]);
      expect(timer.getPendingTimeouts()).toEqual([123]);

      timer.advanceTime(123);
      await wait;

      expect(process.signals).toEqual(["SIGKILL"]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("bounds the final reap when SIGKILL does not terminate the process", async () => {
      const timer = new FakeTimer();
      const process = new FakeStoppableProcess();
      const wait = waitForExit(process, createExitPromise(process), {
        timeoutMs: 100,
        forceKillTimeoutMs: 50,
        timer,
      });

      timer.advanceTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(process.signals).toEqual(["SIGINT", "SIGKILL"]);
      expect(timer.getPendingTimeouts()).toEqual([50]);

      timer.advanceTime(50);
      await expect(wait).rejects.toThrow("did not exit");
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  });

  describe("getFileSize", () => {
    test("returns file size or undefined when missing", async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "child-process-tracker-"));
      const filePath = path.join(tempDir, "recording.mp4");
      try {
        expect(await getFileSize(filePath)).toBeUndefined();

        await fsPromises.writeFile(filePath, "video");

        expect(await getFileSize(filePath)).toBe(5);
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
