import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import { executionBoundaryAst } from "./lib/executionBoundaryAst";

// The single home of the archive-extraction boundary guard (issue #4065). Both the fast-validate
// check and test/lint/archiveExtractionBoundary.test.ts import `directlyExtractsTar` from here so
// there is exactly one detector. It parses TypeScript structurally (AGENTS.md: no line regexes for
// TS) and reports a launcher call whose *command position* is `tar` together with an extract flag,
// whether written as a shell string, argv-first, array-first, via `const` argv, a spread, or a
// static string concatenation.
export const SOURCE_ROOT = "src";
export const OWNER = "src/utils/ArchiveExtractor.ts";
// Files allowed to run tar extraction outside the owner, each with a concrete reason. Keep empty
// unless a production diagnostic genuinely cannot use the owner.
export const EXCEPTIONS = new Map<string, string>();

const LAUNCHER_NAMES = new Set([
  "spawn",
  "spawnSync",
  "spawnCommand",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "executeCommand",
  "runExecSeam",
]);

// An extract flag token: `--extract`/`--get`, or a single-dash bundle containing `x` (`-x`, `-xf`,
// `-xzf`, `-vxf`, …). Deliberately NOT create/list bundles (`-c…`, `-t…`, no `x`), the uppercase
// `-C` change-dir option, or `--exclude`.
const EXTRACT_FLAG = /^(?:--extract|--get|-[a-z]*x[a-z]*)$/i;
// Shell-string form: one command string that is the whole `tar … <extract-flag> …` line.
const SHELL_TAR_EXTRACT = /(?:^|\s)tar\s+[\s\S]*?(?:--extract|--get|-[a-z]*x[a-z]*)(?:\s|$)/i;

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {return expression.text;}
  if (ts.isPropertyAccessExpression(expression)) {return expression.name.text;}
  return undefined;
}

