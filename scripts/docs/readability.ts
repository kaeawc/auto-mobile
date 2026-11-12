// Per-section readability analysis for the public docs (#18145).
//
// Markdown structure comes from Bun's built-in parser (`Bun.markdown.render`)
// and sentence/word boundaries from `Intl.Segmenter`; nothing here splits
// Markdown into blocks with line regexes. Bun's renderer reports no source
// positions, so `annotateLines` appends an invisible line marker to the end of
// each source line before parsing. The parser carries the markers through into
// paragraph text, and they map every sentence back to its source line. Markers
// are left off the lines where trailing text would change how the parser reads
// the block (fence delimiters, setext underlines and breaks, table rows, empty
// list markers, link reference definitions); prose on those lines takes the
// line of the next marker in its block.
//
// Prose is paragraph and list-item text. Code blocks, tables, raw HTML, images
// and headings are not prose; an inline code span counts as one word.

export type Rule = "sentence-length" | "paragraph-length" | "page-length" | "passive-paragraph";

export interface SectionBudget {
  name: string;
  /** Repository-relative path prefixes, each ending in `/`. */
  paths: string[];
  maxSentenceWords: number;
  maxParagraphWords: number;
  maxPageWords: number;
  passive: { minSentences: number; maxRatio: number };
}

export interface ReadabilityConfig {
  sections: SectionBudget[];
}

export interface Finding {
  file: string;
  line: number;
  rule: Rule;
  section: string;
  value: number;
  limit: number;
  message: string;
}

export interface Sentence {
  line: number;
  words: number;
  passive: boolean;
}

export interface ProseBlock {
  line: number;
  words: number;
  sentences: Sentence[];
}

const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
// Returned by block callbacks whose content was already recorded or is not prose.
const CONSUMED = "\uE002";
const MARKER_PATTERN = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const RULE_OR_UNDERLINE = /^\s*([-=*_]\s*)+$/;
const BARE_LIST_MARKER = /^\s*([-*+]|\d{1,9}[.)])\s*$/;
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableLines(lines: string[]): Set<number> {
  const inTable = new Set<number>();
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("|")) {
      inTable.add(index);
    }
    const isDelimiter = line.includes("|") && TABLE_DELIMITER.test(line) && index > 0;
    if (!isDelimiter || !lines[index - 1].includes("|")) {
      return;
    }
    inTable.add(index - 1);
    for (let row = index; row < lines.length && lines[row].trim() !== ""; row++) {
      inTable.add(row);
    }
  });
  return inTable;
}

function keepsMarker(line: string, index: number, inTable: Set<number>): boolean {
  if (line.trim() === "" || inTable.has(index)) {
    return false;
  }
  return ![FENCE_LINE, RULE_OR_UNDERLINE, BARE_LIST_MARKER, LINK_DEFINITION].some((pattern) =>
    pattern.test(line),
  );
}

/** Append a 1-based line marker to every source line whose block structure it cannot change. */
export function annotateLines(source: string): string {
  const lines = source.split(/\r?\n/);
  const inTable = tableLines(lines);
  return lines
    .map((line, index) =>
      keepsMarker(line, index, inTable) ? `${line}${MARK_OPEN}${index + 1}${MARK_CLOSE}` : line,
    )
    .join("\n");
}

/** Keep only the line markers inside `children`, dropping its text. */
function markersOnly(children: string): string {
  return children.match(MARKER_PATTERN)?.join("") ?? "";
}

/** Parse `source` into its prose blocks, each holding marker-annotated text. */
function extractProse(source: string): string[] {
  const blocks: string[] = [];
  const record = (text: string): string => {
    if (text.replace(MARKER_PATTERN, "").trim() !== "") {
      blocks.push(text);
    }
    return CONSUMED;
  };
  const consume = (): string => CONSUMED;
  const drop = (children: string): string => markersOnly(children);
  Bun.markdown.render(annotateLines(source), {
    paragraph: record,
    listItem: (children) => record(children.replaceAll(CONSUMED, " ")),
    heading: consume,
    blockquote: consume,
    code: consume,
    list: consume,
    hr: consume,
    table: consume,
    html: drop,
    image: drop,
    td: drop,
    th: drop,
    codespan: (children) => `code${markersOnly(children)}`,
  });
  return blocks;
}

