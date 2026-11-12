import { describe, expect, test } from "bun:test";
import {
  type BannedPhraseRule,
  applyAllowlist,
  findBannedPhrases,
  formatHit,
} from "../../scripts/docs/bannedPhrases";
import list from "../../scripts/docs/banned-phrases.json";

const RULES: BannedPhraseRule[] = list.rules;

function rulesOf(source: string): string[] {
  return findBannedPhrases("docs/x.md", source, RULES).map((hit) => hit.rule);
}

describe("findBannedPhrases", () => {
  test("reports the source line and suggestion of a prose hit", () => {
    const source = "# Title\n\nFirst line.\nWe leverage the daemon.\n";
    const hits = findBannedPhrases("docs/x.md", source, RULES);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 4, rule: "leverage", match: "leverage" });
    expect(formatHit(hits[0])).toBe('docs/x.md:4: [leverage] "leverage" -> use "use"');
  });

  test("ignores fenced, indented and inline code and raw HTML", () => {
    const source = [
      "Plain text.",
      "",
      "```ts",
      "robust(); leverage();",
      "```",
      "",
      "    seamless indented code",
      "",
      "Call `delve()` here.",
      "",
      "<div>robust html</div>",
      "",
    ].join("\n");
    expect(rulesOf(source)).toEqual([]);
  });

  test("finds the prose copy of a word that also appears in earlier code", () => {
    const source = "```\nrobust\n```\n\nA robust retry.\n";
    expect(findBannedPhrases("docs/x.md", source, RULES).map((hit) => hit.line)).toEqual([5]);
  });

  test("matches phrases across emphasis and soft line breaks within a block", () => {
    const source = "It's worth *noting* that\nthis is not only fast but also\nsmall.\n";
    const hits = findBannedPhrases("docs/x.md", source, RULES);
    expect(hits.map((hit) => [hit.rule, hit.line])).toEqual([
      ["worth-noting", 1],
      ["not-only-but-also", 2],
    ]);
  });

  test("does not join phrases across separate blocks", () => {
    expect(rulesOf("It is worth\n\nnoting that x.\n")).toEqual([]);
  });

  test("covers headings, list items, table cells and link text", () => {
    const source = [
      "# Seamless setup",
      "",
      "- delve deeper",
      "",
      "| a |",
      "|---|",
      "| honestly |",
      "",
      "[utilize it](https://example.com)",
      "",
    ].join("\n");
    expect(rulesOf(source).sort()).toEqual(["delve", "honest-hedge", "seamless", "utilize"]);
  });

  test("flags three em dashes in one sentence but allows one aside", () => {
    expect(rulesOf("One — aside — is fine.\n")).toEqual([]);
    expect(rulesOf("A — b — c — d.\n")).toEqual(["stacked-em-dash"]);
  });

  test("matches whole words only", () => {
    expect(rulesOf("Robustly is banned; robustas and delved are matched by stem only.\n")).toEqual([
      "delve",
      "robust",
    ]);
    expect(rulesOf("The leverager and unrobust stay.\n")).toEqual([]);
  });
});

describe("applyAllowlist", () => {
  const hit = (file: string, rule: string, line: number) => ({
    file,
    line,
    rule,
    match: rule,
    suggestion: "s",
  });

  test("covers exactly the allowed count per file and rule", () => {
    const hits = [hit("a.md", "robust", 1), hit("a.md", "robust", 2), hit("b.md", "robust", 3)];
    const result = applyAllowlist(
      hits,
      { entries: [{ file: "a.md", rule: "robust", count: 2, reason: "name" }] },
      RULES,
    );
    expect(result.violations.map((v) => v.file)).toEqual(["b.md"]);
    expect(result.stale).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  test("fails every hit when the file exceeds its allowance", () => {
    const hits = [hit("a.md", "robust", 1), hit("a.md", "robust", 2)];
    const result = applyAllowlist(
      hits,
      { entries: [{ file: "a.md", rule: "robust", count: 1, reason: "name" }] },
      RULES,
    );
    expect(result.violations).toHaveLength(2);
  });

  test("reports stale and invalid entries", () => {
    const result = applyAllowlist(
      [],
      {
        entries: [
          { file: "a.md", rule: "robust", count: 1, reason: "name" },
          { file: "a.md", rule: "robust", count: 1, reason: "dup" },
          { file: "b.md", rule: "nope", count: 0, reason: " " },
        ],
      },
      RULES,
    );
    expect(result.stale.map((entry) => [entry.file, entry.actual])).toEqual([
      ["a.md", 0],
      ["a.md", 0],
    ]);
    expect(result.invalid).toEqual([
      "a.md (robust): duplicate entry",
      "b.md (nope): unknown rule",
      "b.md (nope): count must be a positive integer",
      "b.md (nope): reason is required",
    ]);
  });
});

describe("banned-phrases.json", () => {
  test("every rule has a unique id, a valid pattern and a suggestion", () => {
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);
    for (const rule of RULES) {
      expect(() => new RegExp(rule.pattern, "giu")).not.toThrow();
      expect(rule.suggestion.trim().length).toBeGreaterThan(0);
    }
  });
});
