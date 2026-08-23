import { describe, expect, test, spyOn } from "bun:test";

let importCounter = 0;

async function loggerWithEnv(
  format: string | undefined,
  sink: string | undefined,
): Promise<typeof import("../../src/utils/logger")> {
  const previousFormat = process.env.AUTOMOBILE_LOG_FORMAT;
  const previousSink = process.env.AUTOMOBILE_LOG_SINK;
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
  }
}

describe("structured logging", () => {
  test("emits standalone redacted JSON records to stderr without stdout output", async () => {
    const mod = await loggerWithEnv("json", "stderr");
    const stderr: string[] = [];
    const stdout: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
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
});