interface PlainText {
  text: string;
  /** Plain-text offset and line of each marker, in order. */
  marks: { offset: number; line: number }[];
}

function stripMarkers(annotated: string): PlainText {
  const marks: PlainText["marks"] = [];
  let text = "";
  let last = 0;
  for (const match of annotated.matchAll(MARKER_PATTERN)) {
    text += annotated.slice(last, match.index);
    marks.push({ offset: text.length, line: Number(match[1]) });
    last = match.index + match[0].length;
  }
  text += annotated.slice(last);
  return { text: text.replaceAll(CONSUMED, " ").replaceAll("\n", " "), marks };
}

/** The source line holding `offset`: the line of the first marker at or after it. */
function lineAt(marks: PlainText["marks"], offset: number): number {
  return marks.find((mark) => mark.offset >= offset)?.line ?? marks.at(-1)?.line ?? 1;
}

const WORDS = new Intl.Segmenter("en", { granularity: "word" });
const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });

export function wordsOf(text: string): string[] {
  return Array.from(WORDS.segment(text))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

const BE_VERBS = new Set(["am", "is", "are", "was", "were", "be", "been", "being", "isn't"]);
const IRREGULAR_PARTICIPLES = new Set(
  (
    "begun bound bought brought broken built caught chosen cut done drawn driven eaten fallen " +
    "forgotten found frozen given gotten held hidden hit kept known laid led left lost made " +
    "meant met paid put read ridden run said seen sent set shown shut sold spent split spoken " +
    "spread stolen taken taught thought thrown told understood withheld woken worn written"
  ).split(" "),
);
const NOT_PARTICIPLES = new Set(
  (
    "bed embed even feed garden golden happen indeed kitten listen need often open red seed " +
    "seven speed ten then token when wooden"
  ).split(" "),
);

function isParticiple(word: string): boolean {
  if (IRREGULAR_PARTICIPLES.has(word)) {
    return true;
  }
  if (NOT_PARTICIPLES.has(word) || word.length < 4) {
    return false;
  }
  return word.endsWith("ed") || word.endsWith("en");
}

/**
 * Heuristic passive voice: a form of "to be", up to two adverbs or "not", then a
 * past participle ("is used", "was not quickly rebuilt"). It flags some
 * adjectives ("is broken") and misses get-passives; the check is advisory.
 */
export function isPassive(words: string[]): boolean {
  const lower = words.map((word) => word.toLowerCase());
  return lower.some((word, index) => {
    if (!BE_VERBS.has(word)) {
      return false;
    }
    let next = index + 1;
    while (next < index + 3 && (lower[next] === "not" || lower[next]?.endsWith("ly"))) {
      next++;
    }
    return lower[next] !== undefined && isParticiple(lower[next]);
  });
}

function analyzeBlock(annotated: string): ProseBlock {
  const { text, marks } = stripMarkers(annotated);
  const leading = text.length - text.trimStart().length;
  const sentences = Array.from(SENTENCES.segment(text))
    .map(({ segment, index }) => ({ words: wordsOf(segment), index }))
    .filter(({ words }) => words.length > 0)
    .map(({ words, index }) => ({
      line: lineAt(marks, index),
      words: words.length,
      passive: isPassive(words),
    }));
  return {
    line: lineAt(marks, leading),
    words: sentences.reduce((sum, sentence) => sum + sentence.words, 0),
    sentences,
  };
}

/** Parse a Markdown page into prose blocks ordered by source line. */
export function analyzeMarkdown(source: string): ProseBlock[] {
  return extractProse(source)
    .map(analyzeBlock)
    .sort((a, b) => a.line - b.line);
}

/** The section whose longest path prefix matches `file`, if any. */
export function sectionFor(config: ReadabilityConfig, file: string): SectionBudget | undefined {
  const normalized = file.split("\\").join("/");
  const matches = config.sections.flatMap((section) =>
    section.paths
      .filter((path) => normalized.startsWith(path))
      .map((path) => ({ section, length: path.length })),
  );
  return matches.sort((a, b) => b.length - a.length)[0]?.section;
}

function blockFindings(block: ProseBlock, budget: SectionBudget): Omit<Finding, "file">[] {
  const base = { section: budget.name };
  const findings: Omit<Finding, "file">[] = block.sentences
    .filter((sentence) => sentence.words > budget.maxSentenceWords)
    .map((sentence) => ({
      ...base,
      line: sentence.line,
      rule: "sentence-length",
      value: sentence.words,
      limit: budget.maxSentenceWords,
      message: `sentence has ${sentence.words} words (budget ${budget.maxSentenceWords})`,
    }));
  if (block.words > budget.maxParagraphWords) {
    findings.push({
      ...base,
      line: block.line,
      rule: "paragraph-length",
      value: block.words,
      limit: budget.maxParagraphWords,
      message: `paragraph has ${block.words} words (budget ${budget.maxParagraphWords})`,
    });
  }
  const passive = block.sentences.filter((sentence) => sentence.passive).length;
  const ratio = block.sentences.length === 0 ? 0 : passive / block.sentences.length;
  if (block.sentences.length >= budget.passive.minSentences && ratio > budget.passive.maxRatio) {
    findings.push({
      ...base,
      line: block.line,
      rule: "passive-paragraph",
      value: Number(ratio.toFixed(2)),
      limit: budget.passive.maxRatio,
      message: `${passive} of ${block.sentences.length} sentences read as passive (budget ratio ${budget.passive.maxRatio})`,
    });
  }
  return findings;
}

/** Check one page against its section budget. */
export function checkPage(file: string, source: string, budget: SectionBudget): Finding[] {
  const blocks = analyzeMarkdown(source);
  const findings = blocks.flatMap((block) => blockFindings(block, budget));
  const pageWords = blocks.reduce((sum, block) => sum + block.words, 0);
  if (pageWords > budget.maxPageWords) {
    findings.push({
      section: budget.name,
      line: 1,
      rule: "page-length",
      value: pageWords,
      limit: budget.maxPageWords,
      message: `page has ${pageWords} prose words (budget ${budget.maxPageWords})`,
    });
  }
  return findings
    .map((finding) => ({ file, ...finding }))
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line}: ${finding.rule}: ${finding.message} [${finding.section}]`;
}

function positiveNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where} must be a positive number`);
  }
  return value;
}

