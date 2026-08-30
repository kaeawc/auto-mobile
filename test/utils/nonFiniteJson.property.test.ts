import { describe, test } from "bun:test";
import fc from "fast-check";
import { decodeNonFinite, encodeNonFinite } from "../../src/utils/nonFiniteJson";

// Property-based companion to nonFiniteJson.test.ts. The module promises that a
// non-finite tool-call argument (Infinity/-Infinity/NaN) survives every JSON hop
// between the daemon client and the MCP handler: the client encodes each one as a
// JSON-safe sentinel object, and the handler revives it back to the real number
// (issue #5854 §2). The example tests pin a handful of shapes; these assert the
// round-trip / structural / idempotence invariants over arbitrary payloads.
//
// A pinned seed keeps CI deterministic — see Backoff.property.test.ts for the
// rationale. On failure fast-check prints the seed and the shrunk counterexample.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Structural deep-equality that treats NaN as equal to itself (JSON has no NaN,
// so we compare against the pre-encode value) and, like JSON, does not
// distinguish -0 from 0 (JSON.stringify serializes -0 as 0). Everything else is
// exact.
function deepEqualJsonish(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) {
      return true;
    }
    return a === b; // -0 === 0 is true, matching JSON's -0 -> 0 coercion.
  }
  if (a === null || b === null) {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => deepEqualJsonish(x, b[i]));
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
        deepEqualJsonish((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return a === b;
}

// Leaves include the three non-finite numbers — the whole reason this module
// exists — alongside ordinary JSON scalars.
const nonFinite = fc.constantFrom(Infinity, -Infinity, NaN);
const finite = fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }));
const leaf = fc.oneof(fc.constant(null), fc.boolean(), fc.string(), finite, nonFinite);

// Object keys are drawn from a plain alphabet so a generated key can never
// collide with the sentinel tag or with `__proto__` — those false-sentinel and
// prototype-key cases are pinned deterministically in nonFiniteJson.test.ts, and
// keeping them out here isolates the round-trip invariant from that noise.
const objectKey = fc.string({ minLength: 1, maxLength: 6, unit: "grapheme-ascii" });

// Arbitrary JSON-shaped payload whose scalars may be non-finite.
const payload = fc.letrec<{ tree: unknown }>((rec) => ({
  tree: fc.oneof(
    { maxDepth: 4, depthSize: "small" },
    leaf,
    fc.array(rec("tree"), { maxLength: 5 }),
    fc.dictionary(objectKey, rec("tree"), { maxKeys: 5 }),
  ),
})).tree;

// Encode with the daemon's transport encoder, then model the daemon socket hop plus
// the loopback StreamableHTTP hop as `hops` further *plain* JSON round-trips (the
// sentinels are ordinary objects by then, so no encoder is involved), then decode.
function throughWire(value: unknown, hops: number): unknown {
  const { value: encoded } = encodeNonFinite(value);
  let carrier = JSON.stringify(encoded);
  for (let i = 0; i < hops; i++) {
    carrier = JSON.stringify(JSON.parse(carrier));
  }
  return decodeNonFinite(JSON.parse(carrier));
}

describe("nonFiniteJson (property-based)", () => {
  test("encode -> hops -> revive round-trips any payload, non-finite numbers included", () => {
    fc.assert(
      fc.property(payload, fc.integer({ min: 1, max: 6 }), (value, hops) =>
        deepEqualJsonish(throughWire(value, hops), value),
      ),
      RUN_OPTIONS,
    );
  });

  test("revive leaves a sentinel-free JSON value structurally unchanged", () => {
    // fc.jsonValue() never emits non-finite numbers or the sentinel tag, so revive
    // must be a structural no-op: the common case is every tool request that
    // carries no non-finite argument.
    fc.assert(
      fc.property(fc.jsonValue(), (value) => deepEqualJsonish(decodeNonFinite(value), value)),
      RUN_OPTIONS,
    );
  });

  test("revive is idempotent — a second pass changes nothing", () => {
    fc.assert(
      fc.property(payload, (value) => {
        const { value: encoded } = encodeNonFinite(value);
        const wire = JSON.parse(JSON.stringify(encoded));
        const once = decodeNonFinite(wire);
        const twice = decodeNonFinite(once);
        return deepEqualJsonish(once, twice);
      }),
      RUN_OPTIONS,
    );
  });

  test("no non-finite number survives to the wire as a JSON null", () => {
    // The failure this module fixes: JSON.stringify without the replacer flattens
    // Infinity/-Infinity/NaN to null. With the replacer, a value that was
    // non-finite before encoding must revive to a non-finite number, never null.
    fc.assert(
      fc.property(nonFinite, (value) => {
        const revived = throughWire({ arg: value }, 2) as { arg: unknown };
        return typeof revived.arg === "number" && !Number.isFinite(revived.arg);
      }),
      RUN_OPTIONS,
    );
  });
});
