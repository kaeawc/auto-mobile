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
    expect(fires("no-extension-import", 'import x from "./foo.js";')).toBe(true);
  });
  test("flags a .ts extension in a relative import", () => {
    expect(fires("no-extension-import", 'import x from "./foo.ts";')).toBe(true);
  });
  test("does not flag an extensionless relative import", () => {
    expect(fires("no-extension-import", 'import x from "./foo";')).toBe(false);
  });
  test("does not flag a bare package import ending in .js-like text", () => {
    expect(fires("no-extension-import", 'import x from "pkg/sub";')).toBe(false);
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

describe("auto-mobile/no-raw-promise-race", () => {
  test("flags a direct Promise.race call", () => {
    expect(fires("no-raw-promise-race", "Promise.race([first, second]);")).toBe(true);
  });
  test("does not flag a different race method", () => {
    expect(fires("no-raw-promise-race", "coordinator.race([first, second]);")).toBe(false);
  });
});

describe("auto-mobile/no-structured-content-read", () => {
  test("flags reading a field off structuredContent", () => {
    expect(fires("no-structured-content-read", "const m = res.structuredContent.marker;")).toBe(
      true,
    );
  });
  test("does not flag the typed getStructuredField helper", () => {
    expect(
      fires("no-structured-content-read", 'const m = getStructuredField(res, "marker");'),
    ).toBe(false);
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
  test("flags a named class EXPRESSION with an 'Impl' suffix", () => {
    // `const X = class DeviceImpl {}` — the old @typescript-eslint class selector
    // covered class expressions too, so the port must not bypass this syntax.
    expect(fires("naming-convention", "const Adapter = class DeviceImpl { };")).toBe(true);
  });
  test("does not flag a well-named class expression", () => {
    expect(fires("naming-convention", "const Adapter = class Device { };")).toBe(false);
  });
  test("flags an exported iOS class with the IOS prefix", () => {
    expect(fires("naming-convention", "export class IOSCaptureHelper { }; ")).toBe(true);
  });
  test("allows an exported iOS class with the Ios prefix", () => {
    expect(fires("naming-convention", "export class IosCaptureHelper { }; ")).toBe(false);
  });
  test("flags the legacy IOS client name outside its deferred file", () => {
    expect(fires("naming-convention", "export class IOSCtrlProxyClient { }; ")).toBe(true);
  });
  test("allows the deferred IOS client export in its existing file", () => {
    expect(
      runRule(
        plugin.rules["naming-convention"],
        "export class IOSCtrlProxyClient { }",
        "src/features/observe/ios/IOSCtrlProxyClient.ts",
      ),
    ).toHaveLength(0);
  });
});

describe("auto-mobile/max-class-lines", () => {
  const body = (lines: number) =>
    Array.from({ length: lines }, (_, i) => `  m${i}() {}`).join("\n");
  const klass = (lines: number) => `class Big {\n${body(lines)}\n}`;
  const flagged = (code: string, max: number) =>
    runRule(plugin.rules["max-class-lines"], code, "fixture.ts", [{ max }]).length;

  test("flags a class declaration over the cap", () => {
    expect(flagged(klass(6), 5)).toBe(1);
  });
  test("does not flag a class at the cap", () => {
    // class line + 3 members + closing brace = 5 non-blank lines
    expect(flagged(klass(3), 5)).toBe(0);
  });
  test("ignores blank lines", () => {
    expect(flagged(`class Big {\n${body(3).split("\n").join("\n\n\n")}\n}`, 5)).toBe(0);
  });
  test("flags a class expression", () => {
    expect(flagged(`const C = ${klass(6)};`, 5)).toBe(1);
  });
  test("counts each class separately", () => {
    expect(flagged(`${klass(6)}\n${klass(2)}\n${klass(8)}`, 5)).toBe(2);
  });
  test("defaults to a 1000-line cap", () => {
    expect(runRule(plugin.rules["max-class-lines"], klass(10)).length).toBe(0);
    expect(runRule(plugin.rules["max-class-lines"], klass(1000)).length).toBe(1);
  });
});
