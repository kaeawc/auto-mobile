import { describe, expect, test } from "bun:test";
import { nonFiniteReplacer, reviveNonFiniteNumbers } from "../../src/utils/nonFiniteJson";

// Issue #5854 §2: JSON has no representation for non-finite numbers, so a
// tool-call argument that is Infinity/-Infinity/NaN is flattened to `null` before
// the daemon can log or validate it. The client encodes them as JSON-safe
// sentinels that survive the wire; the MCP handler revives them.

const TAG = "__autoMobileNonFinite__";

describe("nonFiniteReplacer encodes non-finite numbers as sentinels", () => {
  test("Infinity/-Infinity/NaN become tagged objects on the wire", () => {
    const wire = JSON.stringify(
      { duration: Infinity, back: -Infinity, ratio: NaN, ok: 3, label: "hi" },
      nonFiniteReplacer,
    );
    expect(JSON.parse(wire)).toEqual({
      duration: { [TAG]: "Infinity" },
      back: { [TAG]: "-Infinity" },
      ratio: { [TAG]: "NaN" },
      ok: 3,
      label: "hi",
    });
  });

  test("finite numbers (including -0 and large values) are left untouched", () => {
    const wire = JSON.stringify({ a: 0, b: -0, c: -3.5, d: 1e308 }, nonFiniteReplacer);
    // -0 serializes as 0 (unchanged from default JSON behavior).
    expect(JSON.parse(wire)).toEqual({ a: 0, b: 0, c: -3.5, d: 1e308 });
  });

  test("non-finite values nested in arrays and objects are encoded", () => {
    const wire = JSON.stringify({ xs: [1, Infinity], inner: { n: NaN } }, nonFiniteReplacer);
    expect(JSON.parse(wire)).toEqual({
      xs: [1, { [TAG]: "Infinity" }],
      inner: { n: { [TAG]: "NaN" } },
    });
  });
});

describe("reviveNonFiniteNumbers restores the real numbers", () => {
  test("round-trips through multiple JSON hops (socket + loopback HTTP)", () => {
    const original = { params: { arguments: { duration: Infinity, x: -Infinity, y: NaN } } };
    const wire = JSON.stringify(original, nonFiniteReplacer);
    // Two further plain JSON hops model the daemon parse and the SDK HTTP transport.
    const afterHops = JSON.parse(JSON.stringify(JSON.parse(wire)));
    const revived = reviveNonFiniteNumbers(afterHops.params.arguments) as Record<string, number>;
    expect(revived.duration).toBe(Infinity);
    expect(revived.x).toBe(-Infinity);
    expect(Number.isNaN(revived.y)).toBe(true);
  });

  test("a revived non-finite fails Number.isFinite, so the schema rejects it", () => {
    const revived = reviveNonFiniteNumbers({ [TAG]: "Infinity" });
    expect(typeof revived).toBe("number");
    expect(Number.isFinite(revived as number)).toBe(false);
  });

  test("a payload with no sentinels is returned structurally unchanged", () => {
    const input = { a: 1, b: "x", c: [1, 2, { d: true }], e: null };
    expect(reviveNonFiniteNumbers(input)).toEqual(input);
  });

  test("an object that merely resembles a sentinel is not misdecoded", () => {
    // Extra key → not a sentinel; unknown marker → not a sentinel.
    expect(reviveNonFiniteNumbers({ [TAG]: "Infinity", extra: 1 })).toEqual({
      [TAG]: "Infinity",
      extra: 1,
    });
    expect(reviveNonFiniteNumbers({ [TAG]: "nope" })).toEqual({ [TAG]: "nope" });
  });

  test("primitives pass through", () => {
    expect(reviveNonFiniteNumbers(5)).toBe(5);
    expect(reviveNonFiniteNumbers("s")).toBe("s");
    expect(reviveNonFiniteNumbers(null)).toBe(null);
  });

  // Every tool request passes through this walk, so an own "__proto__" key in a
  // valid payload (e.g. a header map) must be preserved as data, not routed to the
  // prototype setter (which would drop it and could pollute the prototype).
  test("an own __proto__ key is preserved as a data property, not the prototype", () => {
    const parsed = JSON.parse('{"headers":{"__proto__":"keep","X-Ok":"1"}}') as {
      headers: Record<string, unknown>;
    };
    const revived = reviveNonFiniteNumbers(parsed) as { headers: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(revived.headers, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(revived.headers, "__proto__")?.value).toBe("keep");
    expect(revived.headers["X-Ok"]).toBe("1");
    // The reconstructed object keeps a normal prototype (no pollution).
    expect(Object.getPrototypeOf(revived.headers)).toBe(Object.prototype);
  });
});
