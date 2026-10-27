import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  BAGGAGE_META_KEY,
} from "@modelcontextprotocol/server";
import { parseMcpTrace, currentMcpTrace, withMcpTrace } from "../../src/daemon/mcpTraceContext";
import { formatLogRecord } from "../../src/utils/loggerValues";
import { setLogContextProvider } from "../../src/utils/logContext";
import { useRealLogSinks } from "../helpers/realLogSinks";
import { FakeTimer } from "../fakes/FakeTimer";

useRealLogSinks();

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const ctx = parseMcpTrace({
  [TRACEPARENT_META_KEY]: `00-${traceId}-00f067aa0ba902b7-01`,
  [TRACESTATE_META_KEY]: "vendor=private-state",
  [BAGGAGE_META_KEY]: "user=private-baggage",
});
const modules: Array<typeof import("../../src/utils/logger")> = [];

beforeAll(async () => {
  const previousFormat = process.env.AUTOMOBILE_LOG_FORMAT;
  const previousSink = process.env.AUTOMOBILE_LOG_SINK;
  try {
    process.env.AUTOMOBILE_LOG_SINK = "stderr";
    for (const format of ["text", "json"]) {
      process.env.AUTOMOBILE_LOG_FORMAT = format;
      const mod = await import(`../../src/utils/logger.ts?trace-context-${format}`);
      mod.setLogSinkStallTimerForTesting(new FakeTimer());
      mod.logger.setLogLevel(mod.LogLevel.DEBUG);
      modules.push(mod);
    }
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
});

describe("logger trace context provider", () => {
  test.each(["text", "json"] as const)(
    "%s logs only the active trace id and otherwise preserves bytes",
    async (format) => {
      const mod = modules[format === "text" ? 0 : 1];
      const lines: string[] = [];
      const clock = spyOn(Date.prototype, "toISOString").mockReturnValue(
        "2026-07-28T00:00:00.000Z",
      );
      const stderr = spyOn(process.stderr, "write").mockImplementation(((
        chunk: unknown,
        callback?: (error?: Error | null) => void,
      ) => {
        lines.push(String(chunk));
        callback?.(null);
        return true;
      }) as typeof process.stderr.write);
      try {
        const component = mod.resolveProcessLogPrefix(process.argv, process.pid);
        const expected = `${formatLogRecord(format, component, "INFO", "same message", [{ safe: 1 }])}\n`;
        withMcpTrace(ctx, () => mod.logger.info("same message", { safe: 1 }));
        setLogContextProvider(currentMcpTrace);
        mod.logger.info("same message", { safe: 1 });
        await withMcpTrace(ctx, async () => {
          await Promise.resolve();
          mod.logger.info("same message", { safe: 1 });
          mod.logger.debug("debug");
          mod.logger.warn("warn");
          mod.logger.error("error");
          mod.logger.info("x".repeat(2000));
        });
        mod.logger.info("same message", { safe: 1 });
        await mod.logger.flush();
        expect(lines[0]).toBe(expected); // Provider defaults to none, even in a trace scope.
        expect(lines[1]).toBe(expected); // Provider installed, no active trace.
        for (const line of lines.slice(2, 7)) {
          expect(line).toContain(`trace=${traceId}`);
          expect(line).not.toContain("private-state");
          expect(line).not.toContain("private-baggage");
          expect(line).not.toContain("00f067aa0ba902b7");
          expect(line).not.toContain("tracestate");
          expect(line).not.toContain("baggage");
        }
        expect(lines[7]).toBe(expected);
        setLogContextProvider(undefined);
        withMcpTrace(ctx, () => mod.logger.info("same message", { safe: 1 }));
        await mod.logger.flush();
        expect(lines[8]).toBe(expected);
      } finally {
        setLogContextProvider(undefined);
        stderr.mockRestore();
        clock.mockRestore();
        await mod.logger.closeAfterFlush();
      }
    },
  );
});
