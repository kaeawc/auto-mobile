import { describe, expect, test, spyOn } from "bun:test";
import fs, { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stream that constructs successfully but can be made to fail later, the
 * way a real fd surfaces EACCES/ENOSPC asynchronously after open(). */
class AsyncFailStream extends EventEmitter {
  destroyed = false;
  writable = true;

  write(_chunk: unknown, callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => callback?.(null));
    return true;
  }

  end(callback?: () => void): void {
    queueMicrotask(() => {
      callback?.();
      // Model the fd release so closeLogStream (which awaits `close`, not the
      // end callback) resolves on a clean close — issue #6149.
      this.emit("close");
    });
  }
}

/** A stream whose close is driven manually by the test, so ordering between
 * "old stream asked to close" and "replacement stream constructed" can be
 * asserted deterministically instead of racing real fs/epoll timing.
 * `finish` (writable drained) and `close` (fd released) are modelled
 * separately, since closeLogStream must wait for the latter (issue #6149). */
class ControllableStream extends EventEmitter {
  destroyed = false;
  writable = true;
  ended = false;
  readonly writes: string[] = [];
  private endCallback: (() => void) | undefined;

  write(chunk: unknown, callback?: (error: Error | null) => void): boolean {
    this.writes.push(String(chunk));
    queueMicrotask(() => callback?.(null));
    return true;
  }

  end(callback?: () => void): void {
    this.ended = true;
    this.endCallback = callback;
  }

  /** Simulates the stream's fd having actually finished closing: writable
   * completion (`finish`, plus any end callback) followed by fd release
   * (`close`), which is what closeLogStream actually awaits. */
  finishClose(): void {
    const callback = this.endCallback;
    this.endCallback = undefined;
    callback?.();
    this.emit("finish");
    this.emit("close");
  }
}

// Seeds a log file past the rotation threshold without paying for 11MiB of
// real writes. A sparse file (grown via ftruncate rather than write) reports
// the same `stat().size` the rotation check reads, but the filesystem never
// allocates the backing pages — keeping these otherwise real-fs rotation
// tests within the repo's 100ms unit-test ceiling.
const seedOversizedLogFile = (targetPath: string, size: number): void => {
  const fd = fs.openSync(targetPath, "w");
  try {
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
};

let importCounter = 0;

async function loggerWithEnv(
  format: string | undefined,
  sink: string | undefined,
  logDir?: string,
): Promise<typeof import("../../src/utils/logger")> {
  const previousFormat = process.env.AUTOMOBILE_LOG_FORMAT;
  const previousSink = process.env.AUTOMOBILE_LOG_SINK;
  const previousLogDir = process.env.AUTOMOBILE_LOG_DIR;
  if (format === undefined) {
    delete process.env.AUTOMOBILE_LOG_FORMAT;
  } else {
    process.env.AUTOMOBILE_LOG_FORMAT = format;
  }
  if (sink === undefined) {
    delete process.env.AUTOMOBILE_LOG_SINK;
  } else {
    process.env.AUTOMOBILE_LOG_SINK = sink;
  }
  if (logDir === undefined) {
    delete process.env.AUTOMOBILE_LOG_DIR;
  } else {
    process.env.AUTOMOBILE_LOG_DIR = logDir;
  }
  try {
    return await import(`../../src/utils/logger.ts?sink-degradation-${importCounter++}`);
  } finally {
    if (previousFormat === undefined) {
      delete process.env.AUTOMOBILE_LOG_FORMAT;
    } else {
      process.env.AUTOMOBILE_LOG_FORMAT = previousFormat;
    }
    if (previousSink === undefined) {
      delete process.env.AUTOMOBILE_LOG_SINK;
    } else {
      process.env.AUTOMOBILE_LOG_SINK = previousSink;
    }
    if (previousLogDir === undefined) {
      delete process.env.AUTOMOBILE_LOG_DIR;
    } else {
      process.env.AUTOMOBILE_LOG_DIR = previousLogDir;
    }
  }
}

/**
 * `writeEmergencyLog` re-reads `AUTOMOBILE_LOG_FORMAT` from the live
 * environment on every call rather than a module-cached value, so a
 * diagnostic emitted *after* `loggerWithEnv`'s import has returned (and
 * already restored the env) would otherwise see the pre-test format. Restore
 * the env for the duration of `fn`, matching what the running process would
 * actually have configured.
 */
function withRestoredEnv<T>(format: string, sink: string, fn: () => T): T {
  const previousFormat = process.env.AUTOMOBILE_LOG_FORMAT;
  const previousSink = process.env.AUTOMOBILE_LOG_SINK;
  process.env.AUTOMOBILE_LOG_FORMAT = format;
  process.env.AUTOMOBILE_LOG_SINK = sink;
  try {
    return fn();
  } finally {
    if (previousFormat === undefined) {
      delete process.env.AUTOMOBILE_LOG_FORMAT;
    } else {
      process.env.AUTOMOBILE_LOG_FORMAT = previousFormat;
    }
    if (previousSink === undefined) {
      delete process.env.AUTOMOBILE_LOG_SINK;
    } else {
      process.env.AUTOMOBILE_LOG_SINK = previousSink;
    }
  }
}

function spyStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((
    chunk: unknown,
    callback?: (error?: Error | null) => void,
  ) => {
    lines.push(String(chunk));
    queueMicrotask(() => callback?.());
    return true;
  }) as typeof process.stderr.write);
  return { lines, restore: () => spy.mockRestore() };
}

