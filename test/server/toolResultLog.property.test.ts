import { describe, test } from "bun:test";
import fc from "fast-check";
import { formatToolResultLog } from "../../src/server/toolResultLog";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const TIMED_OUT_SUFFIX =
  "(handler completed after the caller's request already timed out; the result was discarded)";

// Realistic tool-name charset (letters/digits) — avoids a `toolName` that itself
// contains ", error=", which would confuse the substring-based assertions below.
const toolName = fc.string({
  unit: fc.constantFrom("a", "o", "L", "n", "k", "1", "T", "p"),
  maxLength: 16,
});
const errorValue = fc.option(
  fc.oneof(fc.string({ maxLength: 12 }), fc.integer(), fc.constant("")),
  { nil: undefined },
);
const input = fc.record({
  toolName,
  success: fc.boolean(),
  error: errorValue,
  callerTimedOut: fc.boolean(),
});

describe("formatToolResultLog (property-based)", () => {
  test("level is warn iff the caller timed out, and always info/warn", () => {
    fc.assert(
      fc.property(input, (i) => {
        const line = formatToolResultLog(i);
        return (
          (line.level === "warn") === i.callerTimedOut &&
          (line.level === "info" || line.level === "warn")
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("message always opens with the canonical prefix", () => {
    fc.assert(
      fc.property(input, (i) =>
        formatToolResultLog(i).message.startsWith(
          `[ToolRegistry] ${i.toolName} result: success=${i.success}`,
        ),
      ),
      RUN_OPTIONS,
    );
  });

  test("an error clause appears exactly when success is false", () => {
    fc.assert(
      fc.property(input, (i) => {
        const { message } = formatToolResultLog(i);
        if (i.success === false) {
          return message.includes(`, error=${i.error || "unknown"}`);
        }
        return !message.includes(", error=");
      }),
      RUN_OPTIONS,
    );
  });

  test("the timed-out suffix appears exactly when the caller timed out", () => {
    fc.assert(
      fc.property(
        input,
        (i) => formatToolResultLog(i).message.includes(TIMED_OUT_SUFFIX) === i.callerTimedOut,
      ),
      RUN_OPTIONS,
    );
  });
});
