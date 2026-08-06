import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

const MISSING_TIMEOUT = "declares no explicit timeout";
const TIMEOUT_TOO_SMALL = "is not enough headroom";

function lintSnippet(code: string): string[] {
  return runRule(plugin.rules["stress-explicit-timeout"], code);
}

function matches(messages: string[], fragment: string): boolean {
  return messages.some(message => message.includes(fragment));
}

describe("auto-mobile/stress-explicit-timeout", () => {
  // AC1 — the exact shape from issue #4342: a long stress loop that never
  // declares a timeout and therefore silently inherits bun's 5000ms default.
  test("flags a stress test that declares no timeout", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test("high-frequency loop", async () => {
  await Promise.resolve();
});
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(true);
  });

  // AC2 — a declared timeout with no headroom over the observed 5015ms failure
  // is the same coin flip with extra steps, so a stated-but-tight deadline must
  // fail too rather than read as compliance.
  test("flags a declared timeout with no headroom over the observed failure", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test("high-frequency loop", async () => {
  await Promise.resolve();
}, 5_000);
`);
    expect(matches(messages, TIMEOUT_TOO_SMALL)).toBe(true);
  });

  test("accepts a timeout with real headroom", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test("high-frequency loop", async () => {
  await Promise.resolve();
}, 30_000);
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(false);
    expect(matches(messages, TIMEOUT_TOO_SMALL)).toBe(false);
  });

  // `it` is bun's alias for `test`; the invariant is about the test body's
  // deadline, not which spelling declared it.
  test("flags an it() stress test with no timeout", async () => {
    const messages = await lintSnippet(`import { it } from "bun:test";
it("high-frequency loop", async () => {
  await Promise.resolve();
});
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(true);
  });

  // A non-literal timeout cannot be checked statically. Requiring a literal
  // keeps the deadline readable at the call site, which is the whole point.
  test("flags a timeout that is not a numeric literal", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
const LIMIT = 30_000;
test("high-frequency loop", async () => {
  await Promise.resolve();
}, LIMIT);
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(true);
  });

  // `test.todo("name")` has no body to time out. `.skip`/`.todo` never run a body,
  // so they carry no per-test deadline and must not be flagged.
  test("does not flag declarations with no test body", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test.todo("not written yet");
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(false);
    expect(matches(messages, TIMEOUT_TOO_SMALL)).toBe(false);
  });

  test("does not flag test.skip with no timeout", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test.skip("skipped", async () => {
  await Promise.resolve();
});
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(false);
    expect(matches(messages, TIMEOUT_TOO_SMALL)).toBe(false);
  });

  // Runnable chained forms execute a body and so inherit the same 5000ms default.
  // `test.only` is the escape hatch a developer reaches for while debugging one
  // stress case — exactly when the flake would bite — so it must be covered too.
  test("flags test.only with no timeout", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test.only("only this one", async () => {
  await Promise.resolve();
});
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(true);
  });

  // `it.each(table)(name, fn, timeout)` is the realistic shape for a parametrized
  // stress load. The callee is a curried CallExpression, not a bare identifier, but
  // the body/timeout still sit at arg positions 1/2, so the rule applies.
  test("flags it.each with no timeout", async () => {
    const messages = await lintSnippet(`import { it } from "bun:test";
it.each([1, 2, 3])("load %i", async () => {
  await Promise.resolve();
});
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(true);
  });

  test("accepts test.concurrent.each with real headroom", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test.concurrent.each([1, 2])("load %i", async () => {
  await Promise.resolve();
}, 30_000);
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(false);
    expect(matches(messages, TIMEOUT_TOO_SMALL)).toBe(false);
  });

  // AC4 is scoped: the rest of the suite is thousands of sub-100ms unit tests
  // where a mandatory timeout literal would be noise. Only stress tests, whose
  // runtime is inherently unbounded, carry the requirement. That scoping now
  // lives in .oxlintrc.json's `test/stress/**` override and is asserted in
  // oxlintConfigScoping.test.ts rather than against the rule in isolation.
});
