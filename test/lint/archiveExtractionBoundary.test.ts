import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/ArchiveExtractor.ts";

/** Repo-relative path with forward slashes so comparisons hold on Windows. */
function repoRelative(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

// Launch APIs whose command is `tar`. Property-access callees (`Bun.spawn`,
// `executor.executeCommand`) match on the trailing member name, so `spawn`
// covers `Bun.spawn` and `executeCommand` covers `executor.executeCommand`.
const LAUNCHER_NAMES = new Set([
  "spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "executeCommand"
]);

// An extract flag token: `--extract`/`--get`, or a single-dash bundle containing
// `x` (`-x`, `-xf`, `-xzf`, `-vxf`, …). Deliberately NOT create/list bundles
// (`-c…`, `-t…`, no `x`), the uppercase `-C` change-dir option, or `--exclude`.
const EXTRACT_FLAG = /^(?:--extract|--get|-[a-z]*x[a-z]*)$/i;
// Shell-string form: one argument that is the whole `tar … <extract-flag> …` line.
const SHELL_TAR_EXTRACT = /(?:^|\s)tar\s+[\s\S]*?(?:--extract|--get|-[a-z]*x[a-z]*)(?:\s|$)/i;

/**
 * Detect a production `tar` extraction executed outside the archive-extraction
 * owner, by parsing the TypeScript source (AGENTS.md: structured parsing over
 * line regexes). Finds a launcher call (`spawn`/`exec`/`executeCommand`/
 * `Bun.spawn`/…) whose resolved string arguments name the `tar` command together
 * with an extract flag — as a shell string, argv-first, array-first, or with the
 * argv held in a `const` array/string, and regardless of flag position or line
 * breaks. Identifier arguments are followed to their same-file `const`
 * initializers, so an ordinary `const args = ["-xzf", a]; spawn("tar", args)`
 * refactor is still caught.
 *
 * Residual limit: the command token must be the literal `"tar"`. A path- or
 * fully-variable-resolved command (`spawn("/usr/bin/tar", …)`, or a `tar` held in
 * a non-array variable) is not classified here; the shell-string form of that is
 * covered by the host-shell boundary guard, and the argv-first path-qualified
 * form requires deliberately bypassing the HostCommandExecutor seam.
 */
function directlyExtractsTar(source: string): boolean {
  // Cheap pre-filter: only files that mention tar are worth parsing.
  if (!source.includes("tar")) {return false;}
  const sourceFile = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const constInitializers = collectConstInitializers(sourceFile);

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {return;}
    if (ts.isCallExpression(node) && isLauncherCallee(node.expression)) {
      const tokens = node.arguments.flatMap(arg => resolveStringValues(arg, constInitializers, new Set()));
      const namesTar = tokens.some(value => value === "tar");
      const hasExtractFlag = tokens.some(value => EXTRACT_FLAG.test(value));
      const shellForm = tokens.some(value => SHELL_TAR_EXTRACT.test(value));
      if (shellForm || (namesTar && hasExtractFlag)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The trailing name of a call target: `spawn`, or `spawn` of `Bun.spawn`. */
function isLauncherCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {return LAUNCHER_NAMES.has(expression.text);}
  if (ts.isPropertyAccessExpression(expression)) {return LAUNCHER_NAMES.has(expression.name.text);}
  return false;
}

/** Map every `const` name to its initializer expression, for identifier following. */
function collectConstInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializers;
}

/**
 * Flatten an argument to the string values it can contribute: string/template
 * literals directly, array literals element-wise, and identifiers via their
 * `const` initializer. `seen` guards against cyclic references.
 */
function resolveStringValues(node: ts.Expression, initializers: Map<string, ts.Expression>, seen: Set<string>): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {return [node.text];}
  if (ts.isTemplateExpression(node)) {
    // Keep the static parts so `tar -xzf ${x}` still reads as a shell tar-extract.
    return [node.head.text + node.templateSpans.map(span => span.literal.text).join(" ")];
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(element => resolveStringValues(element, initializers, seen));
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) {return [];}
    const initializer = initializers.get(node.text);
    if (!initializer) {return [];}
    return resolveStringValues(initializer, initializers, new Set([...seen, node.text]));
  }
  return [];
}

/**
 * Files allowed to reference `tar` extraction outside the owner, each with a
 * concrete reason. Keep empty unless a production diagnostic cannot use the owner.
 * Shared by both the enforcing test and the stale-exception ratchet so the ratchet
 * validates the exceptions that are actually in force.
 */
const EXCEPTIONS = new Map<string, string>([
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("archive extraction boundary (issue #4065)", () => {
  test("only ArchiveExtractor directly runs tar extraction", () => {
    const offenders = sourceFiles(join(ROOT, "src")).flatMap(file => {
      const repoPath = repoRelative(file);
      if (repoPath === OWNER || EXCEPTIONS.has(repoPath)) {return [];}
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

  test("detects array-first tar extraction (Bun.spawn's single-array signature)", () => {
    expect(directlyExtractsTar('Bun.spawn(["tar", "-xzf", archivePath, "-C", dir]);')).toBe(true);
    expect(directlyExtractsTar('spawn(["tar", "-x", "-f", archivePath]);')).toBe(true);
    // Extract flag after a leading -C change-dir option, still one array.
    expect(directlyExtractsTar('Bun.spawn(["tar", "-C", dir, "--extract", "-f", archivePath]);')).toBe(true);
    // Creation in array-first form is still not extraction.
    expect(directlyExtractsTar('Bun.spawn(["tar", "-czf", archivePath, dir]);')).toBe(false);
  });

  test("follows a const argv initializer (the ordinary refactor form)", () => {
    expect(directlyExtractsTar('const args = ["-xzf", archive]; spawn("tar", args);')).toBe(true);
    expect(directlyExtractsTar('const argv = ["tar", "-xzf", archive]; Bun.spawn(argv);')).toBe(true);
    // A const create-argv is still not extraction.
    expect(directlyExtractsTar('const args = ["-czf", archive]; spawn("tar", args);')).toBe(false);
  });

  test("detects long-form --extract / --get and multiline argv", () => {
    expect(directlyExtractsTar('execFile("tar", ["--get", "--file", archive]);')).toBe(true);
    expect(directlyExtractsTar('spawn("tar", [\n  "-C", dir,\n  "-xzf",\n  archive\n]);')).toBe(true);
    expect(directlyExtractsTar("exec(`tar -xzf ${archive} -C ${dir}`);")).toBe(true);
  });

  test("every documented exception still exists", () => {
    expect([...EXCEPTIONS.keys()].filter(path => !sourceFiles(join(ROOT, "src")).some(file => repoRelative(file) === path))).toEqual([]);
  });
});
