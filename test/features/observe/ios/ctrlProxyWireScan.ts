/**
 * Structural (TypeScript-AST) scanner for the iOS control-proxy wire-parity tripwire.
 *
 * This replaces the textual-regex `extractEmittedTypes` that shipped with #2857/#2950.
 * The regex scan caught direct drift but was defeated by ordinary refactors that the
 * PR #2950 3-perspective review reproduced (issue #2955):
 *
 *   1. **Const-hoisted discriminator** —
 *      `const cmd = "request_x"; ws.send(JSON.stringify({ type: cmd, requestId }))`.
 *      The `type:` property has no literal on its line, so a textual scan misses it.
 *   2. **Parameter-forwarded discriminator** — `CtrlProxyDatabase` sends via
 *      `JSON.stringify({ type, requestId, ... })` shorthand where `type` is a method
 *      parameter; the real command literal only exists at the call site
 *      (`this.request("execute_sql", ...)`).
 *   3. **Hardcoded shared-file allowlist** — `SHARED_EMIT_FILES` was a literal array; a
 *      new shared delegate the iOS client routes through could silently go unscanned.
 *
 * The AST scanner resolves `type`/`messageType` property values to their literal by
 * following simple, statically-decidable bindings: string literals, ternaries of
 * literals, and identifiers bound to a `const`/`let` string literal or a parameter that
 * only ever receives string-literal arguments across the file's call sites. The shared
 * file list is derived from the iOS client's transitive import graph (see
 * `deriveIosSharedEmitFiles`), so a missed delegate cannot go unscanned.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import ts from "typescript";

/**
 * Normalize a filesystem path to forward-slash (posix) separators so that path
 * comparisons and prefix checks in the import graph are OS-agnostic. On Windows,
 * `path.resolve` yields backslash separators; comparing those against a
 * forward-slash-joined prefix (or a forward-slash import-derived key) never
 * matches, which silently empties the derived emit set (issue #2955, Windows CI).
 *
 * Exported so a unit test can pin the separator-independence directly. Unconditionally
 * rewrites backslashes so the guard is meaningful on posix CI too (a no-op for paths
 * that already use forward slashes).
 */
export function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

/** A resolved command discriminator plus where it was found (for diagnostics). */
export interface EmittedType {
  readonly type: string;
  readonly file: string;
}

/** An emit site whose discriminator could not be statically resolved to a literal. */
export interface UnresolvedEmit {
  readonly file: string;
  /** 1-based line number of the offending `type:`/`messageType:` property. */
  readonly line: number;
  /** The source text of the property, for the failure message. */
  readonly text: string;
}

/** Result of scanning one source file. */
export interface FileScanResult {
  readonly emitted: EmittedType[];
  readonly unresolved: UnresolvedEmit[];
}

const COMMAND_TOKEN = /^[a-z][a-z0-9_]*$/;

function isCommandLike(value: string): boolean {
  return COMMAND_TOKEN.test(value);
}

function parseSourceFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
}

/**
 * Collect, for every string-literal `.request(...)` / `sendCommand(...)` / method call
 * argument in the file, which parameter names of which functions receive a string
 * literal. Keyed by parameter name so an identifier forwarded through a `{ type }`
 * shorthand can be resolved to the literal(s) that flow into that parameter.
 *
 * This is deliberately conservative: it maps a *parameter name* to every string literal
 * passed positionally to a same-named parameter of any function/method in the file. That
 * over-approximates (it does not do call-graph-precise binding), which is exactly the
 * safe direction for a tripwire — it can only add real literals that appear in source,
 * never invent one, and a genuinely-unknown command still fails the subset assertion.
 */
