import { describe, expect, test } from "bun:test";
import {
  decodeNonFinite,
  encodeNonFinite,
  reviveNonFiniteArguments,
} from "../../src/utils/nonFiniteJson";
import { DAEMON_NON_FINITE_ENCODED_PARAM } from "../../src/daemon/constants";

// Issue #5854 §2: JSON has no representation for non-finite numbers, so a
// tool-call argument that is Infinity/-Infinity/NaN is flattened to `null` before
// the daemon can log or validate it. The client encodes them as JSON-safe
// sentinels that survive the wire; the MCP handler revives them.
//
// Issue #5863 hardens two gaps: literal-collision escaping and provenance scoping.

const TAG = "__autoMobileNonFinite__";

// Model the real wire path: encode → JSON stringify → parse (socket) → stringify →
// parse (loopback HTTP) → decode.
function throughWire(value: unknown): unknown {
  const { value: encoded } = encodeNonFinite(value);
  const afterHops = JSON.parse(JSON.stringify(JSON.parse(JSON.stringify(encoded))));
  return decodeNonFinite(afterHops);
}

// Model the FULL client→server path, including the provenance gate: the client
// stamps the flag only when `encodeNonFinite` reports it transformed the payload,
// and the server (`reviveNonFiniteArguments`) decodes only flagged requests. This
// is the path an argument actually travels — decode does not run unconditionally.
function throughDaemon(args: unknown): unknown {
  const { value, encoded } = encodeNonFinite(args);
  const wire =
    encoded && value !== null && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), [DAEMON_NON_FINITE_ENCODED_PARAM]: true }
      : value;
  const afterHops = JSON.parse(JSON.stringify(JSON.parse(JSON.stringify(wire))));
  return reviveNonFiniteArguments(afterHops);
}

describe("encodeNonFinite encodes non-finite numbers as sentinels", () => {
  test("Infinity/-Infinity/NaN become tagged objects on the wire", () => {
    const { value, encoded } = encodeNonFinite({
      duration: Infinity,
      back: -Infinity,
      ratio: NaN,
      ok: 3,
      label: "hi",
    });
    expect(encoded).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      duration: { [TAG]: "Infinity" },
      back: { [TAG]: "-Infinity" },
      ratio: { [TAG]: "NaN" },
      ok: 3,
      label: "hi",
    });
  });

  test("finite numbers (including -0 and large values) are left untouched, encoded=false", () => {
    const { value, encoded } = encodeNonFinite({ a: 0, b: -0, c: -3.5, d: 1e308 });
    expect(encoded).toBe(false);
    // -0 serializes as 0 (unchanged from default JSON behavior).
    expect(JSON.parse(JSON.stringify(value))).toEqual({ a: 0, b: 0, c: -3.5, d: 1e308 });
  });

  test("non-finite values nested in arrays and objects are encoded", () => {
    const { value, encoded } = encodeNonFinite({ xs: [1, Infinity], inner: { n: NaN } });
    expect(encoded).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      xs: [1, { [TAG]: "Infinity" }],
      inner: { n: { [TAG]: "NaN" } },
    });
  });
});

