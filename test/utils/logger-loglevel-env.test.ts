import { describe, expect, test, spyOn } from "bun:test";
import fs from "fs";
import { EventEmitter } from "node:events";
import { LogLevel, parseAutomobileLogLevel, resolveProcessLogPrefix } from "../../src/utils/logger";

class FakeLogStream extends EventEmitter {
  writableFinished = false;
  destroyed = false;
  writable = true;
  readonly writes: string[] = [];
  endCalls = 0;

  write(chunk: unknown, callback?: (error: Error | null) => void): boolean {
    this.writes.push(String(chunk));
    queueMicrotask(() => callback?.(null));
    return true;
  }

  end(): this {
    this.endCalls += 1;
    this.writableFinished = true;
    queueMicrotask(() => this.emit("finish"));
    return this;
  }
}

// Re-import the logger module with AUTOMOBILE_LOG_LEVEL set so the module-load
// seed (`currentLogLevel = parseAutomobileLogLevel(...) ?? INFO`) re-evaluates
// against the env. A unique query per call defeats the module cache; the env is
// restored once the import (and thus the seed read) has completed.
let freshImportCounter = 0;
async function loggerWithEnvLevel(
  value: string | undefined
): Promise<typeof import("../../src/utils/logger")> {
  const previous = process.env.AUTOMOBILE_LOG_LEVEL;
  if (value === undefined) {
    delete process.env.AUTOMOBILE_LOG_LEVEL;
  } else {
    process.env.AUTOMOBILE_LOG_LEVEL = value;
  }
  try {
    return await import(`../../src/utils/logger.ts?loglevel-seed-${freshImportCounter++}`);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_LOG_LEVEL;
    } else {
      process.env.AUTOMOBILE_LOG_LEVEL = previous;
    }
  }
}

describe("parseAutomobileLogLevel", () => {
  test("returns null for unset or blank", () => {
    expect(parseAutomobileLogLevel(undefined)).toBeNull();
    expect(parseAutomobileLogLevel("")).toBeNull();
    expect(parseAutomobileLogLevel("   ")).toBeNull();
  });

  test("parses known levels case-insensitively", () => {
    expect(parseAutomobileLogLevel("DEBUG")).toBe(LogLevel.DEBUG);
    expect(parseAutomobileLogLevel("Info")).toBe(LogLevel.INFO);
    expect(parseAutomobileLogLevel("warn")).toBe(LogLevel.WARN);
    expect(parseAutomobileLogLevel("warning")).toBe(LogLevel.WARN);
    expect(parseAutomobileLogLevel("ERROR")).toBe(LogLevel.ERROR);
    expect(parseAutomobileLogLevel("none")).toBe(LogLevel.NONE);
    expect(parseAutomobileLogLevel("silent")).toBe(LogLevel.NONE);
  });

  test("returns null for garbage", () => {
    expect(parseAutomobileLogLevel("verbose")).toBeNull();
    expect(parseAutomobileLogLevel("infoo")).toBeNull();
  });
});

describe("AUTOMOBILE_LOG_LEVEL is applied at process start (issue #3845)", () => {
  test.each([
    ["debug", LogLevel.DEBUG],
    ["error", LogLevel.ERROR],
    ["none", LogLevel.NONE],
  ])("seeds the running level from AUTOMOBILE_LOG_LEVEL=%s", async (value, expected) => {
    const mod = await loggerWithEnvLevel(value);
    expect(mod.logger.getLogLevel()).toBe(expected);
  });

  test("falls back to INFO when AUTOMOBILE_LOG_LEVEL is unset", async () => {
    const mod = await loggerWithEnvLevel(undefined);
    expect(mod.logger.getLogLevel()).toBe(LogLevel.INFO);
  });

  test("falls back to INFO when AUTOMOBILE_LOG_LEVEL is unrecognized", async () => {
    const mod = await loggerWithEnvLevel("verbose");
    expect(mod.logger.getLogLevel()).toBe(LogLevel.INFO);
  });

  // The synchronous stdout sink is the deterministic seam for observing what the
  // logger actually emits (the file stream buffers, so flush() can't guarantee
  // on-disk bytes). If the env-seeded level gates emission correctly here, it
  // gates the file write the same way.
  async function captureEmit(value: string, emit: (l: typeof import("../../src/utils/logger").logger) => void): Promise<string> {
    const mod = await loggerWithEnvLevel(value);
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      mod.logger.enableStdoutLogging();
      emit(mod.logger);
      await mod.logger.flush();
    } finally {
      mod.logger.disableStdoutLogging();
      spy.mockRestore();
    }
    return writes.join("");
  }

  // Each captureEmit call has its own isolated capture buffer, so a static
  // marker per test is sufficient to assert presence/absence.
  test("actually emits a DEBUG line when seeded to debug", async () => {
    const emitted = await captureEmit("debug", l => l.debug("loglevel-3845-debug"));
    expect(emitted).toContain("loglevel-3845-debug");
  });

  test("suppresses a DEBUG line when seeded to error", async () => {
    const emitted = await captureEmit("error", l => l.debug("loglevel-3845-suppressed"));
    expect(emitted).not.toContain("loglevel-3845-suppressed");
  });

  test("still emits an ERROR line when seeded to error", async () => {
    const emitted = await captureEmit("error", l => l.error("loglevel-3845-error"));
    expect(emitted).toContain("loglevel-3845-error");
  });

  test("close waits for queued file-log writes", async () => {
    const stream = new FakeLogStream();
    const logFileExists = spyOn(fs, "existsSync").mockReturnValue(false);
    const createWriteStream = spyOn(fs, "createWriteStream").mockReturnValue(
      stream as unknown as fs.WriteStream,
    );

    try {
      const mod = await loggerWithEnvLevel("error");
      mod.logger.error("first queued line");
      mod.logger.error("second queued line");

      const closed = mod.logger.close();
      expect(stream.endCalls).toBe(0);

      await closed;
      expect(stream.writes).toHaveLength(2);
      expect(stream.endCalls).toBe(1);
    } finally {
      createWriteStream.mockRestore();
      logFileExists.mockRestore();
    }
  });
});

describe("resolveProcessLogPrefix", () => {
  test("uses stable daemon prefix in daemon mode", () => {
    expect(resolveProcessLogPrefix(["auto-mobile", "--daemon-mode"], 123)).toBe("daemon");
  });

  test("uses pid-scoped stdio prefix outside daemon mode", () => {
    expect(resolveProcessLogPrefix(["auto-mobile"], 123)).toBe("stdio-123");
  });
});
