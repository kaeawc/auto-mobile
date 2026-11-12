import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Glob } from "bun";
import catalog from "../../schemas/tool-definitions.json";
import { TOOL_EMOJI, TOOLS_PAGE, toolPage } from "../../src/server/toolEmoji";

/**
 * Docs gate for the canonical tool emoji registry (#18142). A tool emoji
 * reference is an emoji directly followed by a tool name in code, optionally
 * as a Markdown link: `👁️ `observe``, `📍 [<code>tapAt</code>](using/tap-at.md)`.
 * Each reference must use that tool's emoji and link to the tool's page (a
 * reference on the tool's own page needs no link). Other emoji use is free.
 */

const EMOJI = String.raw`\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*`;
const NAME = String.raw`(?:\x60(\w+)\x60|<code>(\w+)</code>)`;
const LINKED_NAME = String.raw`\[(?:\x60(\w+)\x60|<code>(\w+)</code>)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)`;
const REFERENCE = new RegExp(String.raw`(${EMOJI})[ \t]*(?:${LINKED_NAME}|${NAME})`, "gu");

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

/** Blank fenced code blocks so their contents never count, keeping line numbers. */
function withoutFences(markdown: string): string[] {
  let fence: string | undefined;
  return markdown.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) {
      fence = marker[0];
      return "";
    }
    if (fence !== undefined) {
      if (marker?.[0] === fence) {
        fence = undefined;
      }
      return "";
    }
    return line;
  });
}

export function findToolEmojiReferences(
  markdown: string,
  toolNames: ReadonlySet<string>,
): ToolEmojiReference[] {
  return withoutFences(markdown).flatMap((text, index) =>
    [...text.matchAll(REFERENCE)].flatMap((match) => {
      const tool = match[2] ?? match[3] ?? match[5] ?? match[6];
      if (tool === undefined || !toolNames.has(tool)) {
        return [];
      }
      const link = match[4];
      return [{ line: index + 1, emoji: match[1], tool, ...(link ? { link } : {}) }];
    }),
  );
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
