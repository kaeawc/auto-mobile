import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import { logStreamFactory, type LogStream } from "../../src/utils/loggingConfig";
import type { LoggerSink, LogLevel } from "../../src/utils/logger";
import { FakeLogger } from "../fakes/FakeLogger";
import { useRealLogSinks } from "../helpers/realLogSinks";
import { useScratchRoot } from "../helpers/scratchRoot";

describe("logger test sink", () => {
  useRealLogSinks();
  const scratch = useScratchRoot("logger-test-sink-");
  const fileWrites: string[] = [];
  let mod: typeof import("../../src/utils/logger");
  let previous: LoggerSink | undefined;
  let previousLevel: LogLevel;
  let stderr: ReturnType<typeof spyOn<typeof process.stderr, "write">>;
  const stderrWrites: string[] = [];

  beforeAll(async () => {
    const events = new EventEmitter();
    const stream: LogStream = Object.assign(events, {
      destroyed: false,
      writable: true,
      closed: false,
      write(chunk: string, callback: (error?: Error | null) => void) {
        fileWrites.push(chunk);
        callback(null);
        return true;
      },
      end(callback?: () => void) {
        this.closed = true;
        events.emit("close");
        callback?.();
      },
    });
    const create = spyOn(logStreamFactory, "create").mockImplementation(() => stream);
    const keys = ["AUTOMOBILE_LOG_DIR", "AUTOMOBILE_LOG_SINK", "AUTOMOBILE_LOG_FORMAT"] as const;
    const saved = keys.map((key) => process.env[key]);
    process.env.AUTOMOBILE_LOG_DIR = scratch.next();
    process.env.AUTOMOBILE_LOG_SINK = "both";
    process.env.AUTOMOBILE_LOG_FORMAT = "text";
    try {
      const modulePath = "../../src/utils/logger.ts?logger-test-sink";
      mod = await import(modulePath);
    } finally {
      create.mockRestore();
      keys.forEach((key, index) => {
        if (saved[index] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[index];
        }
      });
    }
  });
  afterAll(async () => {
    await mod.logger.closeAfterFlush();
  });
  beforeEach(() => {
    previous = mod.setLoggerSinkForTesting(undefined);
    previousLevel = mod.logger.getLogLevel();
    fileWrites.length = 0;
    stderrWrites.length = 0;
    stderr = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      stderrWrites.push(String(chunk));
      callback?.(null);
      return true;
    }) as typeof process.stderr.write);
  });
  afterEach(() => {
    mod.setLoggerSinkForTesting(previous);
    mod.logger.setLogLevel(previousLevel);
    stderr.mockRestore();
  });

  test("forwards all levels and original arguments below the threshold without sink writes", async () => {
    const sink = new FakeLogger();
    mod.setLoggerSinkForTesting(sink);
    mod.logger.setLogLevel(mod.LogLevel.NONE);
    const payload = { value: "original" };
    const error = new Error("original");
    const levels = ["debug", "info", "warn", "error"] as const;
    for (const level of levels) {
      mod.logger[level](`${level} message`, payload, error, 3);
    }
    await mod.logger.flush();
    expect(sink.messages).toEqual(
      levels.map((level) => ({ level, message: `${level} message`, args: [payload, error, 3] })),
    );
    expect(sink.messages[0].args[0]).toBe(payload);
    expect(sink.messages[0].args[1]).toBe(error);
    expect(fileWrites).toEqual([]);
    expect(stderrWrites).toEqual([]);
  });

  test("returns the previous sink and restores its receiver and capture", () => {
    const outer = new FakeLogger();
    const inner = new FakeLogger();
    expect(mod.setLoggerSinkForTesting(outer)).toBeUndefined();
    const restore = mod.setLoggerSinkForTesting(inner);
    expect(restore).toBe(outer);
    mod.logger.warn("inner", 1);
    expect(mod.setLoggerSinkForTesting(restore)).toBe(inner);
    mod.logger.info("outer", 2);
    expect(inner.messages).toEqual([{ level: "warn", message: "inner", args: [1] }]);
    expect(outer.messages).toEqual([{ level: "info", message: "outer", args: [2] }]);
    expect(mod.setLoggerSinkForTesting(undefined)).toBe(outer);
  });

  test("removing the sink resumes the same formatted file and stderr output and level filtering", async () => {
    mod.logger.setLogLevel(mod.LogLevel.WARN);
    mod.logger.debug("filtered debug");
    mod.logger.info("filtered info");
    mod.logger.warn("normal record", 42);
    await mod.logger.flush();
    expect(fileWrites).toHaveLength(1);
    const baseline = fileWrites[0].slice(fileWrites[0].indexOf(" "));
    expect(baseline).toContain("[WARN] normal record 42");
    expect(stderrWrites).toEqual([fileWrites[0]]);
    const sink = new FakeLogger();
    expect(mod.setLoggerSinkForTesting(sink)).toBeUndefined();
    mod.logger.warn("captured record");
    expect(mod.setLoggerSinkForTesting(undefined)).toBe(sink);
    mod.logger.warn("normal record", 42);
    await mod.logger.flush();
    expect(fileWrites).toHaveLength(2);
    expect(fileWrites[1].slice(fileWrites[1].indexOf(" "))).toBe(baseline);
    expect(stderrWrites).toEqual(fileWrites);
    expect(sink.at("warn")).toHaveLength(1);
  });
});
