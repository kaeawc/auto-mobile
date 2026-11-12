import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarize } from "../../scripts/docs/check-readability";
import {
  analyzeMarkdown,
  annotateLines,
  checkPage,
  formatFinding,
  isPassive,
  parseConfig,
  sectionFor,
  wordsOf,
  type SectionBudget,
} from "../../scripts/docs/readability";

const BUDGET: SectionBudget = {
  name: "using",
  paths: ["docs/using/"],
  maxSentenceWords: 8,
  maxParagraphWords: 20,
  maxPageWords: 30,
  passive: { minSentences: 2, maxRatio: 0.5 },
};

const words = (count: number) => Array.from({ length: count }, (_, i) => `W${i}`).join(" ");

describe("docs readability analysis", () => {
  test("splits paragraphs and list items and keeps their source lines", () => {
    const source = [
      "# Title", // 1
      "", // 2
      "First paragraph here. It wraps", // 3
      "onto a second line.", // 4
      "", // 5
      "- tight item one", // 6
      "- tight item two", // 7
      "  - nested item", // 8
    ].join("\n");
    const blocks = analyzeMarkdown(source);
    expect(blocks.map((block) => [block.line, block.words])).toEqual([
      [3, 9],
      [6, 3],
      [7, 3],
      [8, 2],
    ]);
    expect(blocks[0].sentences.map((sentence) => sentence.line)).toEqual([3, 3]);
  });

  test("reports the line a wrapped sentence starts on", () => {
    const source = ["Short one. A longer", "sentence starts on line one.", "Third one here."];
    const [block] = analyzeMarkdown(source.join("\n"));
    expect(block.sentences.map((sentence) => sentence.line)).toEqual([1, 1, 3]);
  });

  test("ignores code blocks, tables, HTML and headings, and counts a code span as one word", () => {
    const source = [
      "## A heading with many words in it",
      "",
      "```bash",
      "echo this is code that must not count as prose at all",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| many words in a table cell | more |",
      "",
      "<div>raw html words here</div>",
      "",
      "Run `scripts/prepush.sh --changed --timing` now.",
    ].join("\n");
    const blocks = analyzeMarkdown(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ line: 13, words: 3 });
  });

  test("keeps fence, table and setext structure intact while annotating lines", () => {
    const annotated = annotateLines("```\ncode\n```\n\nTitle\n-----\n\n| a |\n|---|\n| b |");
    const lines = annotated.split("\n");
    expect(lines[0]).toBe("```");
    expect(lines[2]).toBe("```");
    expect(lines[5]).toBe("-----");
    expect(lines.slice(7)).toEqual(["| a |", "|---|", "| b |"]);
    expect(lines[1]).not.toBe("code");
  });

  test("counts loose list item paragraphs once and blockquote text as prose", () => {
    const source = "- first item\n\n  second paragraph\n\n> quoted text here";
    expect(analyzeMarkdown(source).map((block) => block.words)).toEqual([2, 2, 3]);
  });

  test("handles CRLF sources", () => {
    expect(analyzeMarkdown("One.\r\n\r\nTwo words.").map((block) => block.line)).toEqual([1, 3]);
  });

  test("detects common passive constructions", () => {
    expect(isPassive(wordsOf("The device is rebooted by the daemon."))).toBe(true);
    expect(isPassive(wordsOf("It was not quickly built."))).toBe(true);
    expect(isPassive(wordsOf("Results are shown below."))).toBe(true);
    expect(isPassive(wordsOf("The daemon reboots the device."))).toBe(false);
    expect(isPassive(wordsOf("The port is open."))).toBe(false);
  });
});

describe("docs readability budgets", () => {
  test("flags long sentences, paragraphs and pages with line numbers", () => {
    const source = [`${words(10)}.`, "", `${words(5)}. ${words(5)}. ${words(5)}. ${words(6)}.`];
    const findings = checkPage("docs/using/x.md", source.join("\n"), BUDGET);
    expect(findings.map((finding) => [finding.line, finding.rule, finding.value])).toEqual([
      [1, "page-length", 31],
      [1, "sentence-length", 10],
      [3, "paragraph-length", 21],
    ]);
    expect(formatFinding(findings[1])).toBe(
      "docs/using/x.md:1: sentence-length: sentence has 10 words (budget 8) [using]",
    );
  });

  test("flags a passive-heavy paragraph only above the ratio and sentence floor", () => {
    const heavy = "Files are copied. Logs are written. The daemon runs.";
    const balanced = "Files are copied. The daemon runs.";
    const single = "Files are copied.";
    const rules = (source: string) =>
      checkPage("docs/using/x.md", source, BUDGET).map((finding) => finding.rule);
    expect(rules(heavy)).toEqual(["passive-paragraph"]);
    expect(rules(balanced)).toEqual([]);
    expect(rules(single)).toEqual([]);
  });

  test("matches the longest section prefix and supports both how-it-works paths", () => {
    const config = parseConfig({
      sections: [
        { ...BUDGET, name: "how-it-works", paths: ["docs/how-it-works/", "docs/design-docs/"] },
        { ...BUDGET, name: "ci", paths: ["docs/design-docs/ci/"] },
      ],
    });
    expect(sectionFor(config, "docs/how-it-works/a.md")?.name).toBe("how-it-works");
    expect(sectionFor(config, "docs/design-docs/a.md")?.name).toBe("how-it-works");
    expect(sectionFor(config, "docs\\design-docs\\ci\\b.md")?.name).toBe("ci");
    expect(sectionFor(config, "docs/faq.md")).toBeUndefined();
  });

  test("rejects malformed budgets with the offending field", () => {
    expect(() => parseConfig({ sections: [] })).toThrow("non-empty sections");
    expect(() => parseConfig({ sections: [{ ...BUDGET, maxPageWords: 0 }] })).toThrow(
      "sections[0].maxPageWords",
    );
    expect(() => parseConfig({ sections: [{ ...BUDGET, paths: ["docs/using"] }] })).toThrow(
      "ending in /",
    );
    expect(() =>
      parseConfig({ sections: [{ ...BUDGET, passive: { minSentences: 2, maxRatio: 2 } }] }),
    ).toThrow("maxRatio must be at most 1");
  });

  test("the committed budgets file covers using, how-it-works and devlog", () => {
    const path = join(import.meta.dir, "..", "..", "scripts", "docs", "readability-budgets.json");
    const config = parseConfig(JSON.parse(readFileSync(path, "utf8")));
    expect(config.sections.map((section) => section.name)).toEqual([
      "using",
      "how-it-works",
      "devlog",
    ]);
    expect(sectionFor(config, "docs/design-docs/x.md")?.name).toBe("how-it-works");
    expect(sectionFor(config, "docs/how-it-works/x.md")?.name).toBe("how-it-works");
  });

  test("summarizes findings per section and rule", () => {
    const config = parseConfig({ sections: [BUDGET] });
    const findings = checkPage("docs/using/x.md", `${words(10)}.`, BUDGET);
    expect(summarize(config, findings)).toEqual(["using: 1 finding(s) (sentence-length=1)"]);
  });
});
