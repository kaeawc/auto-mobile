import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  readToolEnvelopePayload,
  writeToolEnvelopePayload,
} from "../../src/server/toolEnvelopePayload";
import { stringifyToolResponse } from "../../src/utils/toolUtils";

// Property-based coverage for the tool-envelope payload seam. The module promises
// that the two (really three) representations a tool envelope carries for the same
// payload — `structuredContent`, the serialized `content[0].text`, and the hoisted
// `success`/`error` fields — never diverge on the wire: every rewrite reads through
// {@link readToolEnvelopePayload} and writes through {@link writeToolEnvelopePayload}
// (#6870). This file asserts the read/preference, the write/round-trip, and the
// hoist-mirroring invariants over arbitrary payloads; there was no test file for the
// module before.
//
// A pinned seed keeps CI deterministic — see nonFiniteJson.property.test.ts for the
// rationale. On failure fast-check prints the seed and the shrunk counterexample.
const RUN_OPTIONS = { seed: 6_870_123, numRuns: 300 } as const;

// Structural deep-equality over JSON-shaped values. Numbers compare with `===` so
// that JSON's `-0 -> 0` coercion (JSON.stringify serializes -0 as 0) is treated as
// equal; the generators below never emit NaN or non-finite numbers, so no special
// NaN handling is needed.
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return a === b; // -0 === 0 is true, matching JSON's -0 -> 0 coercion.
  }
  if (a === null || b === null) {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => deepEqualJson(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) {
      return false;
    }
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return a === b;
}

// Keys avoid `extras` (stringifyToolResponse strips it recursively, which would
// break a text round-trip) and `__proto__` (own-vs-prototype-key noise that is
// orthogonal to the invariants under test). Isolating those keeps the round-trip
// property clean; they are not the concern of this module.
const safeKey = fc
  .string({ minLength: 1, maxLength: 6, unit: "grapheme-ascii" })
  .filter((k) => k !== "extras" && k !== "__proto__");

const jsonLeaf = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

// Arbitrary JSON value (nested), with all object keys drawn from `safeKey`.
const jsonTree = fc.letrec<{ tree: unknown }>((rec) => ({
  tree: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    jsonLeaf,
    fc.array(rec("tree"), { maxLength: 4 }),
    fc.dictionary(safeKey, rec("tree"), { maxKeys: 4 }),
  ),
})).tree;

// A top-level object payload, the shape callers actually rewrite.
const objectPayload = fc.dictionary(safeKey, jsonTree, { maxKeys: 5 });

function textEnvelope(payload: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: stringifyToolResponse(payload) }] };
}

