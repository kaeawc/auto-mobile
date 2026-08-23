import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

// Backstop for auto-mobile/no-inline-error-normalize: the inline message-only
// idiom `X instanceof Error ? X.message : String(X)` must be flagged so it is
// replaced by the canonical errorMessage(X) helper (issue #5457).

function fires(code: string): boolean {
  return runRule(plugin.rules["no-inline-error-normalize"], code).length > 0;
}

describe("auto-mobile/no-inline-error-normalize", () => {
  test("flags the exact inline idiom with identifier `error`", () => {
    expect(fires("const m = error instanceof Error ? error.message : String(error);")).toBe(true);
  });

  test("flags the idiom with a different identifier (`e`)", () => {
    expect(fires("const m = e instanceof Error ? e.message : String(e);")).toBe(true);
  });

  test("does not flag when the tested identifier differs from the branches", () => {
    expect(fires("const m = a instanceof Error ? b.message : String(c);")).toBe(false);
  });

  test("does not flag the richer .stack variant", () => {
    expect(fires("const m = error instanceof Error ? error.stack || error.message : String(error);")).toBe(false);
  });

  test("does not flag the `: new Error(String(x))` fallback variant", () => {
    expect(fires("const m = error instanceof Error ? error : new Error(String(error));")).toBe(false);
  });

  test("does not flag a call to the errorMessage helper", () => {
    expect(fires("const m = errorMessage(error);")).toBe(false);
  });

  test("does not flag a different property than .message", () => {
    expect(fires("const m = error instanceof Error ? error.name : String(error);")).toBe(false);
  });

  test("flags a member-expression subject (`result.error`)", () => {
    expect(
      fires("const m = result.error instanceof Error ? result.error.message : String(result.error);"),
    ).toBe(true);
  });

  test("flags a `this`-rooted member subject", () => {
    expect(
      fires("const m = this.err instanceof Error ? this.err.message : String(this.err);"),
    ).toBe(true);
  });

  test("does not flag when member subjects differ across positions", () => {
    expect(
      fires("const m = a.error instanceof Error ? b.error.message : String(a.error);"),
    ).toBe(false);
  });

  test("flags a numeric index-access subject (`errors[0]`)", () => {
    expect(
      fires("const m = errors[0] instanceof Error ? errors[0].message : String(errors[0]);"),
    ).toBe(true);
  });

  test("flags the bracket-notation `[\"message\"]` spelling", () => {
    expect(
      fires('const m = error instanceof Error ? error["message"] : String(error);'),
    ).toBe(true);
  });

  test("does not conflate a string-literal index with an identifier index", () => {
    // errors["i"] and errors[i] can reference different values — not equivalent.
    expect(
      fires('const m = errors["i"] instanceof Error ? errors[i].message : String(errors["i"]);'),
    ).toBe(false);
  });

  test("does not flag a computed identifier key `[message]` (a different variable)", () => {
    expect(
      fires("const m = error instanceof Error ? error[message] : String(error);"),
    ).toBe(false);
  });

  test("flags mixed numeric/string index spellings of the same property", () => {
    // errors[0] and errors["0"] resolve to the same property in JavaScript.
    expect(
      fires('const m = errors[0] instanceof Error ? errors["0"].message : String(errors[0]);'),
    ).toBe(true);
  });

  test("flags mixed dot/bracket spellings of the same property", () => {
    expect(
      fires('const m = result.error instanceof Error ? result["error"].message : String(result.error);'),
    ).toBe(true);
  });

  test("does not collide a literal key containing serializer delimiters with a member chain", () => {
    // a["b.prop:c"] and a.b.c are different references; the structural key must keep them apart.
    expect(
      fires('const m = a["b.prop:c"] instanceof Error ? a.b.c.message : String(a["b.prop:c"]);'),
    ).toBe(false);
  });

  // Issue #5505, deferred edge case 3: transparent TS/chain wrappers
  // (`error!`, `error?.message`) must be unwrapped so these spellings are not
  // false negatives that evade the recurrence guard.

  test("flags a non-null-asserted subject across all three positions", () => {
    expect(
      fires("const m = error! instanceof Error ? error!.message : String(error!);"),
    ).toBe(true);
  });

  test("flags a non-null assertion appearing in only one position", () => {
    // `error!` erases to `error` at runtime, so the reference is the same.
    expect(
      fires("const m = error instanceof Error ? error!.message : String(error);"),
    ).toBe(true);
  });

  test("flags an optional-chained `.message` consequent", () => {
    expect(
      fires("const m = error instanceof Error ? error?.message : String(error);"),
    ).toBe(true);
  });

  test("flags a non-null-asserted member subject (`result.error!`)", () => {
    expect(
      fires("const m = result.error! instanceof Error ? result.error!.message : String(result.error!);"),
    ).toBe(true);
  });

  test("flags an optional-chained member subject (`result?.error`)", () => {
    expect(
      fires("const m = result?.error instanceof Error ? result?.error.message : String(result?.error);"),
    ).toBe(true);
  });

  test("still does not flag a wrapped subject when branches reference a different var", () => {
    expect(
      fires("const m = a! instanceof Error ? b!.message : String(c!);"),
    ).toBe(false);
  });
});