describe("logger sink degradation on open failure (#6179)", () => {
  test("does not silently discard logs after the default file sink fails to open", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-open-fail-"));
    const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
      throw new Error("EEXIST: epoll_ctl race");
    });
    const stderr = spyStderr();

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      // Module load already hit the open-failure diagnostic; clear it so we can
      // isolate the assertion to what a subsequent ordinary log record does.
      stderr.lines.length = 0;

      mod.logger.info("should not be lost");
      await mod.logger.flush();
    } finally {
      stderr.restore();
      createWriteStream.mockRestore();
      await mod?.logger.closeAfterFlush();
      rmSync(logDir, { recursive: true, force: true });
    }

    // The record must reach a sink (degraded to stderr) rather than vanish —
    // the file sink stays unavailable for the whole test because
    // createWriteStream keeps throwing on every retry attempt.
    expect(stderr.lines.some((line) => line.includes("should not be lost"))).toBeTrue();
  });

  test("recovers file logging once a transient open failure clears", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-open-recover-"));
    const createWriteStream = spyOn(fs, "createWriteStream");
    createWriteStream.mockImplementationOnce(() => {
      throw new Error("EEXIST: epoll_ctl race");
    });

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      // Module load's open attempt failed; the next write should retry and,
      // since the mock now delegates to the real implementation, succeed.
      mod.logger.info("recovered after retry");
      await mod.logger.flush();
      await mod.logger.closeAfterFlush();

      const files = fs.readdirSync(logDir);
      expect(files.length).toBeGreaterThan(0);
      const contents = fs.readFileSync(join(logDir, files[0]), "utf-8");
      expect(contents).toContain("recovered after retry");
    } finally {
      createWriteStream.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("open-failure diagnostic stays valid NDJSON in json+both mode", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-open-fail-json-"));
    const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
      throw new Error("EEXIST: epoll_ctl race");
    });
    const stderr = spyStderr();

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("json", "both", logDir);
    } finally {
      stderr.restore();
      createWriteStream.mockRestore();
      await mod?.logger.closeAfterFlush();
      rmSync(logDir, { recursive: true, force: true });
    }

    expect(stderr.lines.length).toBeGreaterThan(0);
    for (const line of stderr.lines) {
      // Every stderr line must parse as JSON — a raw-text diagnostic would
      // break collectors that parse each line as an independent NDJSON record.
      const record = JSON.parse(line);
      expect(typeof record).toBe("object");
    }
    expect(
      stderr.lines.some((line) => {
        const record = JSON.parse(line);
        return (
          record.event === "log.emergency" &&
          String(record.message).includes("Failed to open log stream")
        );
      }),
    ).toBeTrue();
  });
});

