import { describe, test } from "bun:test";
import fc from "fast-check";
import { ActionableError, toActionableError } from "../../src/models/ActionableError";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const context = fc.string({ maxLength: 40 });
// Arbitrary caught values that are NOT already actionable: primitives, plain
// objects, and plain Errors (which take the wrapping branch).
const nonActionable = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.object(),
  fc.string().map((m) => new Error(m)),
);

describe("toActionableError (property-based)", () => {
  test("always returns an ActionableError for any caught value (totality)", () => {
    fc.assert(
      fc.property(fc.anything(), context, (error, ctx) => {
        const result = toActionableError(error, ctx);
        return result instanceof ActionableError && result instanceof Error;
      }),
      RUN_OPTIONS,
    );
  });

  test("passes an already-actionable error through unchanged, ignoring context", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), context, (message, ctx) => {
        const original = new ActionableError(message);
        const result = toActionableError(original, ctx);
        return result === original && result.message === message;
      }),
      RUN_OPTIONS,
    );
  });

  test("wraps a plain Error as `context: message`", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), context, (message, ctx) => {
        return toActionableError(new Error(message), ctx).message === `${ctx}: ${message}`;
      }),
      RUN_OPTIONS,
    );
  });

  test("wraps a non-Error value as `context: String(value)`", () => {
    const nonError = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.object(),
    );
    fc.assert(
      fc.property(nonError, context, (value, ctx) => {
        return toActionableError(value, ctx).message === `${ctx}: ${String(value)}`;
      }),
      RUN_OPTIONS,
    );
  });

  test("the result is a fixed point — re-wrapping never doubles the context", () => {
    fc.assert(
      fc.property(fc.anything(), context, context, (error, c1, c2) => {
        const once = toActionableError(error, c1);
        return toActionableError(once, c2) === once;
      }),
      RUN_OPTIONS,
    );
  });

  test("a wrapped (non-actionable) value's message starts with its context prefix", () => {
    fc.assert(
      fc.property(nonActionable, context, (error, ctx) => {
        return toActionableError(error, ctx).message.startsWith(`${ctx}: `);
      }),
      RUN_OPTIONS,
    );
  });
});
