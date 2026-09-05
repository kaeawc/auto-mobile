import { describe, expect, test, spyOn } from "bun:test";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