function collectParameterLiterals(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  // paramName -> declaring function's positional index (first declaration wins).
  const paramIndex = new Map<string, number>();
  // function-like nodes keyed by nothing; we only need the (paramName -> index) map and
  // then the literal args at each positional index across call sites.
  const indexLiterals = new Map<number, Set<string>>();

  const recordParam = (name: string, index: number): void => {
    if (!paramIndex.has(name)) {
      paramIndex.set(name, index);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      node.parameters.forEach((param, index) => {
        if (ts.isIdentifier(param.name)) {
          recordParam(param.name.text, index);
        }
      });
    }
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((arg, index) => {
        if (ts.isStringLiteralLike(arg) && isCommandLike(arg.text)) {
          let set = indexLiterals.get(index);
          if (!set) {
            set = new Set<string>();
            indexLiterals.set(index, set);
          }
          set.add(arg.text);
        }
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const result = new Map<string, Set<string>>();
  for (const [name, index] of paramIndex) {
    const literals = indexLiterals.get(index);
    if (literals && literals.size > 0) {
      result.set(name, new Set(literals));
    }
  }
  return result;
}

/** Collect `const`/`let` identifiers initialized to a command-like string literal. */
function collectConstStringBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer) &&
      isCommandLike(node.initializer.text)
    ) {
      // First binding wins; shadowing across scopes is not modeled (safe over-approx).
      if (!bindings.has(node.name.text)) {
        bindings.set(node.name.text, node.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/**
 * Resolve the string values an expression assigned to a `type`/`messageType` property
 * can take. Returns the resolved literals, or `null` if the expression is not
 * statically decidable (which the caller records as an unresolved emit site).
 */
function resolveDiscriminatorValues(
  expr: ts.Expression,
  constBindings: Map<string, string>,
  paramLiterals: Map<string, Set<string>>,
): string[] | null {
  if (ts.isStringLiteralLike(expr)) {
    return isCommandLike(expr.text) ? [expr.text] : [];
  }
  if (ts.isConditionalExpression(expr)) {
    const whenTrue = resolveDiscriminatorValues(expr.whenTrue, constBindings, paramLiterals);
    const whenFalse = resolveDiscriminatorValues(expr.whenFalse, constBindings, paramLiterals);
    if (whenTrue === null || whenFalse === null) {
      return null;
    }
    return [...whenTrue, ...whenFalse];
  }
  if (ts.isIdentifier(expr)) {
    const bound = constBindings.get(expr.text);
    if (bound !== undefined) {
      return [bound];
    }
    const fromParams = paramLiterals.get(expr.text);
    if (fromParams && fromParams.size > 0) {
      return [...fromParams];
    }
    // Unknown identifier — cannot decide statically.
    return null;
  }
  // Template literals, calls, property access, etc. are not statically decidable here.
  return null;
}

/**
 * The property key that carries the command discriminator, per emit sink:
 *   - `sendCommand(ctx, { messageType, ... })` — the shared delegate sink.
 *   - `JSON.stringify({ type, ... })` / `ws.send(JSON.stringify(msg))` — the raw sink.
 * Scoping detection to these sinks (rather than every `type:` property in the file) is
 * what distinguishes an OUTBOUND wire command from an inbound record that happens to
 * carry a `type` key (e.g. `recordSdkEvent({ type: envelope.eventType })`).
 */
type SinkKind = "sendCommand" | "jsonStringify";
const SINK_DISCRIMINATOR: Record<SinkKind, string> = {
  sendCommand: "messageType",
  jsonStringify: "type",
};

/** Map `const foo = { ... }` object-literal bindings so `JSON.stringify(foo)` resolves. */
function collectObjectLiteralBindings(
  sourceFile: ts.SourceFile,
): Map<string, ts.ObjectLiteralExpression> {
  const bindings = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer) &&
      !bindings.has(node.name.text)
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/**
 * Scan one source file with the TS AST for every command discriminator it can emit.
 *
 * Detection is scoped to the two outbound sinks (`sendCommand(...)` and
 * `JSON.stringify(...)`). Within an emit object literal the discriminator property value
 * is resolved structurally: string literals, ternaries of literals, `const`-hoisted
 * identifiers, and parameter-forwarded `{ type }` shorthand (the `CtrlProxyDatabase`
 * case). An unresolved discriminator (template literal, opaque call, unknown identifier)
 * is reported so the guard fails loudly rather than silently dropping coverage — the
 * structural successor to the old `findDynamicCommandTypes` template guard.
 */
export function scanFile(file: string, source: string): FileScanResult {
  const sourceFile = parseSourceFile(file, source);
  const constBindings = collectConstStringBindings(sourceFile);
  const paramLiterals = collectParameterLiterals(sourceFile);
  const objectBindings = collectObjectLiteralBindings(sourceFile);

  const emitted: EmittedType[] = [];
  const unresolved: UnresolvedEmit[] = [];

  const recordEmitObject = (obj: ts.ObjectLiteralExpression, key: string): void => {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop) && !ts.isComputedPropertyName(prop.name)) {
        const propKey =
          ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
            ? prop.name.text
            : undefined;
        if (propKey === key) {
          recordDiscriminator(prop.initializer, prop);
        }
      } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === key) {
        // `{ type }` shorthand — resolve the identifier through the binding maps.
        recordDiscriminator(prop.name, prop);
      }
    }
  };

  function recordDiscriminator(valueExpr: ts.Expression, node: ts.Node): void {
    const resolved = resolveDiscriminatorValues(valueExpr, constBindings, paramLiterals);
    if (resolved === null) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      unresolved.push({ file, line: line + 1, text: node.getText(sourceFile).trim() });
      return;
    }
    for (const value of resolved) {
      emitted.push({ type: value, file });
    }
  }

  /** Resolve a sink argument to its object literal (directly or via a const binding). */
  const resolveSinkObject = (
    arg: ts.Expression | undefined,
  ): ts.ObjectLiteralExpression | undefined => {
    if (!arg) {
      return undefined;
    }
    if (ts.isObjectLiteralExpression(arg)) {
      return arg;
    }
    if (ts.isIdentifier(arg)) {
      return objectBindings.get(arg.text);
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // `sendCommand(context, { messageType, ... })` — discriminator in the 2nd arg.
      if (ts.isIdentifier(callee) && callee.text === "sendCommand") {
        const obj = resolveSinkObject(node.arguments[1]);
        if (obj) {
          recordEmitObject(obj, SINK_DISCRIMINATOR.sendCommand);
        }
      }
      // `JSON.stringify({ type, ... })` — discriminator in the sole arg.
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "JSON" &&
        callee.name.text === "stringify"
      ) {
        const obj = resolveSinkObject(node.arguments[0]);
        if (obj) {
          recordEmitObject(obj, SINK_DISCRIMINATOR.jsonStringify);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { emitted, unresolved };
}

/**
 * Extract the module specifiers imported by a source file (static `import` + `export
 * from` only; dynamic `import()` is not followed — the iOS client uses none for
 * delegates). Returns raw specifier strings (e.g. `"../shared/SharedTextDelegate"`).
 */
export function extractImportSpecifiers(source: string, file: string): string[] {
  const sourceFile = parseSourceFile(file, source);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** Resolve a relative module specifier to an absolute `.ts` path, if it exists. */
function resolveTsModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null; // package import — not part of the first-party emit graph.
  }
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, resolve(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Not this candidate; try the next. Missing module is expected during probing.
    }
  }
  return null;
}

