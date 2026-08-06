import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

// Coverage for the custom rules that do not have a dedicated backstop file, so
// that a typo or an incompatible AST shape in oxlint-plugins/auto-mobile.mjs
// fails a test rather than silently disabling the ported enforcement.

function fires(rule: string, code: string): boolean {
  return runRule(plugin.rules[rule], code).length > 0;
}

describe("auto-mobile/no-unknown-cast", () => {
  test("flags a double `as unknown as T` assertion", () => {
    expect(fires("no-unknown-cast", "const x = (a as unknown as string);")).toBe(true);
  });
  test("does not flag a plain single assertion", () => {
    expect(fires("no-unknown-cast", "const x = (a as string);")).toBe(false);
  });
});

describe("auto-mobile/no-extension-import", () => {
  test("flags a .js extension in a relative import", () => {
    expect(fires("no-extension-import", "import x from \"./foo.js\";")).toBe(true);
  });
  test("flags a .ts extension in a relative import", () => {
    expect(fires("no-extension-import", "import x from \"./foo.ts\";")).toBe(true);
  });
  test("does not flag an extensionless relative import", () => {
    expect(fires("no-extension-import", "import x from \"./foo\";")).toBe(false);
  });
  test("does not flag a bare package import ending in .js-like text", () => {
    expect(fires("no-extension-import", "import x from \"pkg/sub\";")).toBe(false);
  });
});

describe("auto-mobile/no-raw-timer", () => {
  test("flags a bare setTimeout call", () => {
    expect(fires("no-raw-timer", "setTimeout(fn, 1);")).toBe(true);
  });
  test("flags a bare setInterval call", () => {
    expect(fires("no-raw-timer", "setInterval(fn, 1);")).toBe(true);
  });
  test("does not flag a Timer.setTimeout member call", () => {
    expect(fires("no-raw-timer", "Timer.setTimeout(fn, 1);")).toBe(false);
  });
});

describe("auto-mobile/no-structured-content-read", () => {
  test("flags reading a field off structuredContent", () => {
    expect(fires("no-structured-content-read", "const m = res.structuredContent.marker;")).toBe(true);
  });
  test("does not flag the typed getStructuredField helper", () => {
    expect(fires("no-structured-content-read", "const m = getStructuredField(res, \"marker\");")).toBe(false);
  });
});

describe("auto-mobile/naming-convention", () => {
  test("flags an interface with an 'I' prefix", () => {
    expect(fires("naming-convention", "interface IFoo { a: number; }")).toBe(true);
  });
  test("flags an interface with an 'Interface' suffix", () => {
    expect(fires("naming-convention", "interface FooInterface { a: number; }")).toBe(true);
  });
  test("does not flag a plain PascalCase interface", () => {
    expect(fires("naming-convention", "interface Foo { a: number; }")).toBe(false);
  });
  test("flags a class with an 'Impl' suffix", () => {
    expect(fires("naming-convention", "class BarImpl { }")).toBe(true);
  });
  test("does not flag a plain PascalCase class", () => {
    expect(fires("naming-convention", "class Bar { }")).toBe(false);
  });
});
