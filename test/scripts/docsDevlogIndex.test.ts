import { describe, expect, test } from "bun:test";
import {
  generate,
  INDEX_END,
  INDEX_START,
  isEntryFile,
  NAV_END,
  NAV_START,
  parseEntry,
  renderIndexTable,
  renderNav,
  replaceRegion,
  sortEntries,
  type DevlogEntry,
} from "../../scripts/docs/generate-devlog-index";

function entrySource(title: string, kind: string, date: string): string {
  return `# ${title}\n\n- Kind: ${kind}\n- Date: ${date}\n- Source: #1\n\n## Context\n`;
}

const INDEX = `# Devlog\n\nIntro.\n\n${INDEX_START}\n\nstale\n\n${INDEX_END}\n`;

const MKDOCS = [
  "site_name: test",
  "markdown_extensions:",
  "  - pymdownx.superfences:",
  "      custom_fences:",
  "        - format: !!python/name:mermaid2.fence_mermaid_custom",
  "nav:",
  '  - "Home": index.md',
  '  - "Devlog":',
  '      - "Index": devlog/index.md',
  `      ${NAV_START}`,
  '      - "stale": devlog/2020-01-01-old.md',
  `      ${NAV_END}`,
  '  - "Contributing": contributing.md',
  "",
].join("\n");

const ENTRIES = [
  { file: "2026-11-01-alpha.md", source: entrySource("Alpha choice", "decision", "2026-11-01") },
  {
    file: "2026-11-23-zeta.md",
    source: entrySource('Use `observe` quotes "here"', "idea", "2026-11-23"),
  },
  { file: "2026-11-23-beta.md", source: entrySource("Beta", "concept", "2026-11-23") },
];

describe("generate-devlog-index", () => {
  test("isEntryFile accepts dated Markdown and skips index and template", () => {
    expect(isEntryFile("2026-11-01-a.md")).toBe(true);
    expect(isEntryFile("index.md")).toBe(false);
    expect(isEntryFile("template.md")).toBe(false);
  });

  test("parseEntry reads title, kind and date", () => {
    expect(
      parseEntry("2026-11-01-alpha.md", entrySource("Alpha choice", "decision", "2026-11-01")),
    ).toEqual({
      file: "2026-11-01-alpha.md",
      title: "Alpha choice",
      kind: "decision",
      date: "2026-11-01",
    });
  });

  test("parseEntry rejects a missing heading, unknown kind and mismatched date", () => {
    expect(() =>
      parseEntry("2026-11-01-a.md", "No heading\n- Kind: idea\n- Date: 2026-11-01\n"),
    ).toThrow(/first line/);
    expect(() => parseEntry("2026-11-01-a.md", entrySource("A", "rumor", "2026-11-01"))).toThrow(
      /Kind/,
    );
    expect(() => parseEntry("2026-11-01-a.md", entrySource("A", "idea", "2026-11-02"))).toThrow(
      /Date/,
    );
    expect(() => parseEntry("2026-11-01-A b.md", entrySource("A", "idea", "2026-11-01"))).toThrow(
      /file name/,
    );
  });

  test("sortEntries lists newest first by file name", () => {
    const entries = ENTRIES.map(({ file, source }) => parseEntry(file, source));
    expect(sortEntries(entries).map((entry) => entry.file)).toEqual([
      "2026-11-23-zeta.md",
      "2026-11-23-beta.md",
      "2026-11-01-alpha.md",
    ]);
  });

  test("renderIndexTable pads columns to the widest cell", () => {
    const entries: DevlogEntry[] = [
      { file: "2026-11-01-a.md", title: "A", kind: "idea", date: "2026-11-01" },
      { file: "2026-11-02-b.md", title: "Longer", kind: "decision", date: "2026-11-02" },
    ];
    expect(renderIndexTable(entries)).toBe(
      [
        "| Date       | Kind     | Entry                     |",
        "| ---------- | -------- | ------------------------- |",
        "| 2026-11-01 | idea     | [A](2026-11-01-a.md)      |",
        "| 2026-11-02 | decision | [Longer](2026-11-02-b.md) |",
      ].join("\n"),
    );
  });

  test("renderNav strips backticks and escapes YAML double quotes", () => {
    const entry: DevlogEntry = {
      file: "2026-11-23-z.md",
      title: 'Use `x` "y"',
      kind: "idea",
      date: "2026-11-23",
    };
    expect(renderNav([entry], "  ")).toBe(
      '  - "2026-11-23: Use x \\"y\\"": devlog/2026-11-23-z.md',
    );
  });

  test("replaceRegion throws when a marker is missing", () => {
    expect(() => replaceRegion("no markers", "<a>", "<b>", "x", "f")).toThrow(/marker/);
  });

  test("generate rewrites both regions and is idempotent", () => {
    const first = generate({ entries: ENTRIES, index: INDEX, mkdocs: MKDOCS });
    expect(first.index).toContain(
      '| 2026-11-23 | idea     | [Use `observe` quotes "here"](2026-11-23-zeta.md) |',
    );
    expect(first.index).not.toContain("stale");
    expect(first.index.startsWith("# Devlog\n\nIntro.\n")).toBe(true);
    expect(first.mkdocs).toContain(
      '      - "2026-11-23: Use observe quotes \\"here\\"": devlog/2026-11-23-zeta.md',
    );
    expect(first.mkdocs).not.toContain("2020-01-01-old.md");
    expect(first.mkdocs).toContain('  - "Contributing": contributing.md');
    expect(generate({ entries: ENTRIES, index: first.index, mkdocs: first.mkdocs })).toEqual(first);
  });

  test("generate rejects nav markers outside the Devlog section", () => {
    const moved = MKDOCS.replace(`      ${NAV_START}\n`, "")
      .replace(`      ${NAV_END}\n`, "")
      .replace('  - "Home": index.md', `  - "Home": index.md\n  ${NAV_START}\n  ${NAV_END}`);
    expect(() => generate({ entries: ENTRIES, index: INDEX, mkdocs: moved })).toThrow(/Devlog/);
  });
});
