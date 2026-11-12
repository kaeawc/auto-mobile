#!/usr/bin/env bun
/**
 * Keep tool names and tool summaries in docs/ consistent with
 * schemas/tool-definitions.json (#18144).
 *
 * Markdown is parsed with Bun's built-in CommonMark/GFM parser
 * (`Bun.markdown.render`), so code fences, indented code and HTML blocks are
 * structurally out of scope and inline code is told apart from prose without
 * line regexes. The parser emits a flat bottom-up callback stream; `parseTree`
 * turns it into a small node tree by returning placeholder tokens from each
 * callback and resolving them in the parent.
 *
 * Rules, per docs/ Markdown file:
 *  - casing:    inline code or prose that names a tool with different casing
 *               (`TapOn`, `tapon`) must use the exact registered name.
 *  - backticks: a camelCase tool name in prose must be inline code. All-lowercase
 *               names (`observe`, `network`) are also English words, so they are
 *               only checked inside inline code.
 *  - real tool: the first column of a tool table (header `Tool`) and inline code
 *               followed by the word "tool" must name a registered tool. In a
 *               `Tool | What it does` index a bare (unformatted) first cell is
 *               read as the tool name and also reported under backticks.
 *  - summary:   a tool table's `What it does` cell must be the tool's canonical
 *               one-line description (`leadClause` of its definition).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolDefinition {
  name: string;
  description: string;
}

export interface MdNode {
  type: string;
  value: string;
  children: MdNode[];
}

export interface Violation {
  rule: "casing" | "backticks" | "real-tool" | "summary";
  message: string;
}

const OPEN = "";
const CLOSE = "";
const TOKEN = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
const CONTAINERS = [
  "heading",
  "paragraph",
  "strong",
  "emphasis",
  "link",
  "image",
  "blockquote",
  "list",
  "listItem",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strikethrough",
] as const;
// A lowerCamel identifier with at least one hump, the shape of a tool name.
const LOWER_CAMEL = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/;
// Inline code that differs from a tool name only by case but names something
// else. Each entry says what it is.
const EXEMPT_IDENTIFIERS: Readonly<Record<string, string>> = {
  draganddrop: "adb shell input subcommand",
};
// Registered tools that tools/list omits (`hidden: true`), so they are absent
// from schemas/tool-definitions.json but are still real tool names.
const HIDDEN_TOOLS: Readonly<Record<string, string>> = {
  startDevice: "registered hidden in src/server/deviceTools.ts; callable by name",
};
// Leaves whose content is never prose: fences, indented code, HTML blocks.
const OPAQUE = ["code", "html"] as const;

export function parseTree(markdown: string): MdNode {
  const nodes: MdNode[] = [];
  const add = (node: MdNode): string => `${OPEN}${nodes.push(node) - 1}${CLOSE}`;
  const resolve = (rendered: string): MdNode[] =>
    [...rendered.matchAll(TOKEN)].map((match) => nodes[Number(match[1])]);
  const callbacks: Record<string, (children: string) => string> = {
    text: (value) => add({ type: "text", value, children: [] }),
    codespan: (value) =>
      add({ type: "inlineCode", value: plainText(resolve(value)), children: [] }),
  };
  for (const type of CONTAINERS) {
    callbacks[type] = (children) => add({ type, value: "", children: resolve(children) });
  }
  for (const type of OPAQUE) {
    callbacks[type] = () => add({ type, value: "", children: [] });
  }
  return { type: "root", value: "", children: resolve(Bun.markdown.render(markdown, callbacks)) };
}

function plainText(nodes: readonly MdNode[]): string {
  return nodes.map((node) => node.value + plainText(node.children)).join("");
}

/**
 * Inline HTML arrives as text siblings (`<code>`, `name`, `</code>`); fold that
 * run into one inlineCode node so `<code>tapOn</code>` counts like `` `tapOn` ``.
 */
