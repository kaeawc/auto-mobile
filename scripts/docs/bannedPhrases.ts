/**
 * Banned-phrase lint for docs/ prose (#18143).
 *
 * Markdown is parsed into an mdast tree (`mdast-util-from-markdown` with the
 * GFM table and strikethrough extensions), so fenced and indented code blocks, inline code, raw
 * HTML, link destinations and titles, and link reference definitions are
 * excluded by the parser rather than by line regexes. Every prose text node
 * carries its source position, and a soft line break inside it is a literal
 * newline, so each character's source line is exact (#18196).
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";

export interface BannedPhraseRule {
  /** Stable id used by the allowlist. */
  id: string;
  /** Case-insensitive regular expression source, matched against prose. */
  pattern: string;
  /** Plainer replacement or rewrite advice shown with each hit. */
  suggestion: string;
}

export interface BannedPhraseList {
  rules: BannedPhraseRule[];
}

export interface AllowlistEntry {
  /** Repository-relative Markdown path. */
  file: string;
  rule: string;
  /** Exact number of hits allowed for this rule in this file. */
  count: number;
  /** Why the phrase is acceptable here; required so every entry is reviewed. */
  reason: string;
}

export interface Allowlist {
  entries: AllowlistEntry[];
}

export interface PhraseHit {
  file: string;
  line: number;
  rule: string;
  match: string;
  suggestion: string;
}

/** The subset of an mdast node the prose walk reads. */
interface MdastNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MdastNode[];
  position?: { start: { line: number } };
}

/** One block's prose, with the source line of every character. */
interface ProseBlock {
  text: string;
  lines: number[];
}

/** Nodes whose content is prose that must not join with its neighbours. */
const BLOCK_NODES = new Set(["paragraph", "heading", "tableCell"]);
/** Nodes that are not prose and split the surrounding prose run. */
const SPLIT_NODES = new Set(["code", "inlineCode", "html", "break"]);
/** A soft line break and the whitespace around it. */
const SOFT_BREAK = /[ \t]*\n[ \t]*/g;

class ProseCollector {
  readonly blocks: ProseBlock[] = [];
  private current: ProseBlock = { text: "", lines: [] };
  /** Source line after a soft break not yet written as a space, or 0. */
  private pendingBreak = 0;

  flush(): void {
    if (this.current.text.length > 0) {
      this.blocks.push(this.current);
    }
    this.current = { text: "", lines: [] };
    this.pendingBreak = 0;
  }

  /**
   * Appends `text` that starts on source line `line`. A soft break becomes
   * one space before the next prose, unless whitespace already separates the
   * words; it may end this node and resolve in the next one (`a\n[b](/u)`).
   */
  append(text: string, line: number): void {
    let lineNumber = line;
    let last = 0;
    for (const lineBreak of text.matchAll(SOFT_BREAK)) {
      this.push(text.slice(last, lineBreak.index), lineNumber);
      lineNumber++;
      this.pendingBreak = lineNumber;
      last = lineBreak.index + lineBreak[0].length;
    }
    this.push(text.slice(last), lineNumber);
  }

  private push(text: string, line: number): void {
    if (text.length === 0) {
      return;
    }
    const block = this.current;
    if (this.pendingBreak > 0 && block.text.length > 0 && !/\s$/u.test(block.text)) {
      if (!/^\s/u.test(text)) {
        block.text += " ";
        block.lines.push(this.pendingBreak);
      }
    }
    this.pendingBreak = 0;
    block.text += text;
    for (let i = 0; i < text.length; i++) {
      block.lines.push(line);
    }
  }
}

function walk(node: MdastNode, collector: ProseCollector): void {
  const line = node.position?.start.line ?? 1;
  if (node.type === "text") {
    collector.append(node.value ?? "", line);
  } else if (node.type === "image" || node.type === "imageReference") {
    collector.append(node.alt ?? "", line);
  } else if (SPLIT_NODES.has(node.type)) {
    collector.flush();
  } else {
    const block = BLOCK_NODES.has(node.type);
    if (block) {
      collector.flush();
    }
    for (const child of node.children ?? []) {
      walk(child, collector);
    }
    if (block) {
      collector.flush();
    }
  }
}

/** Splits the document's prose into blocks of text with per-character source lines. */
function proseBlocks(source: string): ProseBlock[] {
  const tree = fromMarkdown(source, {
    extensions: [gfmTable(), gfmStrikethrough()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()],
  });
  const collector = new ProseCollector();
  walk(tree, collector);
  collector.flush();
  return collector.blocks;
}

function compile(rules: BannedPhraseRule[]): Array<{ rule: BannedPhraseRule; regex: RegExp }> {
  return rules.map((rule) => ({ rule, regex: new RegExp(rule.pattern, "giu") }));
}

/** Finds every banned phrase in one Markdown document's prose. */
export function findBannedPhrases(
  file: string,
  source: string,
  rules: BannedPhraseRule[],
): PhraseHit[] {
  const compiled = compile(rules);
  const hits: PhraseHit[] = [];
  for (const block of proseBlocks(source)) {
    for (const { rule, regex } of compiled) {
      for (const match of block.text.matchAll(regex)) {
        const line = block.lines[match.index] ?? 1;
        hits.push({ file, line, rule: rule.id, match: match[0], suggestion: rule.suggestion });
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export interface AllowlistResult {
  /** Hits not covered by the allowlist. */
  violations: PhraseHit[];
  /** Allowlist entries whose count no longer matches the file's hits. */
  stale: Array<AllowlistEntry & { actual: number }>;
  /** Entries that are malformed or reference an unknown rule. */
  invalid: string[];
}

function key(file: string, rule: string): string {
  return `${file}\u0000${rule}`;
}

function validateEntries(allowlist: Allowlist, ruleIds: Set<string>): string[] {
  const seen = new Set<string>();
  return allowlist.entries.flatMap((entry) => {
    const problems: string[] = [];
    const label = `${entry.file} (${entry.rule})`;
    if (!ruleIds.has(entry.rule)) {
      problems.push(`${label}: unknown rule`);
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      problems.push(`${label}: count must be a positive integer`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      problems.push(`${label}: reason is required`);
    }
    if (seen.has(key(entry.file, entry.rule))) {
      problems.push(`${label}: duplicate entry`);
    }
    seen.add(key(entry.file, entry.rule));
    return problems;
  });
}

/**
 * Applies the per-file allowlist. An entry covers exactly `count` hits of one
 * rule in one file: more hits fail as violations, fewer fail as stale so the
 * allowlist shrinks when a phrase is rewritten.
 */
export function applyAllowlist(
  hits: PhraseHit[],
  allowlist: Allowlist,
  rules: BannedPhraseRule[],
): AllowlistResult {
  const invalid = validateEntries(allowlist, new Set(rules.map((rule) => rule.id)));
  const grouped = Map.groupBy(hits, (hit) => key(hit.file, hit.rule));
  const allowed = new Map(allowlist.entries.map((entry) => [key(entry.file, entry.rule), entry]));
  const violations = [...grouped].flatMap(([groupKey, group]) => {
    const entry = allowed.get(groupKey);
    return entry && group.length <= entry.count ? [] : group;
  });
  const stale = allowlist.entries
    .map((entry) => ({ ...entry, actual: grouped.get(key(entry.file, entry.rule))?.length ?? 0 }))
    .filter((entry) => entry.actual < entry.count);
  return { violations, stale, invalid };
}

export function formatHit(hit: PhraseHit): string {
  return `${hit.file}:${hit.line}: [${hit.rule}] "${hit.match}" -> ${hit.suggestion}`;
}
