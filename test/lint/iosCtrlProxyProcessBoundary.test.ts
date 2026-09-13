import ts from "typescript";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findViolationsInSource,
  repositoryPath,
} from "../../scripts/check-ios-ctrl-proxy-process-boundary";

const ROOT = join(import.meta.dir, "..", "..");
const MANAGER = "src/utils/IOSCtrlProxyManager.ts";
const OWNER = "src/utils/ios/IOSCtrlProxyProcessClient.ts";
const CHECK = "scripts/check-ios-ctrl-proxy-process-boundary.ts";

const PROCESS_TOOLING = /processExecutor\.exec\(\s*["'`](?:ps|pgrep|kill)/;
const PGREP_OWNERSHIP = /executeCommand\(\s*"pgrep"/;

// Raw-source regex guards below match against the whole file, so commented-out
// code would otherwise satisfy (or falsely trip) them (issue #6410 review). Use
// the TypeScript scanner rather than a comment-stripping regex: the scanner
// tokenizes strings correctly, so `"http://x"` is never mistaken for a comment.
function stripComments(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  let result = "";
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    result += scanner.getTokenText();
  }
  return result;
}

// Scanning or parsing a repository file is a fixture several assertions share,
// not work any one of them owns: each read-plus-scan of IOSCtrlProxyManager.ts
// costs enough that duplicating it across tests pushed this file's slowest test
// over the 100ms budget on CI (issue #6837). One pass per file, memoized, and
// primed in beforeAll — which the JUnit reporter excludes from per-test time.
const commentFreeCache = new Map<string, string>();
const parsedCache = new Map<string, ts.SourceFile>();

function commentFreeSource(relativePath: string): string {
  const cached = commentFreeCache.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }
  const stripped = stripComments(readFileSync(join(ROOT, relativePath), "utf8"));
  commentFreeCache.set(relativePath, stripped);
  return stripped;
}

function parsedSource(relativePath: string): ts.SourceFile {
  const cached = parsedCache.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(join(ROOT, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  parsedCache.set(relativePath, source);
  return source;
}

/** `this.xcodebuild.startStreaming(...)` call sites, matched structurally. */
function startStreamingCalls(source: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isThisXcodebuildStartStreaming(node.expression)) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return calls;
}

// Structural rather than `getText()`: reading a node's text re-slices the
// source for EVERY call expression in the file, which is the dominant cost of
// walking a file this size.
function isThisXcodebuildStartStreaming(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "startStreaming") {
    return false;
  }
  const target = expression.expression;
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "xcodebuild" &&
    target.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

/**
 * Sources the production check must classify, with the number of violations it
 * owes. Table-driven so each alias/scoping/async shape is its own sub-100ms
 * test instead of one test paying for fifty parses (issue #6837).
 */
const CLASSIFICATION_CASES: readonly (readonly [string, string, number])[] = [
  ["direct execFile of a lifecycle tool", 'execFile("kill", ["-9", "42"]);', 1],
  ["wrapped executeCommand of a lifecycle tool", 'host.executeCommand("ps", ["-p", "42"]);', 1],
  ["Bun.spawn argv of a lifecycle tool", 'Bun.spawn(["pgrep", "-x", "xcodebuild"]);', 1],
  ["an unrelated simctl invocation", 'host.executeCommand("xcrun", ["simctl", "list"]);', 0],
  [
    "a lifecycle tool behind a const alias",
    'const tool = "kill"; executor.executeCommand(tool, ["-TERM", "42"]);',
    1,
  ],
  ["a lifecycle tool inside a shell wrapper", 'spawn("/bin/sh", ["-c", "kill -TERM 42"]);', 1],
  [
    "a spread argv array",
    'const command = ["lsof", "-iTCP:8765"]; executor.executeCommand(...command);',
    1,
  ],
  ["a computed executeCommand seam", 'executor["executeCommand"]("ps", ["-p", "42"]);', 1],
  [
    "a computed child_process seam",
    'import * as cp from "node:child_process"; cp["spawn"]("kill", ["-TERM", "42"]);',
    1,
  ],
  ["a runner.exec seam", 'runner.exec("kill", ["42"]);', 1],
  [
    "a regex-shadowed runner in another function",
    'function regex(){ const runner = /x/; runner.exec("kill"); } function process(){ runner.exec("kill", ["42"]); }',
    1,
  ],
  [
    "a regex runner hoisted above its use",
    'function regex(){ return runner.exec("kill"); } const runner = /x/; regex();',
    0,
  ],
  [
    "a regex runner assigned in a block",
    'let runner: RegExp; { runner = /x/; } runner.exec("kill");',
    0,
  ],
  [
    "a var regex runner assigned in a nested block",
    'function regex(){ { var runner = /x/; } return runner.exec("kill"); }',
    0,
  ],
  [
    "a regex runner assigned before the call",
    'let runner: RegExp; function regex(){ return runner.exec("kill"); } runner = /x/; regex();',
    0,
  ],
  [
    "a regex runner scoped to a for-initializer",
    'const runner = executor; for (let runner = /x/; condition;) { runner.exec("kill"); }',
    0,
  ],
  [
    "a parameter reassigned to a regex",
    'function regex(runner: unknown) { { runner = /x/; } return (runner as RegExp).exec("kill"); }',
    0,
  ],
  [
    "a regex runner scoped to a namespace",
    'const runner = executor; namespace N { const runner = /x/; runner.exec("kill"); }',
    0,
  ],
  [
    "a string-returning helper named run",
    'function configure(run = exec) {} const run = (label: string) => label; run("kill");',
    0,
  ],
  [
    "a defaulted parameter overridden by an executor argument",
    'interface Runner { exec(command: string): unknown } function run(runner: Runner = /x/) { runner.exec("kill"); } run(executor);',
    1,
  ],
  [
    "one regex-defaulted and one executor-defaulted arrow",
    'const regex = (runner = /x/) => runner.exec("kill"); const launch = (runner = executor) => runner.exec("kill");',
    2,
  ],
  [
    "a regex runner reassigned after the call",
    'let runner = /x/; function regex(){ runner.exec("kill"); } regex(); runner = executor;',
    0,
  ],
  [
    "a redeclared var whose last initializer is a regex",
    'var runner = executor; var runner = /x/; runner.exec("kill");',
    0,
  ],
  [
    "a destructured runner reassigned to a regex",
    'let { runner } = source; { runner = /x/; } runner.exec("kill");',
    0,
  ],
  [
    "an uncalled configure that would install the executor",
    'let runner = /x/; function configure(){ runner = executor; } runner.exec("kill");',
    0,
  ],
  [
    "an IIFE that installs the regex",
    'let runner: RegExp; (() => { runner = /x/; })(); runner.exec("kill");',
    0,
  ],
  [
    "a block-scoped configure that is never called",
    'let runner = /x/; { function configure(){ runner = executor; } } runner.exec("kill");',
    0,
  ],
  [
    "an object method that installs the regex",
    'let runner: RegExp; const config = { configure() { runner = /x/; } }; config.configure(); runner.exec("kill");',
    0,
  ],
  [
    "a computed object-method call that installs the regex",
    'let runner: RegExp; const config = { configure() { runner = /x/; } }; config["configure"](); runner.exec("kill");',
    0,
  ],
  [
    "an object whose regex installer is never the method called",
    'let runner = executor; const config = { configure(){ runner = /x/; }, unrelated(){} }; config.unrelated(); runner.exec("kill");',
    1,
  ],
  [
    "an arrow installer replaced before it is called",
    'let runner: RegExp; let configure = () => { runner = /x/; }; configure = () => {}; configure(); runner.exec("kill");',
    1,
  ],
  [
    "a named function expression installer",
    'let runner: RegExp; const configure = function inner(){ runner = /x/; }; configure(); runner.exec("kill");',
    0,
  ],
  [
    "a catch parameter shadowing the runner",
    'let runner = /x/; try { throw executor; } catch (runner) { runner = executor; } runner.exec("kill");',
    0,
  ],
  [
    "a generator installer whose body never runs eagerly",
    'let runner = /x/; function* configure(){ runner = executor; } configure(); runner.exec("kill");',
    0,
  ],
  [
    "an installer reached only through an unrelated receiver",
    'let runner = executor; const config = { configure(){ runner = /x/; } }; function invoke(config: unknown){ config.configure(); } invoke(other); runner.exec("kill");',
    1,
  ],
  [
    "an ungated runner beside an object spread",
    'const base = {}; const config = { ...base }; runner.exec("kill");',
    1,
  ],
  [
    "a static class installer",
    'let runner: RegExp; class Config { static configure(){ runner = /x/; } } Config.configure(); runner.exec("kill");',
    0,
  ],
  [
    "an instance class installer",
    'let runner=executor; class Config { configure(){runner=/x/;} } const config=new Config(); config.configure(); runner.exec("kill");',
    0,
  ],
  [
    "a shadowing class in an inner block",
    'let runner=executor; class Config { configure(){runner=/x/;} } { class Config { configure(){} } const config=new Config(); config.configure(); runner.exec("kill"); }',
    1,
  ],
  [
    "a subclass that overrides the installer",
    'let runner=executor; class Config { configure(){runner=/x/;} } class Other extends Config { configure(){} } let config=new Config(); config=new Other(); config.configure(); runner.exec("kill");',
    1,
  ],
  [
    "an instance whose installer is patched out",
    'let runner=executor; class Config { configure(){runner=/x/;} } const config=new Config(); config.configure=()=>{}; config.configure(); runner.exec("kill");',
    1,
  ],
  [
    "an instance whose installer is patched out by computed key",
    'let runner=executor; class Config { configure(){runner=/x/;} } const config=new Config(); config["configure"]=()=>{}; config.configure(); runner.exec("kill");',
    1,
  ],
  [
    "an instance whose installer is deleted",
    'let runner=executor; class Config { configure(){runner=/x/;} } const config=new Config(); delete config.configure; config.configure(); runner.exec("kill");',
    1,
  ],
  [
    "an instance that gains an unrelated method",
    'let runner=executor; class Config { configure(){runner=/x/;} } const config=new Config(); config.other=()=>{}; config.configure(); runner.exec("kill");',
    0,
  ],
  [
    "an executor installer that is never called",
    'let runner = /x/; function configure(){ runner = executor; } unrelated(); runner.exec("kill");',
    0,
  ],
  [
    "an executor assignment after the only call",
    'let runner = /x/; function regex(){ runner.exec("kill"); } regex(); runner = executor; function unused(){ regex(); }',
    0,
  ],
  [
    "an installer reached through a function alias",
    'let runner=executor; function configure(){runner=/x/;} const run=configure; run(); runner.exec("kill");',
    0,
  ],
  [
    "an installer that also owns the call",
    'let runner=executor; function regex(){runner=/x/; runner.exec("kill");} regex();',
    0,
  ],
  [
    "a constructor installer",
    'let runner=executor; class Config { constructor(){runner=/x/;} } new Config(); runner.exec("kill");',
    0,
  ],
  [
    "an un-awaited async installer",
    'let runner = /x/; async function configure(){ await Promise.resolve(); runner = executor; } configure(); runner.exec("kill");',
    0,
  ],
  [
    "an awaited async installer",
    'let runner = /x/; async function configure(){ await Promise.resolve(); runner = executor; } await configure(); runner.exec("kill");',
    1,
  ],
  [
    "an async installer awaited through Promise.all",
    'let runner = executor; async function configure(){ await Promise.resolve(); runner = /x/; } await Promise.all([configure()]); runner.exec("kill");',
    0,
  ],
  [
    "an async installer raced against an already-resolved promise",
    'let runner = executor; async function configure(){ await Promise.resolve(); runner = /x/; } await Promise.race([configure(), Promise.resolve()]); runner.exec("kill");',
    1,
  ],
  [
    "an async installer whose assignment precedes its first await",
    'let runner = /x/; async function configure(){ runner = executor; await Promise.resolve(); } configure(); runner.exec("kill");',
    1,
  ],
  [
    "an async installer whose await is conditional and skipped",
    'let runner = /x/; async function configure(flag: boolean){ if (flag) await Promise.resolve(); runner = executor; } configure(false); runner.exec("kill");',
    1,
  ],
];

describe("iOS CtrlProxy process execution boundary (issue #4063)", () => {
  beforeAll(() => {
    commentFreeSource(MANAGER);
    commentFreeSource(OWNER);
    parsedSource(MANAGER);
  });

  test("keeps ps, pgrep, and kill ownership in the lifecycle client", () => {
    expect(commentFreeSource(MANAGER)).not.toMatch(PROCESS_TOOLING);
    expect(commentFreeSource(OWNER)).toMatch(PGREP_OWNERSHIP);
  });

  test("ownership guard ignores commented-out process tooling (issue #6410 review)", () => {
    // A raw-source regex over the whole file fires on commented-out code even
    // though it is not a real call site; stripping comments first must silence
    // the false positive while still catching a genuine (uncommented) call.
    const lineComment = '// processExecutor.exec("kill", ["-9", "42"]);\nconst x = 1;';
    const blockComment = '/* processExecutor.exec("ps", ["-p", "42"]); */\nconst y = 2;';
    const realCall = 'processExecutor.exec("kill", ["-9", "42"]);';
    expect(stripComments(lineComment)).not.toMatch(PROCESS_TOOLING);
    expect(stripComments(blockComment)).not.toMatch(PROCESS_TOOLING);
    expect(stripComments(realCall)).toMatch(PROCESS_TOOLING);
    // A comment mentioning the owner API must not satisfy the positive presence
    // check that pins pgrep ownership inside the lifecycle client.
    expect(stripComments('/* executeCommand("pgrep") */')).not.toMatch(PGREP_OWNERSHIP);
    // A `//` inside a string literal is not a comment and must survive.
    expect(stripComments('const url = "http://example.com";')).toMatch(/http:\/\/example\.com/);
  });

  test.each(CLASSIFICATION_CASES)("classifies %s", (_label, source, expected) => {
    expect(findViolationsInSource("fixture.ts", source)).toHaveLength(expected);
  });

  test("has a production check with documented exceptions", () => {
    const source = readFileSync(join(ROOT, CHECK), "utf8");
    expect(source).toContain("const EXCEPTIONS = new Map<string, string>([");
    expect(source).toContain("IOSCtrlProxyProcessClient.ts");
    expect(readFileSync(join(ROOT, "package.json"), "utf8")).toContain(
      "check:ios-ctrl-proxy-process-boundary",
    );
    expect(readFileSync(join(ROOT, "scripts/all_fast_validate_checks.sh"), "utf8")).toContain(
      "ios-ctrl-proxy-process-boundary",
    );
    expect(readFileSync(join(ROOT, "turbo.json"), "utf8")).toContain(
      '"check:ios-ctrl-proxy-process-boundary"',
    );
    expect(readFileSync(join(ROOT, ".github/workflows/pull_request.yml"), "utf8")).toContain(
      "Check iOS CtrlProxy process execution boundary",
    );
  });

  test("normalizes Windows separators before applying ownership exceptions", () => {
    expect(repositoryPath("src\\utils\\ios\\IOSCtrlProxyProcessClient.ts")).toBe(
      "src/utils/ios/IOSCtrlProxyProcessClient.ts",
    );
  });

  test("both resident-runner startStreaming call sites pass an explicit process signal (issue #6410)", () => {
    // XcodebuildClient.startStreaming only forwards a signal to spawn when the
    // caller explicitly supplies one — it never defaults that wiring to the
    // ambient per-request signal. Both IOSCtrlProxyManager call sites (simulator
    // and physical device) MUST supply their own runner-owned signal rather than
    // silently relying on that default, or the resident runner would have no
    // lifecycle-abort wiring at all. A regression here (dropping the `signal:`
    // line from either call) must fail loudly instead of just changing runtime
    // behavior silently.
    const source = parsedSource(MANAGER);
    const calls = startStreamingCalls(source);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const options = call.arguments[1];
      expect(options !== undefined && ts.isObjectLiteralExpression(options)).toBe(true);
      if (options === undefined || !ts.isObjectLiteralExpression(options)) {
        continue;
      }
      const signal = options.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "signal",
      );
      expect(signal && ts.isPropertyAssignment(signal) && signal.initializer.getText(source)).toBe(
        "this.runnerAbortController.signal",
      );
    }
  });
});
