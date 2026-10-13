import { beforeAll, afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testOverrides } from "../../src/utils/testOverrides";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { useScratchRoot } from "../helpers/scratchRoot";

describe("test log sink override", () => {
  const scratch = useScratchRoot("am-log-sink-override-");
  let mod: typeof import("../../src/utils/logger");
  let logFile: string;
  let previousOverride: typeof testOverrides.logSinksDisabled;

  describe("fresh logger instance", () => {
    beforeAll(async () => {
      previousOverride = testOverrides.logSinksDisabled;
      const logDir = scratch.next();
      const previousDir = process.env.AUTOMOBILE_LOG_DIR;
      const previousSink = process.env.AUTOMOBILE_LOG_SINK;
      const previousFormat = process.env.AUTOMOBILE_LOG_FORMAT;
      process.env.AUTOMOBILE_LOG_DIR = logDir;
      process.env.AUTOMOBILE_LOG_SINK = "both";
      process.env.AUTOMOBILE_LOG_FORMAT = "text";
      try {
        mod = await import("../../src/utils/logger.ts?test-sink-override");
        logFile = join(logDir, `${mod.resolveProcessLogPrefix(process.argv, process.pid)}.log`);
        testOverrides.logSinksDisabled = undefined;
        mod.logger.info("warm-up-record");
        await mod.logger.flush();
      } finally {
        testOverrides.logSinksDisabled = previousOverride;
        if (previousDir === undefined) {
          delete process.env.AUTOMOBILE_LOG_DIR;
        } else {
          process.env.AUTOMOBILE_LOG_DIR = previousDir;
        }
        if (previousSink === undefined) {
          delete process.env.AUTOMOBILE_LOG_SINK;
        } else {
          process.env.AUTOMOBILE_LOG_SINK = previousSink;
        }
        if (previousFormat === undefined) {
          delete process.env.AUTOMOBILE_LOG_FORMAT;
        } else {
          process.env.AUTOMOBILE_LOG_FORMAT = previousFormat;
        }
      }
    });

    afterAll(async () => {
      try {
        await mod?.logger.closeAfterFlush();
      } finally {
        testOverrides.logSinksDisabled = previousOverride;
      }
    });

    test("discards before formatting and resumes real sinks on the same instance", async () => {
      const previous = testOverrides.logSinksDisabled;
      const previousLevel = mod.logger.getLogLevel();
      const writes: string[] = [];
      const stderr = spyOn(process.stderr, "write").mockImplementation(((
        chunk: unknown,
        callback?: (error?: Error | null) => void,
      ) => {
        writes.push(String(chunk));
        callback?.(null);
        return true;
      }) as typeof process.stderr.write);
      try {
        const contentsBefore = readFileSync(logFile, "utf8");
        testOverrides.logSinksDisabled = () => true;
        mod.logger.setLogLevel(mod.LogLevel.INFO);
        let formattingVisits = 0;
        mod.logger.info("discarded-record", {
          get payload() {
            formattingVisits++;
            return "must not format";
          },
        });
        let settled = false;
        void mod.logger.flush().then(() => {
          settled = true;
        });
        await drainMicrotasks(100);
        expect(settled).toBe(true);
        expect(formattingVisits).toBe(0);
        expect(writes).toHaveLength(0);
        const contentsWhileDisabled = readFileSync(logFile, "utf8");
        expect(contentsWhileDisabled).toBe(contentsBefore);
        expect(contentsWhileDisabled).not.toContain("discarded-record");
        testOverrides.logSinksDisabled = undefined;
        mod.logger.info("resumed-first");
        mod.logger.info("resumed-second");
        await mod.logger.flush();
        const contents = readFileSync(logFile, "utf8");
        expect(contents).not.toContain("discarded-record");
        expect(contents).toContain("resumed-first");
        expect(contents).toContain("resumed-second");
        expect(contents.indexOf("resumed-first")).toBeLessThan(contents.indexOf("resumed-second"));
        expect(writes.join("")).toContain("resumed-first");
        expect(writes.join("")).not.toContain("discarded-record");
      } finally {
        stderr.mockRestore();
        mod.logger.setLogLevel(previousLevel);
        testOverrides.logSinksDisabled = previous;
      }
    });

    test("the override leaves level getters and setters unaffected", () => {
      const previous = testOverrides.logSinksDisabled;
      const previousLevel = mod.logger.getLogLevel();
      try {
        testOverrides.logSinksDisabled = () => true;
        mod.logger.setLogLevel(mod.LogLevel.DEBUG);
        expect(mod.logger.getLogLevel()).toBe(mod.LogLevel.DEBUG);
        testOverrides.logSinksDisabled = undefined;
        expect(mod.logger.getLogLevel()).toBe(mod.LogLevel.DEBUG);
        mod.logger.setLogLevel(mod.LogLevel.ERROR);
        expect(mod.logger.getLogLevel()).toBe(mod.LogLevel.ERROR);
      } finally {
        mod.logger.setLogLevel(previousLevel);
        testOverrides.logSinksDisabled = previous;
      }
    });
  });
});
