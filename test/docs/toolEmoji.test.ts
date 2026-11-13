import { describe, expect, test } from "bun:test";
import catalog from "../../schemas/tool-definitions.json";
import {
  checkDoc,
  findToolEmojiReferences,
  missingFromToolsPage,
  registryProblems,
} from "../../scripts/docs/check-tool-emoji";
import { TOOL_ANNOTATIONS } from "../../src/server/toolAnnotations";
import { TOOL_EMOJI, toolPage, TOOLS_PAGE } from "../../src/server/toolEmoji";

const registry = {
  observe: { emoji: ["👁️"], page: "docs/using/observe.md" },
  tapOn: { emoji: ["👆"] },
  launchApp: { emoji: ["🚀"] },
} as const;

describe("tool emoji registry", () => {
  test("covers every registered tool and nothing else", () => {
    expect(Object.keys(TOOL_EMOJI).sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    expect(catalog.map((tool) => tool.name).filter((name) => !(name in TOOL_EMOJI))).toEqual([]);
  });

  test("gives each tool one or two emoji that no other tool uses", () => {
    expect(registryProblems()).toEqual([]);
  });

  test("defaults a tool's page to the tools page", () => {
    expect(toolPage("tapOn")).toBe(TOOLS_PAGE);
    expect(toolPage("tapAt")).toBe("docs/using/tap-at.md");
  });

  test("reports a shared emoji and an empty emoji list", () => {
    expect(
      registryProblems({ a: { emoji: ["⚙️"] }, b: { emoji: ["⚙"] }, c: { emoji: [] } }),
    ).toEqual(["⚙ is shared by a, b", "c must have one emoji (two only in extreme cases)"]);
  });
});

describe("tool emoji docs check", () => {
  const names = new Set(Object.keys(registry));

  test("finds code and linked references, ignoring non-tools and fenced code", () => {
    const markdown = [
      "👁️ `observe` and 🔑 `sessionUuid`",
      "| 🚀 [<code>launchApp</code>](tools.md#apps) |",
      "```",
      "👆 `tapOn`",
      "```",
      "🎉 plain prose",
    ].join("\n");
    expect(findToolEmojiReferences(markdown, names)).toEqual([
      { line: 1, emoji: "👁️", tool: "observe" },
      { line: 2, emoji: "🚀", tool: "launchApp", link: "tools.md#apps" },
    ]);
  });

  test("accepts canonical, linked references and unlinked ones on the tool's own page", () => {
    expect(checkDoc("docs/using/a.md", "👁️ [`observe`](observe.md)", registry)).toEqual([]);
    expect(checkDoc("docs/using/a.md", "👁 [`observe`](./observe.md#top)", registry)).toEqual([]);
    expect(checkDoc("docs/using/a.md", "🚀 [`launchApp`](../tools.md)", registry)).toEqual([]);
    expect(checkDoc("docs/tools.md", "| 👆 <code>tapOn</code> |", registry)).toEqual([]);
    expect(checkDoc("docs/using/observe.md", "👁️ `observe`", registry)).toEqual([]);
  });

  test("flags another tool's emoji and an unregistered emoji", () => {
    expect(checkDoc("docs/tools.md", "🚀 `tapOn` then 🎉 `launchApp`", registry)).toEqual([
      "docs/tools.md:1: 🚀 is launchApp's emoji but is used with tapOn (use 👆)",
      "docs/tools.md:1: launchApp uses 🚀, not 🎉",
    ]);
  });

  test("flags a missing or wrong link to the tool's page", () => {
    expect(
      checkDoc(
        "docs/using/a.md",
        "👆 `tapOn`\n👁️ [`observe`](https://example.com/observe)",
        registry,
      ),
    ).toEqual([
      "docs/using/a.md:1: 👆 tapOn must link to docs/tools.md",
      "docs/using/a.md:2: 👁️ observe must link to docs/using/observe.md",
    ]);
  });

  test("checks titled links like plain ones", () => {
    expect(checkDoc("docs/using/a.md", '👁️ [`observe`](observe.md "Observe")', registry)).toEqual(
      [],
    );
    expect(checkDoc("docs/other.md", "🚀 [`observe`](wrong.md 'Observe')", registry)).toEqual([
      "docs/other.md:1: 🚀 is launchApp's emoji but is used with observe (use 👁️)",
      "docs/other.md:1: 🚀 observe must link to docs/using/observe.md",
    ]);
  });

  test("checks the emoji and destination of a double-quote titled link", () => {
    expect(checkDoc("docs/other.md", '🚀 [`observe`](wrong.md "Observe")', registry)).toEqual([
      "docs/other.md:1: 🚀 is launchApp's emoji but is used with observe (use 👁️)",
      "docs/other.md:1: 🚀 observe must link to docs/using/observe.md",
    ]);
  });

  test("reads an emoji inside the link text as a linked reference", () => {
    expect(
      findToolEmojiReferences(
        "[👁️ `observe`](observe.md) and [🚀 <code>tapOn</code>](x.md)",
        names,
      ),
    ).toEqual([
      { line: 1, emoji: "👁️", tool: "observe", link: "observe.md" },
      { line: 1, emoji: "🚀", tool: "tapOn", link: "x.md" },
    ]);
    expect(checkDoc("docs/using/a.md", "[👁️ `observe`](observe.md)", registry)).toEqual([]);
    expect(checkDoc("docs/using/a.md", "[🚀 `observe`](wrong.md)", registry)).toEqual([
      "docs/using/a.md:1: 🚀 is launchApp's emoji but is used with observe (use 👁️)",
      "docs/using/a.md:1: 🚀 observe must link to docs/using/observe.md",
    ]);
  });

  test("keeps a shorter inner fence inside a longer code block", () => {
    const markdown = [
      "````markdown",
      "```",
      "👆 `tapOn`",
      "```",
      "🚀 `tapOn`",
      "````",
      "👁️ `observe`",
    ].join("\n");
    expect(findToolEmojiReferences(markdown, names)).toEqual([
      { line: 7, emoji: "👁️", tool: "observe" },
    ]);
  });

  test("reports source lines across paragraphs, lists and table rows", () => {
    const markdown = [
      "# Tools",
      "",
      "- 👆 `tapOn`",
      "",
      "| Tool | Use |",
      "|---|---|",
      "| 🚀 <code>launchApp</code> | open |",
      "| 👁️ `observe` | look |",
    ].join("\n");
    expect(findToolEmojiReferences(markdown, names).map((ref) => [ref.line, ref.tool])).toEqual([
      [3, "tapOn"],
      [7, "launchApp"],
      [8, "observe"],
    ]);
  });

  test("lists tools the tools page does not show with an emoji", () => {
    expect(
      missingFromToolsPage("| 👆 <code>tapOn</code> |\n| `launchApp` |", ["tapOn", "launchApp"]),
    ).toEqual(["launchApp"]);
  });
});
