// Comment scan for inline lint suppressions, used by scripts/oxlint-baseline.sh.
//
// oxlint drops a diagnostic that an inline suppression directive covers, so the
// count-based ratchet alone cannot see it. This scanner counts the directives
// themselves so a NEW suppression fails the same ratchet.
//
// Comments come from the TypeScript scanner (every token's leading and trailing
// comment ranges), so only real comments count: text in string/template/regex
// literals, or on a later line of a block comment, is never a directive.
//
// Output is sorted "<count>\t<file>\t<key>" rows (the ratchet's row format), with
// four key shapes: "oxlint-disable(<rule>)" for each -next-line/-line directive,
// "oxlint-disable-block(<rule>)" for an unbounded disable a later enable closes,
// "oxlint-disable-file(<rule>)" for one that runs to the end of the file (separate
// keys, so widening a suppression, or dropping its closing enable, is a new row), and
// "oxlint-disable-no-reason(<rule>)" for those without a `-- reason` suffix.
// The `eslint-` spelling of each directive is counted identically (oxlint honours
// it) and a leading `eslint/` is stripped from the rule. A directive naming
// several rules counts once per rule; a bare one counts under `*`. The
// next-line, line and block forms count; the enable forms do not. Like oxlint, a
// directive must start the comment body, so a doc-comment line with a leading
// star is not one.
//
// Files: the repo-wide set oxlint lints, so a new root cannot bypass the ratchet.
// In a git work tree that is the tracked plus untracked-not-ignored files, else a
// full walk; either way only TypeScript-family extensions (oxlint ignores the
// JavaScript ones) minus the ignorePatterns of .oxlintrc.json. No files is an error.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Like oxlint, the directive keyword must be followed by whitespace or end the comment.
const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(-next-line|-line)?(?=\s|$)(.*)$/s;
const ENABLE = /^\s*(?:oxlint|eslint)-enable(?=\s|$)(.*)$/s;
const SCAN_EXTENSIONS = /\.(?:[cm]?ts|tsx)$/;

export interface Directive {
  rules: string[];
  hasReason: boolean;
  /** "line" for the -next-line/-line forms; "file" for the unbounded form, which covers the rest of the file. */
  scope: "line" | "file";
  /**
   * For an unbounded disable: the rules a later enable directive closes. Each is
   * counted under its own key, so deleting or moving that closer (which extends the
   * suppression to the end of the file) turns it into a new file-scope row.
   */
  closed?: string[];
}

/** Rule list of an enable directive (`*` when bare), or null when the comment is not one. */
export function parseEnable(commentBody: string): string[] | null {
  const m = ENABLE.exec(commentBody);
  if (!m) {
    return null;
  }
  const rules = splitRules(m[1].split(/\s-{2,}/)[0]);
  return rules.length ? rules : ["*"];
}

function splitRules(text: string): string[] {
  // oxlint splits the rule list on commas or whitespace.
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((r) => normalizeRule(r.trim()))
        .filter(Boolean),
    ),
  ];
}

export function normalizeRule(rule: string): string {
  return rule.replace(/^eslint\//, "");
}

export function parseDirective(commentBody: string): Directive | null {
  const m = DIRECTIVE.exec(commentBody);
  if (!m) {
    return null;
  }
  const scope = m[1] ? "line" : "file";
  const rest = m[2];
  // ESLint's description separator: whitespace, then two or more dashes. A
  // no-space "--reason" still starts the reason rather than polluting a rule key.
  const sep = rest.search(/\s-{2,}/);
  const rulesPart = sep === -1 ? rest : rest.slice(0, sep);
  const reason = sep === -1 ? "" : rest.slice(sep).replace(/^\s-+/, "").trim();
  const rules = splitRules(rulesPart);
  return {
    rules: rules.length ? rules : ["*"],
    hasReason: reason.length > 0,
    scope,
  };
}

function commentBody(source: string, range: ts.CommentRange): string {
  const text = source.slice(range.pos, range.end);
  if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    return text.slice(2);
  }
  return text.slice(2).replace(/\*\/$/, "");
}

// getChildren (not forEachChild) so punctuation tokens, which carry comments, are visited.
function collectTokens(node: ts.Node, sf: ts.SourceFile, visit: (token: ts.Node) => void): void {
  const children = node.getChildren(sf);
  if (children.length === 0) {
    visit(node);
    return;
  }
  children.forEach((child) => collectTokens(child, sf, visit));
}