function foldHtmlCode(children: readonly MdNode[]): MdNode[] {
  const folded: MdNode[] = [];
  for (let index = 0; index < children.length; index++) {
    const close = children.findIndex((node, at) => at > index && node.value === "</code>");
    if (children[index].value === "<code>" && close > index) {
      folded.push({
        type: "inlineCode",
        value: plainText(children.slice(index + 1, close)),
        children: [],
      });
      index = close;
    } else {
      folded.push(children[index]);
    }
  }
  return folded;
}

const CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const ABBREVIATION = /\b(?:e\.g|i\.e|vs|etc)$/;

/**
 * A tool's canonical one-line description: the lead clause of its definition's
 * description, up to the first `.`, `;` or `:` that ends a clause (`:` only
 * after five words, so a `Platform:` or `Deprecated:` prefix stays attached),
 * with bracketed asides dropped. Boundaries inside brackets or backticks and
 * after `e.g.`-style abbreviations do not end the clause.
 */
export function leadClause(description: string): string {
  const closers: string[] = [];
  let inCode = false;
  let lead = "";
  for (const [index, char] of [...description].entries()) {
    if (char === "`") {
      inCode = !inCode;
    } else if (!inCode && CLOSERS[char]) {
      closers.push(CLOSERS[char]);
      continue;
    } else if (!inCode && char === closers.at(-1)) {
      closers.pop();
      continue;
    }
    if (closers.length > 0) {
      continue;
    }
    const words = lead.trim().split(/\s+/).length;
    const endsClause =
      !inCode &&
      /\s|^$/.test(description[index + 1] ?? "") &&
      ((/[.;]/.test(char) && words >= 3) || (char === ":" && words >= 5));
    if (endsClause && !ABBREVIATION.test(lead)) {
      break;
    }
    lead += char;
  }
  return lead
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function normalizeCell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\.$/, "");
}

class Scanner {
  readonly violations: Violation[] = [];
  private readonly byLower = new Map<string, string>();
  private readonly camelCase: RegExp | undefined;

  constructor(private readonly tools: ReadonlyMap<string, string>) {
    const names = [...tools.keys(), ...Object.keys(HIDDEN_TOOLS)];
    for (const name of names) {
      this.byLower.set(name.toLowerCase(), name);
    }
    const camel = names.filter((name) => /[A-Z]/.test(name));
    this.camelCase = camel.length
      ? new RegExp(`(?<![\\w./:-])(${camel.join("|")})(?![\\w/-]|\\.\\w)`, "gi")
      : undefined;
  }

  scan(node: MdNode): void {
    const children = foldHtmlCode(node.children);
    children.forEach((child, index) => {
      if (child.type === "table") {
        this.scanTable(child);
      } else if (child.type === "inlineCode") {
        this.checkInlineCode(child.value, children[index + 1]);
      } else if (child.type === "text") {
        this.checkProse(child.value);
      } else {
        this.scan(child);
      }
    });
  }

  private checkInlineCode(value: string, next: MdNode | undefined): void {
    if (this.byLower.get(value.toLowerCase()) === value || value in EXEMPT_IDENTIFIERS) {
      return;
    }
    const canonical = this.byLower.get(value.toLowerCase());
    // A PascalCase span is a type or class name (`MediaSession`), not a tool.
    if (canonical && /^[a-z]/.test(value)) {
      this.report("casing", `\`${value}\` should be \`${canonical}\``);
    } else if (!canonical && LOWER_CAMEL.test(value) && /^\s+tools?\b/.test(next?.value ?? "")) {
      this.report("real-tool", `\`${value}\` is called a tool but is not a registered tool`);
    }
  }

  private checkProse(text: string): void {
    for (const match of text.matchAll(this.camelCase ?? /$^/g)) {
      const word = match[1];
      const canonical = this.byLower.get(word.toLowerCase()) ?? word;
      if (word === canonical) {
        this.report("backticks", `${word} in prose should be \`${canonical}\``);
      } else if (LOWER_CAMEL.test(word)) {
        // All-lowercase (`multitouch`) and PascalCase (`MediaSession`) prose
        // words are English or platform names, so only a camel hump counts.
        this.report("casing", `${word} in prose should be \`${canonical}\``);
      }
    }
  }