describe("logger sink degradation on async stream error (Codex P1 on #6210)", () => {
  test("an async 'error' after successful open does not crash, and degrades subsequent logs to stderr", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-async-error-"));
    let opened: AsyncFailStream | undefined;
    const createWriteStream = spyOn(fs, "createWriteStream");
    createWriteStream.mockImplementationOnce(() => {
      opened = new AsyncFailStream();
      return opened as unknown as fs.WriteStream;
    });
    createWriteStream.mockImplementation(() => {
      // The stream stays broken after the async failure: every retry also fails.
      throw new Error("EACCES: still unavailable");
    });
    const stderr = spyStderr();

    let mod: typeof import("../../src/utils/logger") | undefined;
    let emitThrew = false;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      expect(opened).toBeDefined();

      // Emitting 'error' with no listener would throw synchronously and crash
      // the process. Assert it does not.
      try {
        opened?.emit("error", new Error("EACCES: async open failure"));
      } catch {
        emitThrew = true;
      }

      // The diagnostic from the async error is not what we're asserting on
      // here; isolate the next write.
      stderr.lines.length = 0;
      mod.logger.info("after async stream error");
      await mod.logger.flush();
    } finally {
      stderr.restore();
      createWriteStream.mockRestore();
      await mod?.logger.closeAfterFlush();
      rmSync(logDir, { recursive: true, force: true });
    }

    expect(emitThrew).toBeFalse();
    // The broken stream must have been cleared so the next write retried (and,
    // since every retry fails here, degraded to stderr) instead of silently
    // dropping the record.
    expect(stderr.lines.some((line) => line.includes("after async stream error"))).toBeTrue();
  });

  test("async stream error diagnostic stays valid NDJSON in json+both mode", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-async-error-json-"));
    let opened: AsyncFailStream | undefined;
    const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
      opened = new AsyncFailStream();
      return opened as unknown as fs.WriteStream;
    });
    const stderr = spyStderr();

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("json", "both", logDir);
      expect(opened).toBeDefined();
      stderr.lines.length = 0;

      // The handler's diagnostic write goes through process.stderr.write
      // synchronously (writeEmergencyLog is sync), no need to await anything.
      // Restore the env for the duration of the emit: writeEmergencyLog reads
      // it live, and loggerWithEnv already reverted it once the import above
      // resolved, same as it would still be live in a real long-running process.
      withRestoredEnv("json", "both", () => {
        opened?.emit("error", new Error("ENOSPC: async open failure"));
      });
    } finally {
      stderr.restore();
      createWriteStream.mockRestore();
      await mod?.logger.closeAfterFlush();
      rmSync(logDir, { recursive: true, force: true });
    }

    expect(stderr.lines.length).toBeGreaterThan(0);
    for (const line of stderr.lines) {
      const record = JSON.parse(line);
      expect(typeof record).toBe("object");
    }
    expect(
      stderr.lines.some((line) => {
        const record = JSON.parse(line);
        return (
          record.event === "log.emergency" && String(record.message).includes("Log stream error")
        );
      }),
    ).toBeTrue();
  });
});

describe("logger degrades the record itself under a persistent write failure (Codex P2 on #6210)", () => {
  test("every ordinary record reaches stderr — not just the emergency diagnostic — when the log target is a directory (EISDIR on every write)", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-eisdir-"));
    // Reproduce the reviewer's exact repro without mocking fs at all: the
    // resolved log file path IS a directory, so every real open/write against
    // it fails with a genuine EISDIR — asynchronously, matching real EACCES/
    // ENOSPC failures rather than a synchronous constructor throw.
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    mkdirSync(targetLogFile);
    const stderr = spyStderr();

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      stderr.lines.length = 0;

      // Repeated writes: the no-silent-loss guarantee must hold for every
      // record, not just the first one after the failure is discovered.
      mod.logger.info("first record");
      await mod.logger.flush();
      mod.logger.info("second record");
      await mod.logger.flush();
      mod.logger.info("third record");
      await mod.logger.flush();
    } finally {
      stderr.restore();
      await mod?.logger.closeAfterFlush();
      rmSync(logDir, { recursive: true, force: true });
    }

    // Each actual log line must degrade to stderr, not just an emergency
    // diagnostic (`log.emergency`/"Log stream error") that says something
    // failed without preserving what was actually logged.
    expect(stderr.lines.some((line) => line.includes("first record"))).toBeTrue();
    expect(stderr.lines.some((line) => line.includes("second record"))).toBeTrue();
    expect(stderr.lines.some((line) => line.includes("third record"))).toBeTrue();
  });

  test("does not double-emit the same record to stderr in `both` mode when the file write also fails", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-eisdir-both-"));
    // Drive callback + error delivery deterministically. Real Windows EISDIR
    // may arrive during teardown, making this assertion about OS event timing.
    const stream = new AsyncFailStream();
    const failedWrite = spyOn(stream, "write").mockImplementation((_chunk, callback) => {
      queueMicrotask(() => {
        const error = new Error("EISDIR: write failed");
        callback?.(error);
        stream.emit("error", error);
      });
      return true;
    });
    const createWriteStream = spyOn(fs, "createWriteStream").mockReturnValue(
      stream as unknown as fs.WriteStream,
    );
    const stderr = spyStderr();

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "both", logDir);
      stderr.lines.length = 0;

      mod.logger.info("both-mode record");
      await mod.logger.flush();
    } finally {
      await mod?.logger.closeAfterFlush();
      stderr.restore();
      createWriteStream.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }

    // `both` already emits every record via writeToConfiguredStderr regardless
    // of file-sink health; the failed file write must not additionally
    // duplicate that exact line.
    expect(failedWrite).toHaveBeenCalledTimes(1);
    const matches = stderr.lines.filter((line) => line.includes("both-mode record"));
    expect(matches.length).toBe(1);
  });
});