describe("decodeNonFinite restores the real numbers", () => {
  test("round-trips non-finite numbers through multiple JSON hops", () => {
    const revived = throughWire({
      params: { arguments: { duration: Infinity, x: -Infinity, y: NaN } },
    }) as { params: { arguments: Record<string, number> } };
    const args = revived.params.arguments;
    expect(args.duration).toBe(Infinity);
    expect(args.x).toBe(-Infinity);
    expect(Number.isNaN(args.y)).toBe(true);
  });

  test("a revived non-finite fails Number.isFinite, so the schema rejects it", () => {
    const revived = decodeNonFinite({ [TAG]: "Infinity" });
    expect(typeof revived).toBe("number");
    expect(Number.isFinite(revived as number)).toBe(false);
  });

  test("a payload with no sentinels round-trips structurally unchanged", () => {
    const input = { a: 1, b: "x", c: [1, 2, { d: true }], e: null };
    expect(throughWire(input)).toEqual(input);
  });

  test("primitives pass through", () => {
    expect(decodeNonFinite(5)).toBe(5);
    expect(decodeNonFinite("s")).toBe("s");
    expect(decodeNonFinite(null)).toBe(null);
  });

  // Every tool request passes through this walk, so an own "__proto__" key in a
  // valid payload (e.g. a header map) must be preserved as data, not routed to the
  // prototype setter (which would drop it and could pollute the prototype).
  test("an own __proto__ key is preserved as a data property, not the prototype", () => {
    const parsed = JSON.parse('{"headers":{"__proto__":"keep","X-Ok":"1"}}') as {
      headers: Record<string, unknown>;
    };
    const revived = decodeNonFinite(parsed) as { headers: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(revived.headers, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(revived.headers, "__proto__")?.value).toBe("keep");
    expect(revived.headers["X-Ok"]).toBe("1");
    // The reconstructed object keeps a normal prototype (no pollution).
    expect(Object.getPrototypeOf(revived.headers)).toBe(Object.prototype);
  });
});

// Issue #5863 AC1: a literal user object shaped exactly like the sentinel must
// round-trip unchanged rather than being misdecoded as a non-finite number.
describe("encodeNonFinite escapes literal objects that collide with the sentinel", () => {
  test("a bare sentinel-shaped object round-trips as an object, not a number", () => {
    const literal = { [TAG]: "Infinity" };
    const result = throughWire(literal);
    expect(result).toEqual(literal);
    expect(typeof result).toBe("object");
  });

  test("each marker value round-trips as a literal object", () => {
    for (const marker of ["Infinity", "-Infinity", "NaN"]) {
      expect(throughWire({ [TAG]: marker })).toEqual({ [TAG]: marker });
    }
  });

  test("a sentinel-shaped object nested inside a real payload round-trips", () => {
    const input = {
      responseHeaders: { [TAG]: "NaN" },
      other: { list: [{ [TAG]: "-Infinity" }, 7] },
    };
    expect(throughWire(input)).toEqual(input);
  });

  test("a real object whose TAG value is itself a non-finite number round-trips both facets", () => {
    const input = { [TAG]: Infinity };
    const result = throughWire(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual([TAG]);
    expect(result[TAG]).toBe(Infinity);
  });

  test("a TAG-keyed object with sibling keys round-trips unchanged", () => {
    const input = { [TAG]: "Infinity", extra: 1, nested: { ok: true } };
    expect(throughWire(input)).toEqual(input);
  });

  test("a non-marker TAG value still round-trips unchanged", () => {
    expect(throughWire({ [TAG]: "nope" })).toEqual({ [TAG]: "nope" });
  });
});

// Issue #5863 AC2: revival must be scoped to requests the client actually encoded.
describe("reviveNonFiniteArguments applies revival only by transport provenance", () => {
  test("with the encoded flag it revives sentinels and strips the flag", () => {
    const { value } = encodeNonFinite({ duration: Infinity, ok: 3 });
    const args = { ...(value as Record<string, unknown>), [DAEMON_NON_FINITE_ENCODED_PARAM]: true };
    const revived = reviveNonFiniteArguments(args) as Record<string, unknown>;
    expect(revived.duration).toBe(Infinity);
    expect(revived.ok).toBe(3);
    expect(DAEMON_NON_FINITE_ENCODED_PARAM in revived).toBe(false);
  });

  test("without the flag, a sentinel-shaped argument is returned untouched", () => {
    // A direct in-memory / stdio client never encodes, so its request carries no
    // flag. Even an argument that literally looks like a sentinel is left alone.
    const args = { duration: { [TAG]: "Infinity" }, ok: 3 };
    const result = reviveNonFiniteArguments(args);
    expect(result).toBe(args);
    expect((result as Record<string, unknown>).duration).toEqual({ [TAG]: "Infinity" });
  });

  test("non-object arguments pass through", () => {
    expect(reviveNonFiniteArguments(undefined)).toBe(undefined);
    expect(reviveNonFiniteArguments("x")).toBe("x");
  });

  // Regression (#5863): escaping is applied whenever a real object collides with
  // the sentinel shape, but un-escaping (decode) is provenance-gated. If a request
  // whose ONLY special feature is a collision-shaped object — no co-occurring
  // non-finite number — did not set the flag, the escaped wrapper would reach the
  // tool uncorrected. The client must flag escape-only requests too.
  test("a collision-shaped argument with NO non-finite still round-trips end-to-end", () => {
    const bare = { __autoMobileNonFinite__: "NaN" };
    expect(throughDaemon(bare)).toEqual(bare);

    const nested = { responseHeaders: { __autoMobileNonFinite__: "Infinity" }, ok: 1 };
    expect(throughDaemon(nested)).toEqual(nested);
  });

  test("encodeNonFinite reports encoded=true when it only escaped a collision", () => {
    // No non-finite number anywhere, but the payload is transformed (escaped), so
    // the flag must fire — otherwise decode never runs to reverse the escape.
    const { encoded } = encodeNonFinite({ __autoMobileNonFinite__: "Infinity" });
    expect(encoded).toBe(true);
  });

  test("a non-finite argument still round-trips end-to-end through the gate", () => {
    const revived = throughDaemon({ duration: Infinity, ok: 3 }) as Record<string, unknown>;
    expect(revived.duration).toBe(Infinity);
    expect(revived.ok).toBe(3);
  });
});
