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
});
