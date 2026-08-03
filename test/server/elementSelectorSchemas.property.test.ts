import { describe, test } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import { validateElementIdTextSelector } from "../../src/server/elementSelectorSchemas";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const DEFAULT_MESSAGE = "Provide exactly one of elementId or text";

// All 4 presence/absence combinations, including the "" (empty-string, but
// still `!== undefined`) edge case for each field.
const optionalString = fc.option(fc.string(), { nil: undefined });
const selectorValue = fc.record({ elementId: optionalString, text: optionalString });

// The function only calls `ctx.addIssue(...)`, so a minimal fake — no full
// `ParsePayload` — is all `validateElementIdTextSelector` actually touches.
const makeCtx = () => {
  const issues: Array<{ message: string }> = [];
  const ctx = { addIssue: (issue: { message: string }) => { issues.push(issue); } } as unknown as z.RefinementCtx;
  return { ctx, issues };
};

describe("validateElementIdTextSelector (property-based)", () => {
  // `hasElementId`/`hasText` are `!== undefined` checks, so an empty string
  // counts as "present" — the XOR fires (no issue) whenever exactly one field
  // is defined, regardless of whether its value is truthy.
  test("addIssue fires exactly once when both or neither of elementId/text are defined", () => {
    fc.assert(
      fc.property(selectorValue, value => {
        const { ctx, issues } = makeCtx();
        validateElementIdTextSelector(value, ctx);
        const bothOrNeither = (value.elementId !== undefined) === (value.text !== undefined);
        return bothOrNeither ? issues.length === 1 : issues.length === 0;
      }),
      RUN_OPTIONS
    );
  });

  test("never throws for any presence/absence combination", () => {
    fc.assert(
      fc.property(selectorValue, value => {
        const { ctx } = makeCtx();
        validateElementIdTextSelector(value, ctx);
        return true;
      }),
      RUN_OPTIONS
    );
  });

  // When the XOR check fails, the recorded issue's message is the custom
  // `message` argument if one was passed, else the hard-coded default.
  test("the recorded issue uses the custom message when given, else the default", () => {
    fc.assert(
      fc.property(selectorValue, fc.option(fc.string(), { nil: undefined }), (value, message) => {
        const { ctx, issues } = makeCtx();
        if (message === undefined) {
          validateElementIdTextSelector(value, ctx);
        } else {
          validateElementIdTextSelector(value, ctx, message);
        }
        const bothOrNeither = (value.elementId !== undefined) === (value.text !== undefined);
        if (!bothOrNeither) {
          return issues.length === 0;
        }
        const expected = message === undefined ? DEFAULT_MESSAGE : message;
        return issues.length === 1 && issues[0].message === expected;
      }),
      RUN_OPTIONS
    );
  });
});
