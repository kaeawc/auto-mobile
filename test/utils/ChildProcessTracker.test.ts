import { EventEmitter } from "node:events";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  getFileSize,
  waitForExit,
  waitForSpawn,
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
  return new Promise<void>(resolve => {
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

      // ...so advancing past the timeout fires no stray SIGKILL.
      timer.advanceTime(5000);
      expect(process.signals).toEqual(["SIGINT"]);
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
