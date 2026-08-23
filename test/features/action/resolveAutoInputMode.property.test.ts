import { describe, test } from "bun:test";
import fc from "fast-check";
import { resolveAutoInputMode } from "../../../src/features/action/resolveAutoInputMode";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const text = fc.string({ maxLength: 40 });
const markers = fc.array(fc.string({ maxLength: 8 }), { maxLength: 6 });

describe("resolveAutoInputMode (property-based)", () => {
  test('only ever returns "eventAll" or undefined', () => {
    fc.assert(
      fc.property(text, markers, (t, m) => {
        const r = resolveAutoInputMode(t, m);
        return r === "eventAll" || r === undefined;
      }),
      RUN_OPTIONS,
    );
  });

  test("promotes iff some non-empty marker is a substring of the text", () => {
    fc.assert(
      fc.property(text, markers, (t, m) => {
        const expected = m.some((marker) => marker.length > 0 && t.includes(marker))
          ? "eventAll"
          : undefined;
        return resolveAutoInputMode(t, m) === expected;
      }),
      RUN_OPTIONS,
    );
  });

  test("an empty marker list never promotes", () => {
    fc.assert(
      fc.property(text, (t) => resolveAutoInputMode(t, []) === undefined),
      RUN_OPTIONS,
    );
  });

  test('an empty-string marker is ignored despite text.includes("") being true', () => {
    fc.assert(
      fc.property(text, (t) => resolveAutoInputMode(t, [""]) === undefined),
      RUN_OPTIONS,
    );
  });

  test("a non-empty substring of the text always promotes", () => {
    // A guaranteed non-empty slice of the text is always a present marker.
    const textAndMarker = fc
      .string({ minLength: 1, maxLength: 40 })
      .chain((t) =>
        fc.record({
          t: fc.constant(t),
          start: fc.integer({ min: 0, max: t.length - 1 }),
          extra: fc.integer({ min: 0, max: t.length }),
        }),
      )
      .map(({ t, start, extra }) => ({
        t,
        marker: t.slice(start, Math.min(t.length, start + 1 + extra)),
      }));
    fc.assert(
      fc.property(
        textAndMarker,
        ({ t, marker }) => marker.length >= 1 && resolveAutoInputMode(t, [marker]) === "eventAll",
      ),
      RUN_OPTIONS,
    );
  });
});