/** The fully-static string value of an expression, or undefined if any part is dynamic. */
function staticText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) {return node.text;}
  if (ts.isParenthesizedExpression(node)) {return staticText(node.expression);}
  if (ts.isTemplateExpression(node)) {
    // Join static chunks with a separator no token can contain, so a match must sit wholly inside
    // one chunk rather than spanning an interpolation.
    return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join("\u0000");
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

export function directlyExtractsTar(source: string): boolean {
  // Narrow prefilter (keeps the whole-tree scan cheap): the file must both name a launcher and
  // mention `tar` as a whole word — this skips incidental substrings like `start`/`target`.
  if (!/\btar\b/i.test(source)) {return false;}
  if (![...LAUNCHER_NAMES].some(name => source.includes(name))) {return false;}

  const sharedAst = executionBoundaryAst(source);
  if (sharedAst.calls.some(call => {
    if (!sharedAst.isLauncher(call) && !sharedAst.isExecutionSeam(call)) {return false;}
    if (sharedAst.calleeName(call) === "runExecSeam" || call.arguments.length >= 3) {
      const values = sharedAst.strings(call.arguments[2]);
      return values.includes("tar") && values.some(value => EXTRACT_FLAG.test(value));
    }
    const array = sharedAst.arrayElements(call.arguments[0]);
    const command = array?.[0] ?? call.arguments[0];
    const args = array ? array.slice(1) : call.arguments.slice(1);
    if (sharedAst.strings(command).some(value => SHELL_TAR_EXTRACT.test(value))) {return true;}
    return sharedAst.strings(command).includes("tar") && args.some(argument =>
      sharedAst.strings(argument).some(value => EXTRACT_FLAG.test(value)));
  })) {return true;}

  const sourceFile = ts.createSourceFile(
    "archive-boundary.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // Every value bound to a name, keyed by bare spelling (not scope). A name bound anywhere in the
  // file contributes all of its values to every use, so a shadowed `const args` cannot hide a real
  // extraction — deliberate over-detection: a false CI failure is loud and fixable, a missed
  // `spawn("tar", args)` is not.
  const initializers = new Map<string, ts.Expression[]>();
  const bind = (name: string, value: ts.Expression): void => {
    initializers.set(name, [...(initializers.get(name) ?? []), value]);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bind(node.name.text, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)) {
      bind(node.left.text, node.right);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // The set of static string values an expression can resolve to: literals/templates/static
  // concatenations directly, array elements and spreads element-wise, and identifiers via their
  // bound initializers. Memoized by node (keeps a repeated-reference spread chain linear); `seen`
  // guards identifier cycles.
  const memo = new Map<ts.Node, string[]>();
  const resolveStrings = (node: ts.Expression, seen: Set<string>): string[] => {
    const cached = memo.get(node);
    if (cached) {return cached;}
    const result = resolveStringsUncached(node, seen);
    memo.set(node, result);
    return result;
  };
  const resolveStringsUncached = (node: ts.Expression, seen: Set<string>): string[] => {
    const literal = staticText(node);
    if (literal !== undefined) {return [literal];}
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap(element => resolveStrings(element, seen));
    }
    if (ts.isSpreadElement(node)) {return resolveStrings(node.expression, seen);}
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {return [];}
      const bound = initializers.get(node.text);
      if (!bound) {return []; }
      const nextSeen = new Set([...seen, node.text]);
      return bound.flatMap(value => resolveStrings(value, nextSeen));
    }
    return [];
  };

  // Any static chunk inside the command position that reads as a shell `tar … -x …` line.
  const shellTarExtractChunks = (node: ts.Expression): boolean => {
    const literal = staticText(node);
    if (literal !== undefined) {return SHELL_TAR_EXTRACT.test(literal);}
    let found = false;
    ts.forEachChild(node, child => {
      if (!found && ts.isExpression(child) && shellTarExtractChunks(child)) {found = true;}
    });
    return found;
  };

  const namesTar = (node: ts.Expression): boolean => resolveStrings(node, new Set()).includes("tar");
  const hasExtractFlag = (node: ts.Expression): boolean =>
    resolveStrings(node, new Set()).some(value => EXTRACT_FLAG.test(value));

  // The element expressions of an array the node denotes — an inline literal, an identifier bound
  // to one, or either with `...spread`s expanded — or undefined when the node is not an array. Used
  // to split the array-first form's command (element 0) from its argv.
  const resolveArrayElements = (node: ts.Expression, seen: Set<string>): ts.Expression[] | undefined => {
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap(element =>
        ts.isSpreadElement(element) ? resolveArrayElements(element.expression, seen) ?? [] : [element]);
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {return undefined;}
      const bound = initializers.get(node.text);
      if (!bound) {return undefined;}
      const nextSeen = new Set([...seen, node.text]);
      const elements = bound.flatMap(value => resolveArrayElements(value, nextSeen) ?? []);
      return bound.some(value => resolveArrayElements(value, nextSeen) !== undefined) ? elements : undefined;
    }
    return undefined;
  };

  // A single launcher call extracts tar iff its command position is `tar` and an extract flag sits
  // in its argv (or its command is a shell `tar -x …` string). Splitting command from argv is what
  // keeps `spawn("echo", ["tar", "-x"])` — tar as data, not the command — from tripping the guard.
  const callExtractsTar = (call: ts.CallExpression): boolean => {
    if (call.arguments.length === 0) {return false;}
    const first = call.arguments[0];
    // Array-first form: launcher(["tar", "-xzf", …]) or launcher(argv) — command is element 0.
    const elements = resolveArrayElements(first, new Set());
    if (elements) {
      if (elements.length === 0) {return false;}
      const [command, ...argv] = elements;
      return namesTar(command) && argv.some(element => hasExtractFlag(element));
    }
    // Shell-string command: launcher("tar -xzf …") / launcher("tar -xzf " + archive).
    if (shellTarExtractChunks(first)) {return true;}
    // Command + argv form: launcher("tar", ["-xzf", …]) — an extract flag in any later argument.
    if (namesTar(first)) {
      return call.arguments.slice(1).some(argument => hasExtractFlag(argument));
    }
    return false;
  };

  let found = false;
  const inspect = (node: ts.Node): void => {
    if (found) {return;}
    if (ts.isCallExpression(node) && LAUNCHER_NAMES.has(calleeName(node.expression) ?? "") &&
      callExtractsTar(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return found;
}

export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Scan `<root>/src` for files that run tar extraction outside the owner. Returns one message per
 * offender; an empty array means the boundary holds. Files are read in parallel so the whole-tree
 * scan stays fast enough for a bun test running under coverage instrumentation.
 */
export async function findOffenders(root: string): Promise<string[]> {
  const sources = await Promise.all(sourceFiles(join(root, SOURCE_ROOT)).map(async file => ({
    // `relative` yields OS separators (backslashes on Windows); OWNER/EXCEPTIONS are keyed with
    // forward slashes, so normalize for the owner exclusion and portable messages.
    repoPath: relative(root, file).replace(/\\/g, "/"),
    source: await readFile(file, "utf8"),
  })));
  return sources.flatMap(({ repoPath, source }) =>
    repoPath !== OWNER && !EXCEPTIONS.has(repoPath) && directlyExtractsTar(source)
      ? [`${repoPath} directly runs tar extraction; route it through ${OWNER} instead.`]
      : []);
}

if (import.meta.main) {
  const root = process.cwd();
  const files = sourceFiles(join(root, SOURCE_ROOT));
  // A silently-empty scan yields zero offenders and passes green while checking nothing.
  if (files.length < 100) {
    console.error(`error: archive-extraction-boundary scanned only ${files.length} files under ${SOURCE_ROOT}; expected the full source tree.`);
    process.exit(1);
  }
  const offenders = await findOffenders(root);
  if (offenders.length > 0) {
    console.error(`error: tar extraction must use ${OWNER}:`);
    for (const offender of offenders) {console.error(offender);}
    process.exit(1);
  }
  console.log("archive-extraction-boundary: no direct production tar extraction.");
}