describe("toolEnvelopePayload (property-based)", () => {
  test("read prefers structuredContent over the text part, by identity", () => {
    fc.assert(
      fc.property(objectPayload, objectPayload, (structured, textOnly) => {
        const envelope = {
          structuredContent: structured,
          content: [{ type: "text", text: stringifyToolResponse(textOnly) }],
        };
        const view = readToolEnvelopePayload(envelope);
        expect(view).toBeDefined();
        return (
          view!.hasStructured === true &&
          // structuredContent is returned by reference, not the parsed text.
          view!.payload === structured &&
          view!.textPart === envelope.content[0]
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("read falls back to a JSON-object text part when structuredContent is absent", () => {
    fc.assert(
      fc.property(objectPayload, (payload) => {
        const envelope = textEnvelope(payload);
        const view = readToolEnvelopePayload(envelope);
        expect(view).toBeDefined();
        return (
          view!.hasStructured === false &&
          view!.textPart === envelope.content[0] &&
          deepEqualJson(view!.payload, payload)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("read returns undefined for any non-object response", () => {
    const nonObject = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string(),
      fc.boolean(),
    );
    fc.assert(
      fc.property(nonObject, (response) => readToolEnvelopePayload(response) === undefined),
      RUN_OPTIONS,
    );
  });

  test("read of a text-only envelope matches the JSON-object spec for arbitrary text", () => {
    // For any string in the text part (no structuredContent), a payload view exists
    // exactly when the text parses to a non-null object/array; a parse error or a
    // JSON primitive yields undefined. This pins the try/catch boundary precisely.
    fc.assert(
      fc.property(fc.string(), (text) => {
        const view = readToolEnvelopePayload({ content: [{ type: "text", text }] });
        let expectView: boolean;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
          expectView = parsed !== null && typeof parsed === "object";
        } catch {
          expectView = false;
        }
        if (!expectView) {
          return view === undefined;
        }
        return (
          view !== undefined && view.hasStructured === false && deepEqualJson(view.payload, parsed)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("read returns undefined when content[0] is not a text part and no structuredContent", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (mimeType, data) => {
        const envelope = { content: [{ type: "image", data, mimeType }] };
        return readToolEnvelopePayload(envelope) === undefined;
      }),
      RUN_OPTIONS,
    );
  });

  test("write mirrors the payload into every representation the view carries", () => {
    fc.assert(
      fc.property(objectPayload, objectPayload, (initial, next) => {
        // Structured + text envelope so both representations are live.
        const envelope: {
          structuredContent: unknown;
          content: Array<{ type: string; text: string }>;
        } = {
          structuredContent: initial,
          content: [{ type: "text", text: stringifyToolResponse(initial) }],
        };
        const view = readToolEnvelopePayload(envelope);
        expect(view).toBeDefined();
        writeToolEnvelopePayload(view!, next);
        // structuredContent is replaced by reference; text is re-serialized and must
        // parse back to an equal payload.
        return (
          envelope.structuredContent === next &&
          deepEqualJson(JSON.parse(envelope.content[0].text), next)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("read -> write(same payload) -> read round-trips a text-only envelope", () => {
    fc.assert(
      fc.property(objectPayload, (payload) => {
        const envelope = textEnvelope(payload);
        const first = readToolEnvelopePayload(envelope);
        expect(first).toBeDefined();
        writeToolEnvelopePayload(first!, first!.payload);
        const second = readToolEnvelopePayload(envelope);
        return (
          second !== undefined &&
          second.hasStructured === false &&
          deepEqualJson(second.payload, payload)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("write never sets structuredContent on a text-only view", () => {
    fc.assert(
      fc.property(objectPayload, objectPayload, (initial, next) => {
        const envelope: { content: Array<{ type: string; text: string }> } = textEnvelope(initial);
        const view = readToolEnvelopePayload(envelope);
        expect(view).toBeDefined();
        writeToolEnvelopePayload(view!, next);
        return !("structuredContent" in envelope);
      }),
      RUN_OPTIONS,
    );
  });

  test("write mirrors hoisted success/error only when the envelope already hoists them", () => {
    // success is a boolean field, error a string field. The hoist is only touched
    // when the envelope already carries that key: a matching-primitive payload value
    // is mirrored, a mismatched or absent one drops the hoist, and a key the envelope
    // never had is never invented.
    const hoistValue = fc.oneof(
      fc.boolean(),
      fc.string(),
      fc.integer(),
      fc.constant(undefined), // means: payload has no such key
    );
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        hoistValue,
        hoistValue,
        (hasSuccessKey, hasErrorKey, successVal, errorVal) => {
          const structured: Record<string, unknown> = { marker: 1 };
          const envelope: Record<string, unknown> = { structuredContent: structured };
          if (hasSuccessKey) {
            envelope.success = true;
          }
          if (hasErrorKey) {
            envelope.error = "seed";
          }
          const view = readToolEnvelopePayload(envelope);
          expect(view).toBeDefined();

          const payload: Record<string, unknown> = { marker: 1 };
          if (successVal !== undefined) {
            payload.success = successVal;
          }
          if (errorVal !== undefined) {
            payload.error = errorVal;
          }
          writeToolEnvelopePayload(view!, payload);

          const okField = (
            hasKey: boolean,
            key: "success" | "error",
            value: unknown,
            primitive: "boolean" | "string",
          ): boolean => {
            if (!hasKey) {
              // A key the envelope never hoisted is never invented.
              return !(key in envelope);
            }
            if (typeof value === primitive) {
              return envelope[key] === value;
            }
            // Mismatched primitive (or absent) drops the hoist rather than writing
            // a wrong-typed value.
            return !(key in envelope);
          };

          return (
            okField(hasSuccessKey, "success", successVal, "boolean") &&
            okField(hasErrorKey, "error", errorVal, "string")
          );
        },
      ),
      RUN_OPTIONS,
    );
  });
});
