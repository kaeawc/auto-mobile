import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/ArchiveExtractor.ts";

/** Repo-relative path with forward slashes so comparisons hold on Windows. */
function repoRelative(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

/**
 * Detect a production `tar` extraction executed outside the archive-extraction
 * owner. Matches a launch API (spawn/exec/executeCommand) whose command is the
 * `tar` binary together with an extract flag, whether written as a single
 * shell string or argv-first, and regardless of where the extract flag sits in
 * the argument order.
 *
 * "Extract flag" means `--extract` or a single-dash short-option bundle that
 * contains `x` (`-x`, `-xf`, `-xzf`, `-vxf`, …). It deliberately does NOT match
 * create/list flags (`-c…`, `-t…`, which carry no `x`), the `-C` change-dir
 * option (uppercase), or the double-dash `--exclude` (an extract bundle is
 * single-dash only). Residual limits: the arg array must be a single-line
 * literal, the command name must be the literal `"tar"` (a path- or
 * variable-resolved `tar` is not caught here — the host-shell boundary guards
 * the shell-string path), and args built from variables are not inspected.
 */
function directlyExtractsTar(source: string): boolean {
  const launcher = "(?:spawn|spawnSync|execFile|execFileSync|exec|executeCommand|Bun\\.spawn)";
  // An extract flag token: `--extract`, or a single-dash bundle containing `x`.
  const extractFlag = "(?:--extract|-[a-z]*x[a-z]*)";
  // Shell-string form: exec("tar -xzf …") / exec("tar -C dst --extract -f …").
  const shellString = new RegExp(`${launcher}\\s*\\(\\s*["'\`]\\s*tar\\s+[^"'\`]*${extractFlag}`, "i");
  // Argv-first form: executeCommand("tar", ["-xzf", …]) / spawn("tar", ["-C", d, "-x", …]).
  // The extract flag may appear at any position in the (single-line) array literal.
  const argvForm = new RegExp(`${launcher}\\s*\\(\\s*["'\`]tar["'\`]\\s*,\\s*\\[[^\\]]*["'\`]${extractFlag}["'\`]`, "i");
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
      const repoPath = repoRelative(file);
      if (repoPath === OWNER || exceptions.has(repoPath)) {return [];}
      const source = readFileSync(file, "utf8");
      return directlyExtractsTar(source)
        ? [`${repoPath} directly runs tar extraction; route it through ${OWNER} instead.`]
        : [];
    });

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("detects argv-first tar extraction regardless of flag position or order", () => {
    expect(directlyExtractsTar(
      'await executor.executeCommand("tar", ["-xzf", archivePath, "-C", dir]);'
    )).toBe(true);
    expect(directlyExtractsTar(
      'spawn("tar", ["-x", "-f", archivePath]);'
    )).toBe(true);
    // Extract flag after a leading -C change-dir option.
    expect(directlyExtractsTar(
      'spawn("tar", ["-C", dir, "-xzf", archivePath]);'
    )).toBe(true);
    // Long-form --extract.
    expect(directlyExtractsTar(
      'execFile("tar", ["--extract", "--file", archivePath]);'
    )).toBe(true);
    // Verbose bundle containing x.
    expect(directlyExtractsTar(
      'spawn("tar", ["-vxf", archivePath]);'
    )).toBe(true);
  });

  test("detects shell-string tar extraction regardless of flag position", () => {
    expect(directlyExtractsTar('exec("tar -xzf archive.tar.gz -C dest");')).toBe(true);
    expect(directlyExtractsTar('exec("tar -C dest --extract -f archive.tar.gz");')).toBe(true);
  });

  test("does not flag tar creation, listing, or non-extract options", () => {
    expect(directlyExtractsTar('executeCommand("tar", ["-czf", archivePath, dir]);')).toBe(false);
    expect(directlyExtractsTar('executeCommand("tar", ["-tzf", archivePath]);')).toBe(false);
    // `-C` change-dir on its own is not extraction.
    expect(directlyExtractsTar('executeCommand("tar", ["-C", dir]);')).toBe(false);
    // `--exclude` is a double-dash flag, not a single-dash extract bundle.
    expect(directlyExtractsTar('executeCommand("tar", ["--exclude", pattern, "-czf", archivePath]);')).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the owner.
    ]);
    expect([...exceptions.keys()].filter(path => !sourceFiles(join(ROOT, "src")).some(file => repoRelative(file) === path))).toEqual([]);
  });
});
