import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

function count(code: string): number {
  return runRule(plugin.rules["no-raw-env-number-parse"], code).length;
}

// #11629: numeric coercion of an environment value goes through src/utils/envNumbers.ts.
describe("auto-mobile/no-raw-env-number-parse", () => {
  test.each([
    "parseInt(process.env.X, 10)",
    "Number.parseInt(process.env.X, 10)",
    "parseFloat(process.env.X)",
    "Number.parseFloat(process.env.X)",
    "Number(process.env.X)",
    "globalThis.parseInt(process.env.X)",
    "+process.env.X",
    'Number(process.env["X"])',
    "Number(process.env[NAME])",
    "parseInt(Bun.env.X)",
    "Number(env.X)",
    "Number(deps.env.X)",
    "Number(this.env.X)",
    "parseInt(process.env.X ?? '5', 10)",
    "parseInt(process.env.A || process.env.B, 10)",
    "parseInt(process.env.X!, 10)",
    "parseInt(process.env.X as string, 10)",
    "parseInt(process.env.X?.trim() ?? '', 10)",
    "const n = Number(process.env.X) || 5",
    "const n = cond ? Number(process.env.X) : 5",
    "function f(e: NodeJS.ProcessEnv) { return Number(e.X); }",
    "function f(e: ProcessEnv) { return Number(e.X); }",
    "function f(e = process.env) { return Number(e.X); }",
    "const e = process.env; Number(e.X);",
    "const { X } = process.env; Number(X);",
    "const { X = '5' } = process.env; Number(X);",
    "function f() { const raw = process.env.X; return parseInt(raw, 10); }",
    "function f() { const raw = process.env.X?.trim(); return Number(raw); }",
    "function f() { const raw = process.env.A ?? process.env.B; return +raw; }",
    "function f() { let raw; raw = process.env.X; return Number(raw); }",
    "const raw = process.env.X; const f = () => parseFloat(raw);",
    "const raw = process.env.X; const copy = raw; Number(copy)",
  ])("flags %s", (code) => {
    expect(count(code)).toBe(1);
  });

  test.each([
    "readEnvPositiveInteger('X', undefined, { fallback: 5 })",
    "parseInt(options.timeout, 10)",
    "Number(value)",
    "+offset",
    "Number(process.argv[2])",
    "const raw = process.env.X; if (raw === 'true') { run(); }",
    "const raw = process.env.X ?? ''; return raw.length;",
    // reassigned to something that is no longer the environment
    "function f() { let raw = process.env.X; raw = '5'; return Number(raw); }",
    // a parameter of the same name shadows the outer env local
    "const raw = process.env.X; function f(raw: string) { return Number(raw); }",
    "function f(e: Record<string, string>) { return Number(e.X); }",
    "const { X } = config; Number(X);",
    "const x = process.env.X; const n = x ? 1 : 0;",
    "new Date(process.env.X)",
    "Math.max(1, someNumber)",
  ])("does not flag %s", (code) => {
    expect(count(code)).toBe(0);
  });

  test("known blind spots: values that cross a function boundary are not seen", () => {
    expect(count("const raw = readSetting(); parseInt(raw, 10)")).toBe(0);
    expect(count("function read() { return process.env.X; } Number(read())")).toBe(0);
    expect(count("function parse(raw: string) { return Number(raw); } parse(process.env.X)")).toBe(
      0,
    );
    expect(count("const holder = { v: process.env.X }; Number(holder.v)")).toBe(0);
    expect(count("Number(String(process.env.X))")).toBe(0);
    expect(count("[process.env.X].map(Number)")).toBe(0);
    expect(count("function f(e: Readonly<NodeJS.ProcessEnv>) { return Number(e.X); }")).toBe(0);
  });

  test("known false positive: any identifier named env or member named .env is treated as the environment", () => {
    expect(count("const env = { n: '5' }; Number(env.n)")).toBe(1);
    expect(count("const o = { env: { n: 3 } }; Number(o.env.n)")).toBe(1);
  });
});
