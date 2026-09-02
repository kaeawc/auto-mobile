import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  getStructuredField,
  getStructuredPayload,
  throwIfAborted,
  type StructuredToolResponse,
} from "../../src/utils/toolUtils";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
// These accessors read the payload off the `structuredContent` slot of an MCP
// tool-call envelope (issues #2907 / #2932) — never the envelope top level.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const payloadObject = fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), { maxKeys: 6 });
// structuredContent may be a valid object payload, a non-object, or absent.
const structuredContent = fc.oneof(payloadObject, fc.string(), fc.integer(), fc.constant(null));
const asResponse = (sc: unknown): StructuredToolResponse<Record<string, unknown>> =>
  ({ structuredContent: sc }) as unknown as StructuredToolResponse<Record<string, unknown>>;

describe("getStructuredPayload (property-based)", () => {
  test("returns the structuredContent object by identity, else undefined", () => {
    fc.assert(
      fc.property(structuredContent, (sc) => {
        const result = getStructuredPayload(asResponse(sc));
        const isObject = sc !== null && typeof sc === "object";
        return isObject ? result === sc : result === undefined;
      }),
      RUN_OPTIONS,
    );
  });

  test("null or undefined responses yield undefined", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        (response) => getStructuredPayload(response) === undefined,
      ),
      RUN_OPTIONS,
    );
  });
});

describe("getStructuredField (property-based)", () => {
  test("returns an own field's value and undefined for an absent field", () => {
    const extraKey = fc.string({ maxLength: 8 });
    fc.assert(
      fc.property(payloadObject, extraKey, (payload, key) => {
        const value = getStructuredField(asResponse(payload), key);
        return Object.hasOwn(payload, key)
          ? value === (payload as Record<string, unknown>)[key]
          : value === undefined;
      }),
      RUN_OPTIONS,
    );
  });

  test("never leaks an inherited prototype key", () => {
    // `toString`/`hasOwnProperty` exist on the prototype but are not own keys.
    for (const key of ["toString", "hasOwnProperty", "constructor", "valueOf"]) {
      expect(getStructuredField(asResponse({}), key)).toBeUndefined();
    }
  });

  test("agrees with reading the field off getStructuredPayload", () => {
    fc.assert(
      fc.property(structuredContent, fc.string({ maxLength: 8 }), (sc, key) => {
        const field = getStructuredField(asResponse(sc), key);
        const payload = getStructuredPayload(asResponse(sc));
        const expected =
          payload && Object.hasOwn(payload, key)
            ? (payload as Record<string, unknown>)[key]
            : undefined;
        return field === expected;
      }),
      RUN_OPTIONS,
    );
  });

  test("null or undefined responses yield undefined", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        fc.string({ maxLength: 8 }),
        (response, key) => getStructuredField(response, key) === undefined,
      ),
      RUN_OPTIONS,
    );
  });
});

describe("throwIfAborted (property-based)", () => {
  test("throws exactly when the signal is already aborted", () => {
    fc.assert(
      fc.property(fc.boolean(), (aborted) => {
        const controller = new AbortController();
        if (aborted) {
          controller.abort();
          expect(() => throwIfAborted(controller.signal)).toThrow();
          return true;
        }
        // A fresh (non-aborted) signal must not throw.
        throwIfAborted(controller.signal);
        return true;
      }),
      RUN_OPTIONS,
    );
  });

  test("an undefined signal never throws", () => {
    fc.assert(
      fc.property(fc.constant(undefined), (signal) => {
        throwIfAborted(signal);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});
