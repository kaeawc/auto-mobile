import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Glob } from "bun";
import catalog from "../../schemas/tool-definitions.json";
import { TOOL_EMOJI, TOOLS_PAGE, toolPage } from "../../src/server/toolEmoji";

/**
 * Docs gate for the canonical tool emoji registry (#18142). A tool emoji
 * reference is an emoji directly followed by a tool name in code, optionally
 * as a Markdown link: `👁️ `observe``, `📍 [<code>tapAt</code>](using/tap-at.md)`,
 * or with the emoji inside the link text: `[👁️ `observe`](observe.md)`. Each
 * reference must use that tool's emoji and link to the tool's page (a
 * reference on the tool's own page needs no link). Other emoji use is free.
 *
 * Markdown structure comes from Bun's built-in CommonMark/GFM parser
 * (`Bun.markdown.render`), as in check-docs-tool-names.ts: code blocks and
 * HTML blocks are dropped, and links arrive with their parsed destination
 * (titles excluded). The callbacks flatten each block into a token string
 * (code spans and links wrapped in private-use delimiters) that one pattern
 * matches. The parser reports no source positions, so `annotateLines` adds an
 * invisible line marker to each source line first; a reference takes the line
 * of the next marker after it (#18190).
 */

const EMOJI = String.raw`\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*`;
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
const CODE_OPEN = "\uE010";
const CODE_CLOSE = "\uE011";
const LINK_OPEN = "\uE012";
const LINK_TEXT = "\uE013";
const LINK_CLOSE = "\uE014";
const MARKER = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
const NAME = String.raw`(?:${CODE_OPEN}(\w+)${CODE_CLOSE}|<code>(\w+)</code>)`;
const LINKED = String.raw`${LINK_OPEN}(\d+)${LINK_TEXT}`;
// Emoji before the name or its link, or the emoji inside the link text.
const REFERENCE = new RegExp(
  String.raw`(?:(${EMOJI})[ \t]*(?:${LINKED}${NAME}${LINK_CLOSE}|${NAME})|${LINKED}(${EMOJI})[ \t]*${NAME}${LINK_CLOSE})`,
  "gu",
);

// Lines where trailing text would change how the parser reads the block:
// fence delimiters, setext underlines and breaks, table delimiter rows, empty
// list markers and link reference definitions.
const UNMARKED_LINE = [
  /^\s*(`{3,}|~{3,})/,
  /^\s*([-=*_]\s*)+$/,
  /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  /^\s*([-*+]|\d{1,9}[.)])\s*$/,
  /^\s{0,3}\[[^\]]+\]:/,
];
// A trailing unescaped pipe closes a table row; a marker after it would be an
// extra cell, which GFM drops, so the marker goes just before it.
const TRAILING_PIPE = /(?<!\\)\|\s*$/;

export interface ToolEmojiReference {
  readonly line: number;
  readonly emoji: string;
  readonly tool: string;
  readonly link?: string;
}

function normalizeEmoji(emoji: string): string {
  return emoji.replaceAll("️", "");
}

/** Emoji owner lookup, keyed without variation selectors. */
export function emojiOwners(
  registry: Readonly<Record<string, { readonly emoji: readonly string[] }>> = TOOL_EMOJI,
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(registry)) {
    for (const emoji of entry.emoji) {
      const key = normalizeEmoji(emoji);
      owners.set(key, [...(owners.get(key) ?? []), name]);
    }
  }
  return owners;
}

/** Add a 1-based line marker to every source line whose block structure it cannot change. */
export function annotateLines(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line, index) => {
      const marker = `${MARK_OPEN}${index + 1}${MARK_CLOSE}`;
      if (line.trim() === "" || UNMARKED_LINE.some((pattern) => pattern.test(line))) {
        return line;
      }
      const pipe = TRAILING_PIPE.exec(line);
      return pipe
        ? `${line.slice(0, pipe.index)}${marker}${line.slice(pipe.index)}`
        : `${line}${marker}`;
    })
    .join("\n");
}

function markersOnly(text: string): string {
  return text.match(MARKER)?.join("") ?? "";
}

const BLOCKS = [
  "heading",
  "paragraph",
  "blockquote",
  "list",
  "listItem",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
] as const;

/** Flatten `markdown` into a token string plus the destination of each link. */
function tokenize(markdown: string): { tokens: string; links: string[] } {
  const links: string[] = [];
  const block = (children: string): string => `${children}\n`;
  const callbacks: Record<string, (children: string, meta?: { href?: string }) => string> = {
    // Fenced and indented code and HTML blocks are never references.
    code: (children) => markersOnly(children),
    html: (children) => markersOnly(children),
    codespan: (children) =>
      `${CODE_OPEN}${children.replace(MARKER, "")}${CODE_CLOSE}${markersOnly(children)}`,
    link: (children, meta) =>
      `${LINK_OPEN}${links.push((meta?.href ?? "").replace(MARKER, "")) - 1}${LINK_TEXT}${children}${LINK_CLOSE}`,
  };
  for (const type of BLOCKS) {
    callbacks[type] = block;
  }
  return { tokens: Bun.markdown.render(annotateLines(markdown), callbacks), links };
}

export function findToolEmojiReferences(
  markdown: string,
  toolNames: ReadonlySet<string>,
): ToolEmojiReference[] {
  const { tokens, links } = tokenize(markdown);
  const markers = [...tokens.matchAll(MARKER)].map((match) => ({
    at: match.index,
    line: Number(match[1]),
  }));
  const lineAfter = (offset: number): number =>
    markers.find((marker) => marker.at >= offset)?.line ?? markers.at(-1)?.line ?? 1;
  return [...tokens.matchAll(REFERENCE)].flatMap((match) => {
    const [
      ,
      before,
      beforeLink,
      linkedCode,
      linkedHtml,
      code,
      html,
      inLink,
      inside,
      insideCode,
      insideHtml,
    ] = match;
    const emoji = before ?? inside;
    const tool = linkedCode ?? linkedHtml ?? code ?? html ?? insideCode ?? insideHtml;
    if (emoji === undefined || tool === undefined || !toolNames.has(tool)) {
      return [];
    }
    const linkIndex = beforeLink ?? inLink;
    const link = linkIndex === undefined ? undefined : links[Number(linkIndex)];
    return [
      {
        line: lineAfter(match.index + match[0].length),
        emoji,
        tool,
        ...(link ? { link } : {}),
      },
    ];
  });
}

function resolvesTo(docPath: string, link: string, page: string): boolean {
  const target = link.split("#")[0];
  if (target === "") {
    return docPath === page;
  }
  if (/^[a-z][a-z+.-]*:/i.test(target)) {
    return false;
  }
  return posix.normalize(posix.join(posix.dirname(docPath), target)) === page;
}

/** Problems in one Markdown file; `docPath` is repo-relative with `/` separators. */
export function checkDoc(
  docPath: string,
  markdown: string,
  registry: Readonly<
    Record<string, { readonly emoji: readonly string[]; readonly page?: string }>
  > = TOOL_EMOJI,
  defaultPage: string = TOOLS_PAGE,
): string[] {
  const owners = emojiOwners(registry);
  const names = new Set(Object.keys(registry));
  return findToolEmojiReferences(markdown, names).flatMap((ref) => {
    const at = `${docPath}:${ref.line}`;
    const entry = registry[ref.tool];
    const page = entry.page ?? defaultPage;
    const canonical = entry.emoji.map(normalizeEmoji);
    const problems: string[] = [];
    if (!canonical.includes(normalizeEmoji(ref.emoji))) {
      const owner = owners.get(normalizeEmoji(ref.emoji));
      problems.push(
        owner
          ? `${at}: ${ref.emoji} is ${owner.join("/")}'s emoji but is used with ${ref.tool} (use ${entry.emoji.join(" or ")})`
          : `${at}: ${ref.tool} uses ${entry.emoji.join(" or ")}, not ${ref.emoji}`,
      );
    }
    const linked = ref.link !== undefined && resolvesTo(docPath, ref.link, page);
    if (!linked && docPath !== page) {
      problems.push(`${at}: ${ref.emoji} ${ref.tool} must link to ${page}`);
    }
    return problems;
  });
}