/**
 * Derive the set of shared-directory emit files reachable from the iOS client's
 * transitive first-party import graph. This replaces the hardcoded `SHARED_EMIT_FILES`
 * allowlist (issue #2955 gap 2): a new `shared/` delegate the iOS client routes through
 * is discovered automatically, so a missed delegate can't silently go unscanned.
 *
 * @param entry            Absolute path of the iOS client entrypoint to walk from.
 * @param sharedDir        Absolute path of `src/features/observe/shared`.
 * @returns Absolute paths of files under `sharedDir` (excluding `*.test.ts` and pure
 *          type-only `types.ts`) reachable from `entry`.
 */
export function deriveIosSharedEmitFiles(entry: string, sharedDir: string): string[] {
  const visited = new Set<string>();
  const sharedHits = new Set<string>();
  // Compare in posix space so backslash-separated resolved paths on Windows still
  // prefix-match the shared directory (issue #2955).
  const normalizedSharedDir = toPosixPath(resolve(sharedDir));

  const walk = (file: string): void => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      // A resolved-but-unreadable module is unexpected; skip it rather than crash the
      // scan. resolveTsModule already confirmed readability, so this is belt-and-braces.
      return;
    }

    const posixFile = toPosixPath(resolve(file));
    if (posixFile.startsWith(`${normalizedSharedDir}/`)) {
      const isTest = posixFile.endsWith(".test.ts");
      const isTypesOnly = posixFile.endsWith("/types.ts");
      if (!isTest && !isTypesOnly) {
        sharedHits.add(resolve(file));
      }
    }

    for (const specifier of extractImportSpecifiers(source, file)) {
      const resolved = resolveTsModule(file, specifier);
      if (resolved) {
        walk(resolved);
      }
    }
  };

  walk(resolve(entry));
  return [...sharedHits].sort();
}