/** Find every suppression directive in a source text. */
export function findDirectives(source: string, fileName = "input.tsx"): Directive[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  const comments: Array<{ pos: number; body: string }> = [];
  const take = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (!seen.has(range.pos)) {
        seen.add(range.pos);
        comments.push({ pos: range.pos, body: commentBody(source, range) });
      }
    }
  };
  collectTokens(sf, sf, (token) => {
    take(ts.getLeadingCommentRanges(source, token.getFullStart()));
    take(ts.getTrailingCommentRanges(source, token.end));
  });
  comments.sort((a, b) => a.pos - b.pos);
  const found: Directive[] = [];
  // Unbounded disables still open, per rule, awaiting a closing enable.
  const open: Array<{ directive: Directive; rule: string }> = [];
  for (const { body } of comments) {
    const d = parseDirective(body);
    if (d) {
      found.push(d);
      if (d.scope === "file") {
        d.closed = [];
        open.push(...d.rules.map((rule) => ({ directive: d, rule })));
      }
      continue;
    }
    const enabled = parseEnable(body);
    if (enabled) {
      // A bare enable closes everything; a named one closes only those rules.
      for (let i = open.length - 1; i >= 0; i--) {
        if (enabled.includes("*") || enabled.includes(open[i].rule)) {
          open[i].directive.closed!.push(open[i].rule);
          open.splice(i, 1);
        }
      }
    }
  }
  return found;
}

function keyFor(d: Directive, rule: string): string {
  if (d.scope === "line") {
    return "oxlint-disable";
  }
  return d.closed?.includes(rule) ? "oxlint-disable-block" : "oxlint-disable-file";
}

export function countRows(file: string, source: string, counts: Map<string, number>): void {
  // Cheap prefilter: parsing thousands of files is slow, and most have no directive text.
  if (!/(?:oxlint|eslint)-disable/.test(source)) {
    return;
  }
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const d of findDirectives(source, file)) {
    for (const rule of d.rules) {
      bump(`${file}\t${keyFor(d, rule)}(${rule})`);
      if (!d.hasReason) {
        bump(`${file}\toxlint-disable-no-reason(${rule})`);
      }
    }
  }
}

const IGNORE_CONFIG = ".oxlintrc.json";

/** The oxlint `ignorePatterns` of <root>/.oxlintrc.json (JSONC), as globs. */
export function readIgnoreGlobs(root: string): Bun.Glob[] {
  let text: string;
  try {
    text = readFileSync(join(root, IGNORE_CONFIG), "utf8");
  } catch (error) {
    // A scan root without an oxlint config (test fixtures) ignores nothing.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  // The TypeScript JSONC reader handles the comments and trailing commas oxlint accepts.
  const parsed = ts.parseConfigFileTextToJson(IGNORE_CONFIG, text);
  if (parsed.error) {
    throw new Error(`oxlint-disable scan: cannot parse ${IGNORE_CONFIG}`);
  }
  const patterns: unknown = parsed.config?.ignorePatterns ?? [];
  return (Array.isArray(patterns) ? patterns : []).map((p) => new Bun.Glob(String(p)));
}

/** Lists candidate files under root, or null when root is not a git work tree (walk instead). */
export type FileLister = (root: string) => string[] | null;

/** Tracked plus untracked-not-ignored files when root IS a git work tree, else null. */
export const gitFiles: FileLister = (root) => {
  const top = Bun.spawnSync(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (top.exitCode !== 0 || realpathSync(top.stdout.toString().trim()) !== realpathSync(root)) {
    return null;
  }
  const ls = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { stdout: "pipe", stderr: "pipe", maxBuffer: 256 * 1024 * 1024 },
  );
  if (ls.exitCode !== 0) {
    throw new Error(`oxlint-disable scan: git ls-files failed: ${ls.stderr.toString().trim()}`);
  }
  return ls.stdout.toString().split("\0").filter(Boolean);
};

function walkAll(root: string, rel: string, out: string[]): void {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".git") {
        walkAll(root, child, out);
      }
    } else {
      out.push(child);
    }
  }
}

/** The files oxlint lints under root: repo-wide, TypeScript-family, minus ignorePatterns. */
export function listLintedFiles(root: string, lister: FileLister = gitFiles): string[] {
  let all = lister(root);
  if (all === null) {
    all = [];
    walkAll(root, "", all);
  }
  const ignores = readIgnoreGlobs(root);
  return all
    .filter((f) => SCAN_EXTENSIONS.test(f))
    .filter((f) => !ignores.some((g) => g.match(f)))
    .filter((f) => {
      try {
        return statSync(join(root, f)).isFile();
      } catch {
        // A tracked file deleted in the work tree has nothing to scan.
        return false;
      }
    })
    .sort();
}

/** Scan every file oxlint lints; fails closed when none are found. */
export function scanRepo(root: string, lister: FileLister = gitFiles): string {
  const files = listLintedFiles(root, lister);
  if (files.length === 0) {
    throw new Error("oxlint-disable scan: no source files found");
  }
  const counts = new Map<string, number>();
  files.forEach((f) => countRows(f, readFileSync(join(root, f), "utf8"), counts));
  const lines = [...counts.entries()].map(([k, n]) => `${n}\t${k}`).sort();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

if (import.meta.main) {
  // Usage: oxlintDisableScan.ts <root>
  try {
    process.stdout.write(scanRepo(process.argv[2]));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  }
}
