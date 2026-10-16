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
// two key shapes: "oxlint-disable(<rule>)" for every directive and
// "oxlint-disable-no-reason(<rule>)" for those without a `-- reason` suffix.
// The `eslint-` spelling of each directive is counted identically (oxlint honours
// it) and a leading `eslint/` is stripped from the rule. A directive naming
// several rules counts once per rule; a bare one counts under `*`. The
// next-line, line and block forms count; the enable forms do not. Like oxlint, a
// directive must start the comment body, so a doc-comment line with a leading
// star is not one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])(.*)$/s;
const SCAN_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

export interface Directive {
  rules: string[];
  hasReason: boolean;
}

export function normalizeRule(rule: string): string {
  return rule.replace(/^eslint\//, "");
}

export function parseDirective(commentBody: string): Directive | null {
  const m = DIRECTIVE.exec(commentBody);
  if (!m) {
    return null;
  }
  const rest = m[1];
  // ESLint's description separator: whitespace, then two or more dashes. A
  // no-space "--reason" still starts the reason rather than polluting a rule key.
  const sep = rest.search(/\s-{2,}/);
  const rulesPart = sep === -1 ? rest : rest.slice(0, sep);
  const reason = sep === -1 ? "" : rest.slice(sep).replace(/^\s-+/, "").trim();
  const rules = rulesPart
    .split(",")
    .map(r => normalizeRule(r.trim()))
    .filter(Boolean);
  return { rules: rules.length ? [...new Set(rules)] : ["*"], hasReason: reason.length > 0 };
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
  children.forEach(child => collectTokens(child, sf, visit));
}

/** Find every suppression directive in a source text. */
export function findDirectives(source: string, fileName = "input.tsx"): Directive[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  const found: Directive[] = [];
  const take = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) {
        continue;
      }
      seen.add(range.pos);
      const d = parseDirective(commentBody(source, range));
      if (d) {
        found.push(d);
      }
    }
  };
  collectTokens(sf, sf, token => {
    take(ts.getLeadingCommentRanges(source, token.getFullStart()));
    take(ts.getTrailingCommentRanges(source, token.end));
  });
  return found;
}

export function countRows(file: string, source: string, counts: Map<string, number>): void {
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const d of findDirectives(source, file)) {
    for (const rule of d.rules) {
      bump(`${file}\toxlint-disable(${rule})`);
      if (!d.hasReason) {
        bump(`${file}\toxlint-disable-no-reason(${rule})`);
      }
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function walk(root: string, rel: string, out: string[], optional: boolean): void {
  let isDir: boolean;
  try {
    isDir = statSync(join(root, rel)).isDirectory();
  } catch (error) {
    // Only an optional root may be absent; a missing required root must fail closed.
    if (optional && isMissing(error)) {
      return;
    }
    throw new Error(`oxlint-disable scan: cannot read required root '${rel}'`, { cause: error });
  }
  if (!isDir) {
    out.push(rel);
    return;
  }
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "generated") {
        walk(root, child, out, false);
      }
    } else if (SCAN_EXTENSIONS.test(e.name) && !e.name.endsWith(".generated.ts")) {
      out.push(child);
    }
  }
}

/** Scan required roots (must exist) and optional roots (may be absent). */
export function scanRoots(root: string, required: string[], optional: string[] = []): string {
  const files: string[] = [];
  required.forEach(d => walk(root, d, files, false));
  optional.forEach(d => walk(root, d, files, true));
  if (files.length === 0) {
    throw new Error("oxlint-disable scan: no source files found");
  }
  const counts = new Map<string, number>();
  files.forEach(f => countRows(f, readFileSync(join(root, f), "utf8"), counts));
  const lines = [...counts.entries()].map(([k, n]) => `${n}\t${k}`).sort();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

if (import.meta.main) {
  // Usage: oxlintDisableScan.ts <root> <required-dir>... [--optional <path>...]
  const [root, ...rest] = process.argv.slice(2);
  const split = rest.indexOf("--optional");
  const required = split === -1 ? rest : rest.slice(0, split);
  const optional = split === -1 ? [] : rest.slice(split + 1);
  try {
    process.stdout.write(scanRoots(root, required, optional));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  }
}
