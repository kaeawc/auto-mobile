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
});

describe("SENSITIVE_ENV_KEYS", () => {
  test("includes the common secret-bearing environment key names", () => {
    expect(SENSITIVE_ENV_KEYS.has("PASSWORD")).toBe(true);
    expect(SENSITIVE_ENV_KEYS.has("GITHUB_TOKEN")).toBe(true);
    expect(SENSITIVE_ENV_KEYS.has("AWS_SECRET_ACCESS_KEY")).toBe(true);
  });
});