  /**
   * A `Tool | What it does` table is a tool index: every name in its first
   * cell must be a tool, and its summary must be the canonical one. Other
   * `Tool` tables mix in parameters and other agents' tools, so only a
   * lowerCamel name leading the cell is held to the registry.
   */
  private scanTable(table: MdNode): void {
    const [header, ...rows] = table.children.flatMap((section) => section.children);
    const headings = header?.children.map((cell) => normalizeCell(plainText(cell.children))) ?? [];
    const toolColumn = headings.findIndex((cell) => /^tools?$/i.test(cell));
    const summaryColumn = headings.findIndex((cell) => /^what it does$/i.test(cell));
    for (const row of toolColumn >= 0 ? rows : []) {
      const cell = row.children[toolColumn];
      const leading = plainText(cell?.children ?? []).replace(/^[^A-Za-z<]*/, "");
      const names = collect(cell, "inlineCode").map((code) => code.value);
      // An index row without code markup still names a tool: read the bare
      // cell as the name so it cannot escape the registry and summary checks.
      const bare = normalizeCell(leading);
      if (summaryColumn >= 0 && names.length === 0 && bare !== "") {
        this.report("backticks", `tool table cell ${bare} should be \`${bare}\``);
        names.push(bare);
      }
      const checked =
        summaryColumn >= 0
          ? names
          : names.slice(0, 1).filter((name) => LOWER_CAMEL.test(name) && leading.startsWith(name));
      checked
        .filter((name) => !this.byLower.has(name.toLowerCase()))
        .forEach((name) => this.report("real-tool", `tool table names unknown tool \`${name}\``));
      const expected = names.length === 1 ? this.tools.get(names[0]) : undefined;
      const actual = normalizeCell(plainText(row.children[summaryColumn]?.children ?? []));
      // Backticks in a description become inline code in the cell; compare text.
      if (
        summaryColumn >= 0 &&
        expected !== undefined &&
        actual !== normalizeCell(expected.replaceAll("`", ""))
      ) {
        this.report("summary", `\`${names[0]}\` summary should be: ${normalizeCell(expected)}`);
      }
    }
    for (const row of [header, ...rows]) {
      row?.children.forEach((child) => this.scan(child));
    }
  }

  private report(rule: Violation["rule"], message: string): void {
    this.violations.push({ rule, message });
  }
}

function collect(node: MdNode | undefined, type: string): MdNode[] {
  if (!node) {
    return [];
  }
  const children = foldHtmlCode(node.children);
  return children.flatMap((child) => (child.type === type ? [child] : collect(child, type)));
}

/** Map of tool name to its canonical one-line description. */
export function canonicalSummaries(tools: readonly ToolDefinition[]): Map<string, string> {
  return new Map(tools.map((tool) => [tool.name, leadClause(tool.description)]));
}

export function scanMarkdown(
  markdown: string,
  summaries: ReadonlyMap<string, string>,
): Violation[] {
  const scanner = new Scanner(summaries);
  scanner.scan(parseTree(markdown));
  return scanner.violations;
}

const repoRoot = join(import.meta.dir, "../..");

function main(): number {
  const tools: ToolDefinition[] = JSON.parse(
    readFileSync(join(repoRoot, "schemas/tool-definitions.json"), "utf8"),
  );
  const summaries = canonicalSummaries(tools);
  const files = execFileSync("git", ["ls-files", "-z", "--", "docs/*.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const failures = files.flatMap((file) =>
    scanMarkdown(readFileSync(join(repoRoot, file), "utf8"), summaries).map(
      (violation) => `${file}: [${violation.rule}] ${violation.message}`,
    ),
  );
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    console.error(
      `\n${failures.length} docs tool-name issue(s). Names must match schemas/tool-definitions.json exactly, in backticks; tool-table summaries are the lead clause of the tool's description.`,
    );
    return 1;
  }
  console.log(`docs tool names: ${files.length} files consistent with ${tools.length} tools`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
