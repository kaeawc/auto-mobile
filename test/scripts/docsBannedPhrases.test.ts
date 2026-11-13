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

describe("findBannedPhrases source lines", () => {
  const linesOf = (source: string) =>
    findBannedPhrases("docs/x.md", source, RULES).map((hit) => [hit.rule, hit.line]);

  test("skips a link reference definition that contains the phrase", () => {
    expect(linesOf("[ref]: /robust\n\nrobust\n")).toEqual([["robust", 3]]);
  });

  test("skips definition labels, titles and multi-line definitions", () => {
    const source = [
      '[robust]: /robust "robust title"',
      "[seamless]:",
      "  /seamless",
      "  'seamless title'",
      "",
      "See [robust] and [seamless].",
      "",
    ].join("\n");
    expect(linesOf(source)).toEqual([
      ["robust", 6],
      ["seamless", 6],
    ]);
  });

  test("still searches definition look-alikes that md4c renders", () => {
    const source = "```\n[robust]: /x\n```\n\nText\n[robust]: /y\n\nrobust\n";
    expect(linesOf(source)).toEqual([
      ["robust", 6],
      ["robust", 8],
    ]);
  });

  test("reports each repeated phrase on its own line", () => {
    expect(linesOf("robust\n\nA robust\nrobust line.\n\n- robust\n")).toEqual([
      ["robust", 1],
      ["robust", 3],
      ["robust", 4],
      ["robust", 6],
    ]);
  });

  test("keeps words on either side of a soft line break apart", () => {
    expect(linesOf("A foldable\nseamless fold.\n")).toEqual([["seamless", 2]]);
  });

  test("does not double the space around a newline inside link syntax", () => {
    expect(linesOf("It's [worth](\n/url) noting.\n")).toEqual([["worth-noting", 1]]);
    expect(linesOf("*robust*\nrobust\n")).toEqual([
      ["robust", 1],
      ["robust", 2],
    ]);
  });

  test("skips a reference definition whose title spans four or more lines", () => {
    const source = ["[ref]: /url 'one", "two", "three", "robust'", "", "robust", ""].join("\n");
    expect(linesOf(source)).toEqual([["robust", 6]]);
  });

  test("never blanks a paragraph that only starts like a definition", () => {
    expect(linesOf("[ref]: /url nope\nA robust\n")).toEqual([["robust", 2]]);
    expect(linesOf("[ref]: /url nope\none\ntwo\nA robust\n")).toEqual([["robust", 4]]);
  });

  test("a newline inside link syntax is not a prose break", () => {
    // md4c renders "It's worthnoting.": the newline sits in the destination.
    expect(linesOf("It's [worth](\n/url)noting.\n")).toEqual([]);
    expect(linesOf("It's [worth](/url\n'title')noting.\n")).toEqual([]);
    expect(linesOf("It's [worth](/url)\nnoting.\n")).toEqual([["worth-noting", 1]]);
  });

  test("does not locate prose inside an inline link destination or title", () => {
    expect(linesOf("[ok](/robust)\nrobust\n")).toEqual([["robust", 2]]);
    expect(linesOf('[ok](</a (robust)> "robust")\nrobust\n')).toEqual([["robust", 2]]);
    expect(linesOf("[**ok**](/robust)\nrobust\n")).toEqual([["robust", 2]]);
    expect(linesOf("![ok](/robust.png)\nrobust\n")).toEqual([["robust", 2]]);
    expect(linesOf("[ok][ref] robust\n\n[ref]: /url\n")).toEqual([["robust", 1]]);
  });

  test("a quote inside a parenthesized link title does not open a quoted title", () => {
    expect(linesOf("[ok](/url (a 'b))\nrobust\n")).toEqual([["robust", 2]]);
    expect(linesOf("[ok](/url (robust 'b))\nrobust\n")).toEqual([["robust", 2]]);
    expect(linesOf("It's [worth](/url (a 'b)) noting.\n")).toEqual([["worth-noting", 1]]);
  });

  test("skips every multi-line reference definition form", () => {
    expect(linesOf('[ref]:\n  /robust\n  "robust\n  robust"\n\nrobust\n')).toEqual([["robust", 6]]);
    expect(linesOf("[robust\nlabel]: /url\n\nrobust\n")).toEqual([["robust", 4]]);
    expect(linesOf("[ref]: </a robust>\n  'robust'\nrobust\n")).toEqual([["robust", 3]]);
  });

  test("does not locate prose inside a full reference link label", () => {
    expect(linesOf("[ok][robust]\nrobust\n\n[robust]: /url\n")).toEqual([["robust", 2]]);
    expect(linesOf("[robust][robust]\n\n[robust]: /url\n")).toEqual([["robust", 1]]);
  });

  test("an escaped > inside an angle-bracket destination does not end it", () => {
    expect(linesOf("[ok](<a\\>b(c>)\nrobust\n")).toEqual([["robust", 2]]);
    expect(linesOf("[ok](<a\\>robust(c>)\nrobust\n")).toEqual([["robust", 2]]);
  });

  test("checks 600 definition-like lines in a code block in under 100 ms", () => {
    const lines = Array.from({ length: 600 }, () => "[x]: /u").join("\n");
    const started = performance.now();
    expect(linesOf(`\`\`\`\n${lines}\n\`\`\`\n\nrobust\n`)).toEqual([["robust", 604]]);
    expect(linesOf(`<div>\n${lines}\n</div>\n\nrobust\n`)).toEqual([["robust", 604]]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("joins strikethrough text with the surrounding prose", () => {
    expect(linesOf("It's worth ~~noting~~ that.\n")).toEqual([["worth-noting", 1]]);
  });

  test("keeps a soft break that ends a text node before a link", () => {
    expect(linesOf("It's worth\n[noting](/u) that.\n")).toEqual([["worth-noting", 1]]);
  });

  test("joins words across CRLF and CR soft breaks with a space", () => {
    expect(linesOf("Intro.\r\n\r\nWe run it in order\r\nto test.\r\nrobust\r\n")).toEqual([
      ["in-order-to", 3],
      ["robust", 5],
    ]);
    expect(linesOf("Intro.\r\rWe run it in order\rto test.\rrobust\r")).toEqual([
      ["in-order-to", 3],
      ["robust", 5],
    ]);
  });

  test("a decoded &#10; character reference does not advance the source line", () => {
    expect(linesOf("a&#10;robust and &#xA;&NewLine;in order&#13;to\nseamless\n")).toEqual([
      ["in-order-to", 1],
      ["robust", 1],
      ["seamless", 2],
    ]);
    expect(linesOf("![a&#10;robust\nseamless](/u)\n")).toEqual([
      ["robust", 1],
      ["seamless", 2],
    ]);
    expect(linesOf("Text \\&#10;\nrobust\n")).toEqual([["robust", 2]]);
  });

  test("locates front matter prose and the body after it", () => {
    expect(linesOf("---\ntitle: robust\n---\n\nrobust\n")).toEqual([
      ["robust", 2],
      ["robust", 5],
    ]);
  });
});
