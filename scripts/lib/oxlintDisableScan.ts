// Comment scan for inline lint suppressions, used by scripts/oxlint-baseline.sh.
//
// oxlint drops a diagnostic that an inline `oxlint-disable*` directive covers, so
// the count-based ratchet alone cannot see it. This scanner counts the
// directives themselves so a NEW suppression fails the same ratchet.
//
// Emits sorted "<count>\t<file>\t<key>" rows (the ratchet's row format):
//   oxlint-disable(<rule>)            one per directive per rule
//   oxlint-disable-no-reason(<rule>)  the subset with no `-- reason` suffix
// `eslint-disable*` directives are counted as the same thing (oxlint honours
// them), with a leading `eslint/` stripped from the rule so `eslint/complexity`
// and `complexity` share a key. A directive naming several rules counts once per
// rule; a bare directive counts under `*`. `-enable` directives are ignored.
//
// Directive text inside string/template literals is skipped (single-line
// quote tracking); a regex literal containing a quote can still confuse it,
// which errs toward fewer rows -- acceptable for a ratchet over a lint-clean tree.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])(.*)$/s;
const SCAN_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

export interface Directive {
  rules: string[];
  hasReason: boolean;
}

export function normalizeRule(rule: string): string {
  return rule.replace(/^eslint\//, "");
}

function parseDirective(commentBody: string, isBlock: boolean): Directive | null {
  const m = DIRECTIVE.exec(commentBody);
  if (!m) {
    return null;
  }
  let rest = m[1];
  if (isBlock) {
    const end = rest.indexOf("*/");
    rest = end === -1 ? rest : rest.slice(0, end);
  }
  const sep = rest.search(/\s--(?:\s|$)/);
  const rulesPart = sep === -1 ? rest : rest.slice(0, sep);
  const reason = sep === -1 ? "" : rest.slice(sep).replace(/^\s--/, "").trim();
  const rules = rulesPart
    .split(",")
    .map((r) => normalizeRule(r.trim()))
    .filter(Boolean);
  return { rules: rules.length ? [...new Set(rules)] : ["*"], hasReason: reason.length > 0 };
}

/** Find every suppression directive in a source text. */
export function findDirectives(source: string): Directive[] {
  const found: Directive[] = [];
  for (const line of source.split("\n")) {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\") {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      const two = line.slice(i, i + 2);
      if (two === "//" || two === "/*") {
        const d = parseDirective(line.slice(i + 2), two === "/*");
        if (d) {
          found.push(d);
        }
        break;
      }
    }
  }
  return found;
}

export function countRows(file: string, source: string, counts: Map<string, number>): void {
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const d of findDirectives(source)) {
    for (const rule of d.rules) {
      bump(`${file}\toxlint-disable(${rule})`);
      if (!d.hasReason) {
        bump(`${file}\toxlint-disable-no-reason(${rule})`);
      }
    }
  }
}

function walk(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    // A missing scan directory simply has no directives to count.
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "generated") {
        walk(root, rel, out);
      }
    } else if (SCAN_EXTENSIONS.test(e.name) && !e.name.endsWith(".generated.ts")) {
      out.push(rel);
    }
  }
}

export function scanDirs(root: string, dirs: string[]): string {
  const files: string[] = [];
  dirs.forEach((d) => walk(root, d, files));
  const counts = new Map<string, number>();
  files.forEach((f) => countRows(f, readFileSync(join(root, f), "utf8"), counts));
  const lines = [...counts.entries()].map(([k, n]) => `${n}\t${k}`).sort();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

if (import.meta.main) {
  const [root, ...dirs] = process.argv.slice(2);
  process.stdout.write(scanDirs(root, dirs.length ? dirs : ["src"]));
}
