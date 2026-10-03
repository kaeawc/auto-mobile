import path from "node:path";

const REPO_PATH = /^(?:src|scripts|docs|android|ios|\.github|skills|test|schemas)\//;

/** Keep tracked-file enumeration injectable; generated and scratch files stay out. */
export function markdownRepoFiles(listTracked: () => string[]): string[] {
  return listTracked().filter(
    (file) =>
      file.endsWith(".md") &&
      (/^(?:docs|skills|\.claude\/commands|scripts)\//.test(file) ||
        /^(?:android|ios)\/(?:.*\/)?README\.md$/.test(file) ||
        /^README(?:\.[^/]+)?\.md$/.test(file) ||
        /^[^/]+\/README\.md$/.test(file)),
  );
}

export interface MarkdownRepoPath {
  target: string;
  missing: boolean;
}

/** Scan prose; fenced snippets are examples, not repository file declarations. */
export function scanMarkdownRepoPaths(
  markdown: string,
  file: string,
  exists: (target: string) => boolean,
  allowlist: Readonly<Record<string, string>> = {},
): MarkdownRepoPath[] {
  let fence: string | undefined;
  const prose = markdown
    .split("\n")
    .filter((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence[0] && marker.length >= fence.length) {
          fence = undefined;
        }
        return false;
      }
      if (marker) {
        fence = marker;
        return false;
      }
      return true;
    })
    .join("\n");
  const references: MarkdownRepoPath[] = [];
  const add = (raw: string, fromRoot: boolean): void => {
    if (/^(?:[a-z][\w+.-]*:|#|\/\/|\/)/i.test(raw) || /[*<>{}$\s]|\.\.\./.test(raw)) {
      return;
    }
    const target = path.posix.normalize(
      path.posix.join(
        fromRoot ? "" : path.posix.dirname(file),
        decodeURI(raw.split(/[?#]/)[0]).replace(/:\d+(?:-\d+)?$/, ""),
      ),
    );
    references.push({ target, missing: !exists(target) && !Object.hasOwn(allowlist, target) });
  };
  // Inline/image links, optional titles, and angle-bracket destinations.
  for (const match of prose.matchAll(
    /!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
  )) {
    add(match[1].replace(/^<|>$/g, ""), false);
  }
  // Reference-style link definitions (including images).
  for (const match of prose.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)) {
    add(match[1].replace(/^<|>$/g, ""), false);
  }
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    if (REPO_PATH.test(match[1])) {
      add(match[1], true);
    }
  }
  return references;
}

export function staleMarkdownAllowlist(
  allowlist: Readonly<Record<string, string>>,
  referenced: ReadonlySet<string>,
  exists: (target: string) => boolean,
): string[] {
  return Object.keys(allowlist).filter((target) => exists(target) || !referenced.has(target));
}
