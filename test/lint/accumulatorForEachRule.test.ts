import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

const ACCUMULATION = "This .forEach() only builds a collection by mutation";

function lintSnippet(code: string): string[] {
  return runRule(plugin.rules["no-accumulator-foreach"], code);
}

function matches(messages: string[], fragment: string): boolean {
  return messages.some((message) => message.startsWith(fragment));
}

describe("auto-mobile/no-accumulator-foreach", () => {
  test("flags a forEach whose body only pushes", async () => {
    const messages = await lintSnippet(`export function probe(xs: string[]): string[] {
  const out: string[] = [];
  xs.forEach(x => {
    out.push(x);
  });
  return out;
}
`);
    expect(matches(messages, ACCUMULATION)).toBe(true);
  });

  test("flags a concise-arrow accumulation into a Set", async () => {
    const messages = await lintSnippet(`export function probe(xs: string[]): Set<string> {
  const seen = new Set<string>();
  xs.forEach(x => seen.add(x));
  return seen;
}
`);
    expect(matches(messages, ACCUMULATION)).toBe(true);
  });

  // The narrowing that keeps this rule honest: a forEach that does real work has
  // no declarative equivalent, and rewriting it to for-of would be MORE
  // imperative. Those must not be flagged.
  test("allows a forEach that logs rather than accumulates", async () => {
    const messages = await lintSnippet(`export function probe(xs: string[]): void {
  xs.forEach(x => {
    console.log(x);
  });
}
`);
    expect(matches(messages, ACCUMULATION)).toBe(false);
  });

  test("allows a forEach that branches before accumulating", async () => {
    const messages = await lintSnippet(`export function probe(xs: string[]): string[] {
  const out: string[] = [];
  xs.forEach(x => {
    if (x.length > 2) {
      out.push(x);
    }
  });
  return out;
}
`);
    expect(matches(messages, ACCUMULATION)).toBe(false);
  });

  // Explicit loops are deliberately allowed. The rule nudges toward declarative
  // style where a clean declarative form exists; it does not outlaw iteration.
  test("allows every explicit loop form", async () => {
    const messages =
      await lintSnippet(`export function probe(o: Record<string, number>, xs: number[]): number {
  let n = 0;
  for (const key in o) {
    n += o[key];
  }
  for (const x of xs) {
    n += x;
  }
  for (let i = 0; i < xs.length; i++) {
    n += xs[i];
  }
  while (n > 1000) {
    n -= 1;
  }
  return n;
}
`);
    expect(messages).toEqual([]);
  });

  // Regression guard for the suppression-budget leak this rule exists to avoid:
  // the forEach ban must NOT live in no-restricted-syntax, whose per-file
  // suppression count is shared with the setTimeout/structuredContent bans (main
  // carries zero no-restricted-syntax suppressions, and that must stay true).
  test("keeps the forEach ban out of the shared no-restricted-syntax budget", async () => {
    const messages = await lintSnippet(`export function probe(xs: string[]): string[] {
  const out: string[] = [];
  xs.forEach(x => {
    out.push(x);
  });
  return out;
}
`);
    expect(messages.filter((message) => message.startsWith(ACCUMULATION))).toHaveLength(1);
    // The Timer ban is a no-restricted-syntax rule and must still be separate.
    expect(matches(messages, "Use Timer.setTimeout()")).toBe(false);
  });
});