describe("size-based rotation is not broken by the stream-error handler (Codex P2 on #6210)", () => {
  test("logging still works after a normal rotation — the freshly-opened stream survives the old stream's close", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-rotate-"));
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    // Pre-seed the target past the 10MiB rotation threshold so the very first
    // write triggers checkAndRotateLog's real rotation path (end() the old
    // stream, rename it to a backup, open a fresh stream) without having to
    // push 10MiB of traffic through the logger itself.
    seedOversizedLogFile(targetLogFile, 11 * 1024 * 1024);

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);

      mod.logger.info("first record after rotation");
      await mod.logger.flush();
      // A previous buggy 'close' handler cleared `logStream` whenever ANY
      // stream closed, including the old stream's normal post-rotation close
      // — which could race the freshly-opened replacement and silently break
      // every write after the first one. Prove a second write also lands.
      mod.logger.info("second record after rotation");
      await mod.logger.flush();
      await mod.logger.closeAfterFlush();

      const files = fs.readdirSync(logDir);
      // The pre-seeded 11MiB file must have been rotated out to a timestamped
      // backup, and a fresh (small) active log file created in its place.
      const backups = files.filter((f) => f !== `stdio-${process.pid}.log`);
      expect(backups.length).toBeGreaterThan(0);

      const activeContents = fs.readFileSync(targetLogFile, "utf-8");
      expect(activeContents).toContain("first record after rotation");
      expect(activeContents).toContain("second record after rotation");
      // The active file should be tiny — proof the writes landed in the new
      // post-rotation stream, not silently dropped nor appended to the old
      // (now-renamed) 11MiB file.
      expect(activeContents.length).toBeLessThan(1024);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("rotation waits for the old stream to fully close before reopening (#6149)", () => {
  test("does not open the replacement WriteStream until the old stream's close callback fires", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-rotate-race-"));
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    // Pre-seed the target past the rotation threshold (a real file, so
    // io.ts's directly-captured `statAsync`/`renameAsync` bindings — not
    // interceptable via spyOn, since they copy the function reference at
    // import time rather than reading it through the module object on every
    // call — see and hit the real rotation path).
    seedOversizedLogFile(targetLogFile, 11 * 1024 * 1024);

    const opened: ControllableStream[] = [];
    const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
      const stream = new ControllableStream();
      opened.push(stream);
      return stream as unknown as fs.WriteStream;
    });

    // A macrotask tick — real fs I/O (stat/rename on a local tmp file)
    // resolves via the libuv threadpool, not a bare microtask.
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      // Module load opened the stream that rotation is about to replace.
      expect(opened.length).toBe(1);
      const oldStream = opened[0];

      // ControllableStream.end() records the call but withholds its callback
      // until finishClose() is invoked — simulating the old fd's close still
      // being in flight (the real race is a Bun/epoll timing window on
      // Linux; withholding the callback here pins the same causal shape
      // deterministically). A fix that awaits a proper close (via that
      // callback, or the stream's 'close' event) before reopening the same
      // path must therefore stay pending too.
      //
      // Wait for the actual end() call event-drivenly rather than polling a
      // fixed tick count — real stat/existsSync I/O ahead of it can take
      // longer than any fixed budget under CI/parallel-shard load, and a
      // fixed budget here would make the test itself flaky.
      let endWasCalled: () => void;
      const endWasCalledPromise = new Promise<void>((resolve) => {
        endWasCalled = resolve;
      });
      const originalEnd = oldStream.end.bind(oldStream);
      oldStream.end = (callback?: () => void) => {
        endWasCalled();
        originalEnd(callback);
      };

      mod.logger.info("triggers rotation");
      const flushed = mod.logger.flush();
      let flushSettled = false;
      void flushed.then(() => {
        flushSettled = true;
      });

      await endWasCalledPromise;
      expect(oldStream.ended).toBeTrue();

      // From here on there is no more legitimate real I/O for a *fixed*
      // implementation to be doing — it is purely blocked on the close
      // callback we are withholding — so a short, fixed window is enough to
      // catch a *buggy* implementation racing ahead to reopen regardless.
      for (let i = 0; i < 20; i++) {
        await tick();
      }
      // A fix must not let rotation's replacement stream — and therefore the
      // write that depends on it — complete while the old stream's close is
      // still outstanding. Reopening the same path before the OS has
      // released the old fd is exactly what races bun's epoll registration
      // and throws EEXIST on the new WriteStream's construction (#6149).
      expect(flushSettled).toBeFalse();
      expect(opened.length).toBe(1);

      // Only once the old stream reports it has actually finished closing
      // may rotation — and the pending write — complete.
      oldStream.finishClose();
      await flushed;

      expect(flushSettled).toBeTrue();
      expect(opened.length).toBe(2);
    } finally {
      createWriteStream.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("writes are serialized across log rotation (#6149)", () => {
  test("a write arriving mid-rotation waits and lands on the NEW stream, never opening its own", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-rotate-serialize-"));
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    // Pre-seed past the 10MiB threshold so the first write triggers real
    // rotation (see the neighbouring #6149 test for why this uses a real file).
    seedOversizedLogFile(targetLogFile, 11 * 1024 * 1024);

    const opened: ControllableStream[] = [];
    const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
      const stream = new ControllableStream();
      opened.push(stream);
      return stream as unknown as fs.WriteStream;
    });

    // Real fs I/O (stat/rename on a tmp file) resolves via the libuv
    // threadpool, so drain with a macrotask tick rather than a microtask.
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      expect(opened.length).toBe(1);
      const oldStream = opened[0];

      // Observe, event-driven, when rotation asks the old stream to close —
      // real stat/existsSync I/O ahead of it can outlast any fixed tick budget.
      let endWasCalled: () => void;
      const endWasCalledPromise = new Promise<void>((resolve) => {
        endWasCalled = resolve;
      });
      const originalEnd = oldStream.end.bind(oldStream);
      oldStream.end = (callback?: () => void) => {
        endWasCalled();
        originalEnd(callback);
      };

      // Record A triggers rotation; its close is withheld (finishClose deferred),
      // pinning rotation mid-flight with `logStream` cleared.
      mod.logger.info("record A triggers rotation");
      const flushA = mod.logger.flush();

      await endWasCalledPromise;
      expect(oldStream.ended).toBeTrue();
      expect(opened.length).toBe(1);

      // Record B arrives while rotation is still blocked on the withheld close.
      // It must NOT open its own stream at the same path — it must wait.
      mod.logger.info("record B mid-rotation");
      const flushB = mod.logger.flush();
      let flushBSettled = false;
      void flushB.then(() => {
        flushBSettled = true;
      });

      for (let i = 0; i < 20; i++) {
        await tick();
      }
      // Still blocked: no second stream opened, B parked behind rotation.
      expect(opened.length).toBe(1);
      expect(flushBSettled).toBeFalse();

      // Release the old fd's close; rotation opens exactly one replacement and
      // both records drain to it.
      oldStream.finishClose();
      await Promise.all([flushA, flushB]);

      expect(opened.length).toBe(2);
      const newStreamWrites = opened[1].writes.join("");
      expect(newStreamWrites).toContain("record A triggers rotation");
      expect(newStreamWrites).toContain("record B mid-rotation");
      // The mid-rotation record never touched the old (now-renamed) stream.
      expect(oldStream.writes.join("")).not.toContain("record B mid-rotation");
    } finally {
      createWriteStream.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("joined writers recover from a failed shared rotation (#6149)", () => {
  test("a writer waiting behind a failed rotation still reaches the replacement stream", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-rotate-join-fail-"));
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    seedOversizedLogFile(targetLogFile, 11 * 1024 * 1024);

    const opened: ControllableStream[] = [];
    const rename = spyOn(fs.promises, "rename").mockRejectedValue(
      new Error("simulated rename failure"),
    );
    const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
      const stream = new ControllableStream();
      opened.push(stream);
      // The recovery open happens after the fake rename failure. Make the next
      // size check see a normal-sized file, so this test observes the joined
      // writer's recovery rather than starting a second blocked fake rotation.
      if (opened.length === 2) {
        fs.truncateSync(targetLogFile, 0);
      }
      return stream as unknown as fs.WriteStream;
    });

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      const oldStream = opened[0];

      let endWasCalled: () => void;
      const endWasCalledPromise = new Promise<void>((resolve) => {
        endWasCalled = resolve;
      });
      const originalEnd = oldStream.end.bind(oldStream);
      oldStream.end = (callback?: () => void) => {
        endWasCalled();
        originalEnd(callback);
      };

      // A starts rotation and B joins it before the injected rename failure.
      // The fake avoids relying on filesystem permission semantics, which
      // differ for root and across host filesystems.
      mod.logger.info("record A starts failed rotation");
      await endWasCalledPromise;
      mod.logger.info("record B joined failed rotation");
      oldStream.finishClose();

      await mod.logger.flush();

      // A opens the recovery stream. B must not let the rejected joined
      // promise escape before writing: both records belong on that stream.
      expect(opened.length).toBe(2);
      const recoveredWrites = opened[1].writes.join("");
      expect(recoveredWrites).toContain("record A starts failed rotation");
      expect(recoveredWrites).toContain("record B joined failed rotation");
    } finally {
      rename.mockRestore();
      createWriteStream.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("the oversized-file check itself is serialized, not just the rotation (#6149 round 3)", () => {
  test("a second same-tick write joins the in-flight check instead of racing its own stat", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-rotate-check-lock-"));
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    seedOversizedLogFile(targetLogFile, 11 * 1024 * 1024);

    const opened: ControllableStream[] = [];
    const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
      const stream = new ControllableStream();
      opened.push(stream);
      return stream as unknown as fs.WriteStream;
    });
    // `fs.existsSync` is called through the `fs` namespace object (unlike
    // io.ts's statAsync/renameAsync, which are destructured at import time
    // and so can't be spied on), making it a reliable probe for how many
    // independent check-and-maybe-rotate cycles actually ran their own stat.
    const existsSyncSpy = spyOn(fs, "existsSync");

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv("text", "file", logDir);
      expect(opened.length).toBe(1);
      const oldStream = opened[0];
      const callsForTarget = (): number =>
        existsSyncSpy.mock.calls.filter((call) => call[0] === targetLogFile).length;

      // Fired back-to-back in the same synchronous tick, the way a caller
      // logging twice in a row actually behaves. Before this fix the size
      // check ran OUTSIDE the rotation lock (only rotateLogFile() itself was
      // guarded), so the second call could start — and this synchronous
      // assertion would catch — its own independent fs.existsSync/stat
      // before the lock was ever acquired (the TOCTOU window from #6149
      // round 3: both callers read "oversized", the first rotates and
      // clears the lock, and the second then rotates AGAIN on the
      // freshly-created small file).
      // Observe, event-driven, when rotation asks the old stream to close —
      // real stat I/O ahead of it can outlast any fixed tick budget.
      let endWasCalled: () => void;
      const endWasCalledPromise = new Promise<void>((resolve) => {
        endWasCalled = resolve;
      });
      const originalEnd = oldStream.end.bind(oldStream);
      oldStream.end = (callback?: () => void) => {
        endWasCalled();
        originalEnd(callback);
      };

      mod.logger.info("record A triggers rotation");
      mod.logger.info("record B same tick");
      expect(callsForTarget()).toBe(1);

      const flushed = mod.logger.flush();
      await endWasCalledPromise;
      oldStream.finishClose();
      await flushed;

      // Exactly one rotation cycle ran: one replacement stream, and both
      // records landed on it rather than either being lost or re-rotated.
      expect(opened.length).toBe(2);
      const newStreamWrites = opened[1].writes.join("");
      expect(newStreamWrites).toContain("record A triggers rotation");
      expect(newStreamWrites).toContain("record B same tick");
    } finally {
      existsSyncSpy.mockRestore();
      createWriteStream.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
