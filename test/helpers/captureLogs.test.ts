import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger, setLoggerSinkForTesting, type LoggerSink } from "../../src/utils/logger";
import { FakeLogger } from "../fakes/FakeLogger";
import { useCapturedLogs, withCapturedLogs } from "./captureLogs";

describe("useCapturedLogs lifecycle", () => {
  let previous: LoggerSink | undefined;
  let enclosing: FakeLogger;
  beforeEach(() => {
    enclosing = new FakeLogger();
    previous = setLoggerSinkForTesting(enclosing);
  });
  // Register this before the nested capture so it checks the restored sink after that teardown.
  afterEach(() => {
    const restored = setLoggerSinkForTesting(previous);
    expect(restored).toBe(enclosing);
  });

  describe("per-test capture", () => {
    const logs = useCapturedLogs();
    beforeEach(() => {
      expect(logs.none()).toBe(true);
    });
    test("captures a fresh array with call tuples and level-aware queries", () => {
      const payload = { id: 7 };
      logger.warn("warning substring", payload, 42);
      logger.info("other", "arg");
      expect(logs.messages).toHaveLength(2);
      expect(logs.at("warn")).toEqual([
        { level: "warn", message: "warning substring", args: [payload, 42] },
      ]);
      expect(logs.calls("warn")).toEqual([["warning substring", payload, 42]]);
      expect(logs.calls("warn")[0][1]).toBe(payload);
      expect(logs.has("warn", "substring")).toBe(true);
      expect(logs.has("error", "substring")).toBe(false);
      expect(logs.none()).toBe(false);
      expect(logs.none("warn")).toBe(false);
      expect(logs.none("error")).toBe(true);
      logs.clear();
      expect(logs.none()).toBe(true);
    });
    test("restores the outer capture after a throwing single-test capture", async () => {
      const failure = new Error("captured test failure");
      await expect(
        withCapturedLogs((inner) => {
          logger.error("inner failure");
          expect(inner.calls("error")).toEqual([["inner failure"]]);
          throw failure;
        }),
      ).rejects.toBe(failure);
      logger.info("outer restored");
      expect(logs.calls("info")).toEqual([["outer restored"]]);
      expect(logs.none("error")).toBe(true);
    });
    test("restores after an asynchronous throw and preserves nested previous sinks", async () => {
      const result = await withCapturedLogs(async (outer) => {
        logger.debug("before");
        await expect(
          withCapturedLogs(async () => {
            await Promise.resolve();
            throw new Error("async failure");
          }),
        ).rejects.toThrow("async failure");
        logger.debug("after");
        expect(outer.calls("debug")).toEqual([["before"], ["after"]]);
        return 17;
      });
      expect(result).toBe(17);
      expect(logs.none()).toBe(true);
    });
  });
});
