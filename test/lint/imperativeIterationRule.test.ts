import { describe, expect, test } from "bun:test";
import { ESLint } from "eslint";

const FOR_IN = "Avoid for-in";
const ACCUMULATION = "This .forEach() only builds a collection by mutation";

async function lintSnippet(code: string, filePath = "src/imperativeIterationFixture.ts"): Promise<string[]> {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: "eslint.config.mjs",
    // Same rationale as errorHandlingConvention.test.ts: these snippets live at
    // src/ paths that do not exist on disk, so opt out of the type-aware config
    // that would make projectService reject them.
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
  return messages.some(message => message.startsWith(fragment));
}

describe("auto-mobile/no-imperative-iteration", () => {
  test("flags for-in", async () => {
    const messages = await lintSnippet(`export function probe(o: Record<string, number>): void {
  for (const key in o) {
    console.log(key);
  }
}
`);
    expect(matches(messages, FOR_IN)).toBe(true);
  });

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

  test("does not apply outside src/", async () => {
    const messages = await lintSnippet(`export function probe(o: Record<string, number>): void {
  for (const key in o) {
    console.log(key);
  }
}
`, "test/imperativeIterationFixture.test.ts");
    expect(matches(messages, FOR_IN)).toBe(false);
  });

  // Regression guard for the suppression-budget leak this rule exists to avoid:
  // these selectors must NOT live in no-restricted-syntax, whose per-file count
  // is shared with the setTimeout/structuredContent bans (main carries zero
  // no-restricted-syntax suppressions, and that must stay true).
  test("keeps iteration bans out of the shared no-restricted-syntax budget", async () => {
    const messages = await lintSnippet(`export function probe(o: Record<string, number>): void {
  for (const key in o) {
    console.log(key);
  }
}
`);
    const forInMessages = messages.filter(message => message.startsWith(FOR_IN));
    expect(forInMessages).toHaveLength(1);
    // The Timer ban is a no-restricted-syntax rule and must still be separate.
    expect(matches(messages, "Use Timer.setTimeout()")).toBe(false);
  });
});
