import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

const BARE_EXPECT = "`expect(...)` with no matcher chained";

function lintSnippet(code: string): string[] {
  return runRule(plugin.rules["no-bare-expect"], code);
}

function matches(messages: string[], fragment: string): boolean {
  return messages.some((message) => message.startsWith(fragment));
}

describe("auto-mobile/no-bare-expect", () => {
  // AC #3 — the gate must be proven to fire. A bare `expect(x);` statement with
  // no matcher chained asserts nothing and can never fail; it must be flagged.
  test("flags a bare expect() statement with no matcher", async () => {
    const messages = await lintSnippet(`import { expect, test } from "bun:test";
test("dead", () => {
  const x = 1;
  expect(x);
});
`);
    expect(matches(messages, BARE_EXPECT)).toBe(true);
  });

  // The exact inert shape from the issue: object passed as arg 2 with no matcher.
  test("flags a bare expect(actual, expected) statement", async () => {
    const messages = await lintSnippet(`import { expect, test } from "bun:test";
test("dead", () => {
  const users = [{ userId: 0 }];
  expect(users[0], { userId: 0 });
});
`);
    expect(matches(messages, BARE_EXPECT)).toBe(true);
  });

  // AC #4 — a labeled assertion is legitimate: bun honours arg 2 as a label and
  // the matcher still runs. The rule targets the MISSING matcher, not arity, so
  // it must NOT flag this.
  test("does not flag a labeled assertion with a matcher chained", async () => {
    const messages = await lintSnippet(`import { expect, test } from "bun:test";
test("live", () => {
  const x = 1;
  expect(x, "label").toBe(1);
});
`);
    expect(matches(messages, BARE_EXPECT)).toBe(false);
  });

  test("does not flag a plain chained assertion", async () => {
    const messages = await lintSnippet(`import { expect, test } from "bun:test";
test("live", () => {
  const x = 1;
  expect(x).toBe(1);
});
`);
    expect(matches(messages, BARE_EXPECT)).toBe(false);
  });

  // A bare expect used as a value (not a statement) — e.g. building a matcher —
  // is not the inert-statement foot-gun and must not be flagged.
  test("does not flag expect() used as a sub-expression", async () => {
    const messages = await lintSnippet(`import { expect, test } from "bun:test";
test("live", () => {
  const x = 1;
  const assertion = expect(x);
  assertion.toBe(1);
});
`);
    expect(matches(messages, BARE_EXPECT)).toBe(false);
  });
});
