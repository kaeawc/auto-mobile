import { describe, expect, test } from "bun:test";
import {
  canonicalSummaries,
  leadClause,
  scanMarkdown,
  type Violation,
} from "../../scripts/docs/check-docs-tool-names";

const TOOLS = canonicalSummaries([
  { name: "tapOn", description: "Tap an element by text; use sibling for adjacent controls." },
  { name: "observe", description: "Get the screen hierarchy. More detail follows." },
  { name: "dragAndDrop", description: "Drag and drop element." },
  { name: "swipeOn", description: "Swipe on screen or elements." },
]);

function scan(markdown: string): Violation[] {
  return scanMarkdown(markdown, TOOLS);
}

function rules(markdown: string): string[] {
  return scan(markdown).map((violation) => violation.rule);
}

describe("leadClause", () => {
  test("stops at the first sentence or semicolon", () => {
    expect(leadClause("Tap an element by text; use sibling.")).toBe("Tap an element by text");
    expect(leadClause("Kill device")).toBe("Kill device");
  });

  test("keeps a short colon prefix and drops bracketed asides", () => {
    expect(leadClause("Android: record a trace (sched, gfx). start returns an id.")).toBe(
      "Android: record a trace",
    );
    expect(leadClause("Deprecated: use another tool; it is removed later.")).toBe(
      "Deprecated: use another tool",
    );
  });

  test("ignores boundaries inside brackets, backticks and after e.g.", () => {
    expect(leadClause("Rotate the crown (1 = one turn; 0.25 is small) by delta. Next.")).toBe(
      "Rotate the crown by delta",
    );
    expect(leadClause("Send a broadcast, e.g. to toggle a flag. Next.")).toBe(
      "Send a broadcast, e.g. to toggle a flag",
    );
    expect(leadClause("Write `a.b: c` to a file. Next.")).toBe("Write `a.b: c` to a file");
  });
});

describe("tool name rules", () => {
  test("exact names in backticks or <code> pass", () => {
    expect(scan("Call `tapOn`, then <code>observe</code>, or `startDevice`.")).toEqual([]);
  });

  test("a camelCase tool name in prose must be inline code", () => {
    expect(scan("Call tapOn's handler.")).toEqual([
      { rule: "backticks", message: "tapOn in prose should be `tapOn`" },
    ]);
    expect(rules("# tapOn\n\n[tapOn](x.md) and **tapOn**")).toEqual([
      "backticks",
      "backticks",
      "backticks",
    ]);
  });

  test("all-lowercase names and paths in prose are not tool mentions", () => {
    expect(scan("Then observe the screen. See src/tapOn.ts and docs/tapOn-guide.")).toEqual([]);
  });

  test("code fences, indented code and HTML blocks are out of scope", () => {
    expect(scan("```ts\ntapOn()\n```\n\n    tapOn\n\n<div>tapOn</div>\n")).toEqual([]);
  });

  test("wrong casing is reported in code and in camelCase prose", () => {
    expect(scan("Use `tapon` or `Observe`.")).toEqual([
      { rule: "casing", message: "`tapon` should be `tapOn`" },
    ]);
    expect(rules("Use tapON here. A MediaSession or multitouch digitizer is fine.")).toEqual([
      "casing",
    ]);
    expect(scan("The adb `draganddrop` subcommand.")).toEqual([]);
  });

  test("lowerCamel code called a tool must be a registered tool", () => {
    expect(scan("The `tapElement` tool and the `uinput` tool.")).toEqual([
      { rule: "real-tool", message: "`tapElement` is called a tool but is not a registered tool" },
    ]);
  });
});

describe("tool tables", () => {
  const index = (cell: string, summary: string) =>
    `| Tool | What it does |\n| --- | --- |\n| ${cell} | ${summary} |\n`;

  test("an index row names a real tool with its canonical summary", () => {
    expect(scan(index("👆 <code>tapOn</code>", "Tap an element by text"))).toEqual([]);
    expect(scan(index("[`observe`](o.md)", "Get the screen hierarchy."))).toEqual([]);
  });

  test("an index row with another summary or an unknown tool fails", () => {
    expect(scan(index("`tapOn`", "Tap things"))).toEqual([
      { rule: "summary", message: "`tapOn` summary should be: Tap an element by text" },
    ]);
    expect(rules(index("`tapper`", "Taps"))).toEqual(["real-tool"]);
  });

  test("an index row without code markup is checked and flagged as unformatted", () => {
    expect(scan(index("observe", "Totally wrong summary"))).toEqual([
      { rule: "backticks", message: "tool table cell observe should be `observe`" },
      { rule: "summary", message: "`observe` summary should be: Get the screen hierarchy" },
    ]);
    expect(rules(index("tapper", "Unregistered tool"))).toEqual(["backticks", "real-tool"]);
    expect(rules(index("👀 observe", "Get the screen hierarchy"))).toEqual(["backticks"]);
    expect(scan(index(" ", "Tap an element by text"))).toEqual([]);
  });

  test("other Tool tables only check a leading lowerCamel name", () => {
    const table = (cell: string) => `| Tool | Result |\n| --- | --- |\n| ${cell} | Pass |\n`;
    expect(scan(table("`swipeOn` with `lookFor`"))).toEqual([]);
    expect(scan(table("`outline`"))).toEqual([]);
    expect(scan(table("IME `doneKey`"))).toEqual([]);
    expect(rules(table("`swipeOn` with `lookFor`").replace("swipeOn", "tapElement"))).toEqual([
      "real-tool",
    ]);
  });
});