function parseSection(raw: unknown, index: number): SectionBudget {
  const where = `sections[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where} must be an object`);
  }
  const section = raw as Record<string, unknown>;
  const { name, paths, passive } = section;
  if (typeof name !== "string" || name === "") {
    throw new Error(`${where}.name must be a string`);
  }
  const pathsOk =
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((path) => typeof path === "string" && path.endsWith("/"));
  if (!pathsOk) {
    throw new Error(`${where}.paths must be a non-empty list of prefixes ending in /`);
  }
  if (typeof passive !== "object" || passive === null) {
    throw new Error(`${where}.passive must be an object`);
  }
  const passiveRecord = passive as Record<string, unknown>;
  const maxRatio = positiveNumber(passiveRecord.maxRatio, `${where}.passive.maxRatio`);
  if (maxRatio > 1) {
    throw new Error(`${where}.passive.maxRatio must be at most 1`);
  }
  return {
    name,
    paths: paths as string[],
    maxSentenceWords: positiveNumber(section.maxSentenceWords, `${where}.maxSentenceWords`),
    maxParagraphWords: positiveNumber(section.maxParagraphWords, `${where}.maxParagraphWords`),
    maxPageWords: positiveNumber(section.maxPageWords, `${where}.maxPageWords`),
    passive: {
      minSentences: positiveNumber(passiveRecord.minSentences, `${where}.passive.minSentences`),
      maxRatio,
    },
  };
}

/** Validate the parsed budgets file. Throws with the offending field. */
export function parseConfig(raw: unknown): ReadabilityConfig {
  const sections = (raw as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("config must have a non-empty sections list");
  }
  return { sections: sections.map(parseSection) };
}
