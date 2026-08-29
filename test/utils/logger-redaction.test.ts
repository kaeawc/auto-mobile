import { describe, expect, test } from "bun:test";
import { SENSITIVE_ENV_KEYS, safeStringify, sanitizeMessage } from "../../src/utils/logger";

describe("sanitizeMessage prevents log injection", () => {
  test("replaces a newline with a space", () => {
    expect(sanitizeMessage("line1\nline2")).toBe("line1 line2");
  });

  test("replaces a carriage return with a space", () => {
    expect(sanitizeMessage("line1\rline2")).toBe("line1 line2");
  });

  test("replaces a tab with a space", () => {
    expect(sanitizeMessage("col1\tcol2")).toBe("col1 col2");
  });

  test("neutralizes an injected forged log line", () => {
    const forged = "real\n2026-01-01 [ERROR] injected fake entry";
    expect(sanitizeMessage(forged)).toBe("real 2026-01-01 [ERROR] injected fake entry");
    expect(sanitizeMessage(forged)).not.toContain("\n");
  });

  test("leaves already-single-line text unchanged", () => {
    expect(sanitizeMessage("nothing to sanitize here")).toBe("nothing to sanitize here");
  });
});

describe("safeStringify redacts sensitive data", () => {
  test("removes a top-level sensitive key from the output", () => {
    expect(safeStringify({ PASSWORD: "hunter2", user: "bob" })).toBe('{"user":"bob"}');
  });

  test("redacts sensitive keys case-insensitively", () => {
    expect(safeStringify({ password: "x", Token: "y", user: "bob" })).toBe('{"user":"bob"}');
  });

  test("keeps non-sensitive keys intact", () => {
    expect(safeStringify({ user: "bob", count: 3 })).toBe('{"user":"bob","count":3}');
  });

  test("redacts sensitive keys nested inside objects", () => {
    expect(safeStringify({ outer: { TOKEN: "t", ok: 1 } })).toBe('{"outer":{"ok":1}}');
  });

  test("redacts several sensitive keys at once", () => {
    expect(safeStringify({ API_KEY: "a", SECRET: "s", name: "n" })).toBe('{"name":"n"}');
  });

  test("stringifies a number primitive without JSON quoting", () => {
    expect(safeStringify(5)).toBe("5");
  });

  test("stringifies a boolean primitive without JSON quoting", () => {
    expect(safeStringify(true)).toBe("true");
  });

  test("stringifies null as the literal string null", () => {
    expect(safeStringify(null)).toBe("null");
  });

  test("serializes arrays as index-keyed objects (current documented behavior)", () => {
    expect(safeStringify([1, 2, 3])).toBe('{"0":1,"1":2,"2":3}');
  });

  test("replaces circular values without throwing or recursing indefinitely", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(safeStringify(circular)).toBe('{"self":"[circular]"}');
  });

  // Regression: cycle detection tracked every visited object instead of just the
  // ancestor path, so a shared (non-cyclic) child was mis-flagged "[circular]" at
  // its second sibling position, dropping real log data (#5617).
  test("renders a shared child fully at both sibling positions (diamond, not a cycle)", () => {
    const shared = { x: 1 };
    expect(safeStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  test("renders a shared child fully across array elements", () => {
    const shared = { x: 1 };
    // Arrays serialize as index-keyed objects (see above); both entries keep the child.
    expect(safeStringify([shared, shared])).toBe('{"0":{"x":1},"1":{"x":1}}');
  });

  test("still detects a true cycle nested under a shared sibling", () => {
    const shared: { x: number } = { x: 1 };
    const cyclic: { child?: unknown; self?: unknown } = { child: shared };
    cyclic.self = cyclic;
    expect(safeStringify({ a: shared, b: cyclic })).toBe(
      '{"a":{"x":1},"b":{"child":{"x":1},"self":"[circular]"}}',
    );
  });
});

// Issue #5854 §2: the daemon request log serializes non-finite arguments
// (Infinity/-Infinity/NaN) as `null`, because JSON has no representation for
// them, so a caller debugging a rejected non-finite value sees `null` in the
// trace and can't tell what was actually sent. safeStringify must render the
// literal marker instead.
describe("safeStringify preserves non-finite numbers (#5854)", () => {
  test('renders a nested Infinity as the string "Infinity" instead of null', () => {
    expect(safeStringify({ arguments: { duration: Infinity } })).toBe(
      '{"arguments":{"duration":"Infinity"}}',
    );
  });

  test('renders -Infinity as the string "-Infinity"', () => {
    expect(safeStringify({ v: -Infinity })).toBe('{"v":"-Infinity"}');
  });

  test('renders NaN as the string "NaN"', () => {
    expect(safeStringify({ v: NaN })).toBe('{"v":"NaN"}');
  });

  test("leaves finite numbers untouched", () => {
    expect(safeStringify({ a: 0, b: -3.5, c: 1000 })).toBe('{"a":0,"b":-3.5,"c":1000}');
  });

  test("renders a top-level non-finite primitive via String() (unchanged)", () => {
    expect(safeStringify(Infinity)).toBe("Infinity");
  });
});

describe("SENSITIVE_ENV_KEYS", () => {
  test("includes the common secret-bearing environment key names", () => {
    expect(SENSITIVE_ENV_KEYS.has("PASSWORD")).toBe(true);
    expect(SENSITIVE_ENV_KEYS.has("GITHUB_TOKEN")).toBe(true);
    expect(SENSITIVE_ENV_KEYS.has("AWS_SECRET_ACCESS_KEY")).toBe(true);
  });
});
