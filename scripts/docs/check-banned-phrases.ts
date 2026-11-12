#!/usr/bin/env bun
/**
 * Fails when docs/ prose uses a phrase from scripts/docs/banned-phrases.json
 * that scripts/docs/banned-phrases-allowlist.json does not cover (#18143).
 *
 * Usage: bun scripts/docs/check-banned-phrases.ts [file.md ...]
 * Without arguments every docs/**\/*.md file is checked.
 */
import { join, relative } from "node:path";
import {
  type Allowlist,
  type BannedPhraseList,
  type PhraseHit,
  applyAllowlist,
  findBannedPhrases,
  formatHit,
} from "./bannedPhrases";

const ROOT = join(import.meta.dir, "../..");
const LIST_PATH = join(import.meta.dir, "banned-phrases.json");
const ALLOWLIST_PATH = join(import.meta.dir, "banned-phrases-allowlist.json");

async function docsFiles(args: string[]): Promise<string[]> {
  if (args.length > 0) {
    return args.map((arg) => relative(ROOT, join(process.cwd(), arg)).replaceAll("\\", "/"));
  }
  const files = await Array.fromAsync(new Bun.Glob("docs/**/*.md").scan({ cwd: ROOT }));
  return files.map((file) => file.replaceAll("\\", "/")).sort();
}

async function main(): Promise<number> {
  const list: BannedPhraseList = await Bun.file(LIST_PATH).json();
  const allowlist: Allowlist = await Bun.file(ALLOWLIST_PATH).json();
  const files = await docsFiles(process.argv.slice(2));
  const hits: PhraseHit[] = [];
  for (const file of files) {
    hits.push(...findBannedPhrases(file, await Bun.file(join(ROOT, file)).text(), list.rules));
  }
  // With explicit files, entries for unchecked files are out of scope, not stale. A full scan
  // keeps every entry so one for a moved or deleted file is reported as stale.
  const checked = new Set(files);
  const scoped: Allowlist =
    process.argv.length > 2
      ? { entries: allowlist.entries.filter((entry) => checked.has(entry.file)) }
      : allowlist;
  const result = applyAllowlist(hits, scoped, list.rules);
  for (const problem of result.invalid) {
    console.error(`banned-phrases allowlist: ${problem}`);
  }
  for (const hit of result.violations) {
    console.error(formatHit(hit));
  }
  for (const entry of result.stale) {
    console.error(
      `banned-phrases allowlist: ${entry.file} (${entry.rule}) allows ${entry.count} but found ${entry.actual}; lower or remove the entry`,
    );
  }
  const failures = result.invalid.length + result.violations.length + result.stale.length;
  if (failures > 0) {
    console.error(
      `\n${result.violations.length} banned phrase(s) in docs/. Rewrite them, or add a reviewed entry with a reason to scripts/docs/banned-phrases-allowlist.json.`,
    );
    return 1;
  }
  console.log(`banned-phrases: ${files.length} docs file(s) clean`);
  return 0;
}

process.exit(await main());
