import { describe, expect, test, spyOn } from "bun:test";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

let importCounter = 0;

class FailingLogStream extends EventEmitter {
  destroyed = false;
  writable = true;

  write(_chunk: unknown, callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => callback?.(new Error("ENOSPC")));
    return false;
  }
}

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
    return await import(`../../src/utils/logger.ts?structured-${importCounter++}`);
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

describe("structured logging", () => {
  test("emits standalone redacted JSON records to stderr without stdout output", async () => {
    const mod = await loggerWithEnv("json", "stderr");
    const stderr: string[] = [];
    const stdout: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      stderr.push(String(chunk));
      queueMicrotask(() => callback?.());
      return true;
    }) as typeof process.stderr.write);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      stdout.push(String(chunk));
      queueMicrotask(() => callback?.());
      return true;
    }) as typeof process.stdout.write);

    try {
      mod.logger.info("started\nwith unsafe text", {
        session_id: "safe",
        TOKEN: "redact-me",
      });
      mod.logger.enableStdoutLogging();
      await mod.logger.flush();
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      await mod.logger.closeAfterFlush();
    }

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    const record = JSON.parse(stderr[0]);
    const message = record.message;
    expect(record).toMatchObject({
      level: "info",
      component: expect.any(String),
      event: "log",
      message: expect.stringContaining("started with unsafe text"),
    });
    expect(typeof message).toBe("string");
    expect(!String(message).includes("redact-me")).toBeTrue();
  });

  test("parses supported format and sink values", async () => {
    const mod = await loggerWithEnv(undefined, undefined);
    expect(mod.parseAutomobileLogFormat("JSON")).toBe("json");
    expect(mod.parseAutomobileLogFormat("xml")).toBeNull();
    expect(mod.parseAutomobileLogSink("BOTH")).toBe("both");
    expect(mod.parseAutomobileLogSink("console")).toBeNull();
    await mod.logger.closeAfterFlush();
  });

  test("preserves text/file defaults", async () => {
    const mod = await loggerWithEnv(undefined, undefined);
    expect(mod.resolveAutomobileLogFormat({})).toBe("text");
    expect(mod.resolveAutomobileLogSink({})).toBe("file");
    await mod.logger.closeAfterFlush();
  });

  test("does not initialize a file sink for stderr-only logging", async () => {
    const root = mkdtempSync(join(tmpdir(), "am-logger-stderr-"));
    const unusableLogDir = join(root, "not-a-directory");
    writeFileSync(unusableLogDir, "not a directory");
    const mod = await loggerWithEnv("json", "stderr", unusableLogDir);
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      stderr.push(String(chunk));
      queueMicrotask(() => callback?.());
      return true;
    }) as typeof process.stderr.write);

    try {
      mod.logger.info("container-ready");
      await mod.logger.flush();
    } finally {
      stderrSpy.mockRestore();
      await mod.logger.closeAfterFlush();
      rmSync(root, { recursive: true, force: true });
    }

    expect(JSON.parse(stderr[0])).toMatchObject({ message: "container-ready" });
  });

  test("keeps the stderr record when the file sink fails in both mode", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-both-"));
    const createWriteStream = spyOn(fs, "createWriteStream").mockReturnValue(
      new FailingLogStream() as unknown as fs.WriteStream,
    );
    const mod = await loggerWithEnv("json", "both", logDir);
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      ((chunk: unknown, callback?: (error?: Error | null) => void) => {
        stderr.push(String(chunk));
        queueMicrotask(() => callback?.());
        return true;
      }) as typeof process.stderr.write,
    );

    try {
      mod.logger.info("container-ready");
      await mod.logger.flush();
    } finally {
      stderrSpy.mockRestore();
      createWriteStream.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }

    expect(JSON.parse(stderr[0])).toMatchObject({ event: "log", message: "container-ready" });
  });

});