/** Every listed tool must appear on the tools page with its emoji. */
export function missingFromToolsPage(
  toolsPageMarkdown: string,
  listedTools: readonly string[],
): string[] {
  const shown = new Set(
    findToolEmojiReferences(toolsPageMarkdown, new Set(listedTools)).map((ref) => ref.tool),
  );
  return listedTools.filter((name) => !shown.has(name));
}

/** Registry shape: 1-2 emoji per tool, each emoji owned by one tool. */
export function registryProblems(
  registry: Readonly<Record<string, { readonly emoji: readonly string[] }>> = TOOL_EMOJI,
): string[] {
  const shared = [...emojiOwners(registry)]
    .filter(([, names]) => names.length > 1)
    .map(([emoji, names]) => `${emoji} is shared by ${names.join(", ")}`);
  const counts = Object.entries(registry)
    .filter(([, entry]) => entry.emoji.length < 1 || entry.emoji.length > 2)
    .map(([name]) => `${name} must have one emoji (two only in extreme cases)`);
  return [...shared, ...counts];
}

function main(): void {
  const repoRoot = join(dirname(import.meta.path), "..", "..");
  const docs = [...new Glob("docs/**/*.md").scanSync({ cwd: repoRoot })]
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
  const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
  const listed = catalog.map((definition) => definition.name);
  const problems = [
    ...registryProblems(),
    ...listed
      .filter((name) => !(name in TOOL_EMOJI))
      .map((name) => `${name} has no entry in src/server/toolEmoji.ts`),
    ...missingFromToolsPage(read(TOOLS_PAGE), listed).map(
      (name) => `${TOOLS_PAGE}: ${name} is not shown with its emoji`,
    ),
    ...Object.keys(TOOL_EMOJI)
      .map(toolPage)
      .filter((page, index, pages) => pages.indexOf(page) === index && !docs.includes(page))
      .map((page) => `tool page ${page} does not exist`),
    ...docs.flatMap((path) => checkDoc(path, read(path))),
  ];
  if (problems.length > 0) {
    console.error("tool-emoji: docs disagree with src/server/toolEmoji.ts:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(`tool-emoji: ${docs.length} docs use canonical, linked tool emoji.`);
}

if (import.meta.main) {
  main();
}
