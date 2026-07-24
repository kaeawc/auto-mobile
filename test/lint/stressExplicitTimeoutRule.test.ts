import { describe, expect, test } from "bun:test";
import { ESLint } from "eslint";

const MISSING_TIMEOUT = "declares no explicit timeout";
const TIMEOUT_TOO_SMALL = "is not enough headroom";

// The rule is scoped to `test/stress/**`, so snippets must lint under a path in
// that directory or the rule never runs.
const STRESS_FIXTURE = "test/stress/fixture.stress.test.ts";

async function lintSnippet(code: string, filePath = STRESS_FIXTURE): Promise<string[]> {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: "eslint.config.mjs",
    // Same rationale as bareExpectRule.test.ts: these snippets live at paths that
    // do not exist on disk, so opt out of the type-aware config that would make
    // projectService reject them.
    overrideConfig: {
      languageOptions: { parserOptions: { projectService: false, project: null } },
      rules: {
        "@typescript-eslint/no-floating-promises": "off",
        "@typescript-eslint/no-misused-promises": "off",
      },
    },
    fix: false,
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map(message => message.message);
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

  // `test.todo("name")` has no body to time out, and `test.each` takes a table
  // rather than a name+body pair. Neither is the shape the rule is about.
  test("does not flag declarations with no test body", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test.todo("not written yet");
`);
    expect(matches(messages, MISSING_TIMEOUT)).toBe(false);
    expect(matches(messages, TIMEOUT_TOO_SMALL)).toBe(false);
  });

  // AC4 is scoped: the rest of the suite is thousands of sub-100ms unit tests
  // where a mandatory timeout literal would be noise. Only stress tests, whose
  // runtime is inherently unbounded, carry the requirement.
  test("does not flag tests outside test/stress", async () => {
    const messages = await lintSnippet(`import { test } from "bun:test";
test("ordinary unit test", () => {
  const x = 1;
  if (x !== 1) { throw new Error("unreachable"); }
});
`, "test/features/ordinary.test.ts");
    expect(matches(messages, MISSING_TIMEOUT)).toBe(false);
  });
});
