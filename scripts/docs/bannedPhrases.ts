/**
 * Banned-phrase lint for docs/ prose (#18143).
 *
 * Markdown is parsed with the runtime's own parser (`Bun.markdown`, md4c), so
 * fenced and indented code blocks, inline code and raw HTML are excluded by
 * the parser rather than by line regexes. Each prose text leaf is mapped back
 * to its source line by scanning the source forward from the previous leaf,
 * which is exact because md4c emits leaves in document order.
 */

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

interface Leaf {
  text: string;
  excluded: boolean;
  /** True when a block (paragraph, heading, cell, ...) ends after this leaf. */
  blockEnd: boolean;
}

interface ProseSegment {
  text: string;
  /** Source offset of the segment start, or -1 when it could not be located. */
  offset: number;
  /** Source line used when the exact offset is unknown. */
  fallbackLine: number;
}

/** Renderer callbacks whose content is not prose and is never linted. */
const EXCLUDED_NODES = new Set(["code", "codespan", "html"]);
/** Inline callbacks that keep the surrounding block open. */
const INLINE_NODES = new Set(["emphasis", "strong", "strikethrough", "link", "image", "text"]);

function excludeTrailingLeaves(leaves: Leaf[], children: string): void {
  let remaining = children.length;
  for (let i = leaves.length - 1; i >= 0 && remaining > 0; i--) {
    leaves[i].excluded = true;
    remaining -= leaves[i].text.length;
  }
  if (leaves.length > 0) {
    leaves[leaves.length - 1].blockEnd = true;
  }
}

function collectLeaves(markdown: string): Leaf[] {
  const leaves: Leaf[] = [];
  const callbacks = new Proxy(
    {},
    {
      get: (_target, key) => (children: unknown) => {
        const name = String(key);
        const content = typeof children === "string" ? children : "";
        if (name === "text") {
          leaves.push({ text: content, excluded: false, blockEnd: false });
        } else if (EXCLUDED_NODES.has(name)) {
          excludeTrailingLeaves(leaves, content);
        } else if (!INLINE_NODES.has(name) && leaves.length > 0) {
          leaves[leaves.length - 1].blockEnd = true;
        }
        return content;
      },
    },
  );
  Bun.markdown.render(markdown, callbacks);
  return leaves;
}

function lineAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Splits the document's prose into blocks of located text segments. */
function proseBlocks(source: string): ProseSegment[][] {
  const lineStarts = lineStartsOf(source);
  const blocks: ProseSegment[][] = [];
  let current: ProseSegment[] = [];
  let cursor = 0;
  for (const leaf of collectLeaves(source)) {
    const found = leaf.text.length > 0 ? source.indexOf(leaf.text, cursor) : -1;
    const fallbackLine = lineAt(lineStarts, cursor);
    if (found >= 0) {
      cursor = found + leaf.text.length;
    }
    if (leaf.excluded) {
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [];
    } else {
      current.push({ text: leaf.text, offset: found, fallbackLine });
    }
    if (leaf.blockEnd && current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
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
  const lineStarts = lineStartsOf(source);
  const hits: PhraseHit[] = [];
  for (const block of proseBlocks(source)) {
    const starts: number[] = [];
    let joined = "";
    for (const segment of block) {
      starts.push(joined.length);
      joined += segment.text;
    }
    for (const { rule, regex } of compiled) {
      for (const match of joined.matchAll(regex)) {
        const index = match.index ?? 0;
        let segmentIndex = 0;
        while (segmentIndex + 1 < starts.length && starts[segmentIndex + 1] <= index) {
          segmentIndex++;
        }
        const segment = block[segmentIndex];
        const line =
          segment.offset >= 0
            ? lineAt(lineStarts, segment.offset + index - starts[segmentIndex])
            : segment.fallbackLine;
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
