import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/ArchiveExtractor.ts";

/**
 * Detect a production `tar` extraction executed outside the archive-extraction
 * owner. Matches a launch API (spawn/exec/executeCommand) whose command is the
 * `tar` binary together with an extract flag (`-x…`), whether written as a
 * single shell string or argv-first.
 */
function directlyExtractsTar(source: string): boolean {
  const launcher = "(?:spawn|spawnSync|execFile|execFileSync|exec|executeCommand|Bun\\.spawn)";
  // Shell-string form: exec("tar -xzf ...") / spawn("tar", ...) with an -x flag nearby.
  const shellString = new RegExp(`${launcher}\\s*\\(\\s*["'\`]\\s*tar\\s+[^"'\`]*-x`, "i");
  // Argv-first form: executeCommand("tar", ["-xzf", ...]) / spawn("tar", ["-x...", ...]).
  const argvForm = new RegExp(`${launcher}\\s*\\(\\s*["'\`]tar["'\`]\\s*,\\s*\\[\\s*["'\`]-x`, "i");
  return shellString.test(source) || argvForm.test(source);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("archive extraction boundary (issue #4065)", () => {
  test("only ArchiveExtractor directly runs tar extraction", () => {
    const exceptions = new Map<string, string>([
      // Diagnostic-only references are allowed only with a concrete reason here.
    ]);
    const offenders = sourceFiles(join(ROOT, "src")).flatMap(file => {
      const repoPath = relative(ROOT, file);
      if (repoPath === OWNER || exceptions.has(repoPath)) {return [];}
      const source = readFileSync(file, "utf8");
      return directlyExtractsTar(source)
        ? [`${repoPath} directly runs tar extraction; route it through ${OWNER} instead.`]
        : [];
    });

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("detects argv-first tar extraction", () => {
    expect(directlyExtractsTar(
      'await executor.executeCommand("tar", ["-xzf", archivePath, "-C", dir]);'
    )).toBe(true);
    expect(directlyExtractsTar(
      'spawn("tar", ["-x", "-f", archivePath]);'
    )).toBe(true);
  });

  test("detects shell-string tar extraction", () => {
    expect(directlyExtractsTar('exec("tar -xzf archive.tar.gz -C dest");')).toBe(true);
  });

  test("does not flag tar creation or listing", () => {
    expect(directlyExtractsTar('executeCommand("tar", ["-czf", archivePath, dir]);')).toBe(false);
    expect(directlyExtractsTar('executeCommand("tar", ["-tzf", archivePath]);')).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the owner.
    ]);
    expect([...exceptions.keys()].filter(path => !sourceFiles(join(ROOT, "src")).some(file => relative(ROOT, file) === path))).toEqual([]);
  });
});
