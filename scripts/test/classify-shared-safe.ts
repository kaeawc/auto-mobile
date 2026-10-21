#!/usr/bin/env bun
/**
 * Shared-process allow-list for the Node unit lane (#10583).
 *
 * `scripts/test-ts.sh unit` runs every unit file under `bun test --isolate`,
 * which re-creates a realm and re-imports the module graph per file. The study
 * in docs/design-docs/ci/unit-lane-scaling.md measured that as 83% of the
 * lane's wall time. The owner decision on #10583 is to run "tier C" files, the
 * ones with no static shared-state signal, together in shared (non-isolated)
 * processes, and keep everything else isolated.
 *
 * Tiers, from the static signals documented in the study:
 *
 * - **A (never shared)**: `mock.module`, patched natives or globals
 *   (`fs.x = …`, `globalThis.x = …`, `Object.defineProperty(globalThis …)`),
 *   `process.chdir`. These change the module registry or process-wide state,
 *   and `afterEach` cannot reliably undo them.
 * - **B (isolated)**: unproven `spyOn` restores, `process.env` writes, singleton
 *   access or reset, the database helpers, `testOverrides`, Bun system time.
 * - **C (shared)**: none of the above, including files whose only state is spies
 *   installed in tests/beforeEach with a restore proof for every site (#13568).
 *   beforeAll/module/describe/helper installs never qualify. No restore preload.
 *
 * This script writes `test/shared-process-allowlist.txt`, the tier C unit
 * files minus {@link SHARED_PROCESS_EXCLUSIONS}. `--check` fails when a listed
 * file is no longer tier C (it gained a signal), no longer exists or is not a
 * unit-lane file, is excluded, or when the list is unsorted or has duplicates.
 * A new tier C file that is not listed yet is NOT a failure: unlisted files
 * run isolated, so the check only reports them as candidates.
 *
 *   bun scripts/test/classify-shared-safe.ts           # regenerate the list
 *   bun scripts/test/classify-shared-safe.ts --check   # CI gate (Fast Validation)
 *   bun scripts/test/classify-shared-safe.ts --explain [path] # unproven spy sites
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { sortedReaddirEntriesSync } from "../../src/utils/io";

export type Tier = "A" | "B" | "C";

export interface SignalRule {
  readonly name: string;
  readonly tier: "A" | "B";
  readonly pattern: RegExp;
}

/**
 * The study's static signals, matched against the test file's own source.
 * Comments and strings are deliberately not stripped: a false positive only
 * keeps a file isolated, which is the safe direction.
 */
export const SIGNAL_RULES: readonly SignalRule[] = [
  { name: "mockModule", tier: "A", pattern: /\bmock\.module\(/ },
  {
    name: "globalWrite",
    tier: "A",
    pattern:
      /\b(?:globalThis|global)\.[A-Za-z_$][\w$]*\s*=(?!=)|Object\.defineProperty\((?:globalThis|global|process)\b/,
  },
  { name: "chdir", tier: "A", pattern: /process\.chdir/ },
  {
    name: "nativePatch",
    tier: "A",
    pattern: /\b(?:childProcess|Bun|fs|process)\.[A-Za-z]+\s*=(?!=)/,
  },
  { name: "spyOn", tier: "B", pattern: /\bspyOn\(/ },
  {
    name: "db",
    tier: "B",
    pattern:
      /getDatabase|createTestDatabase|navigationTestHarness|inMemorySingletonDatabase|tempFileDatabase|withFileBackedDb/,
  },
  {
    name: "envWrite",
    tier: "B",
    pattern: /process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\s*=(?!=)|delete process\.env/,
  },
  { name: "testOverrides", tier: "B", pattern: /\btestOverrides\b/ },
  {
    name: "singleton",
    tier: "B",
    pattern:
      /getInstance\(|resetInstance|resetForTesting|\.instance\s*=(?!=)|\.getInstance\s*=(?!=)|__reset|setInstance\(|resetSingleton/,
  },
  { name: "setSystemTime", tier: "B", pattern: /setSystemTime|useFakeTimers/ },
  // Added after the study, from randomized shared runs (#10583): module-level
  // setters and resets (`setObserveCacheStore(…)`, `setDeviceToolsDependencies(…)`,
  // `resetAdbClientCaches()`, `X.resetForTests()`) are process-wide state the
  // study's singleton pattern missed. Three such files failed in shared random
  // orders. Only free-function calls match, so `fake.setX()` does not; the
  // timer globals are not state.
  {
    name: "moduleState",
    tier: "B",
    pattern:
      /(?<![.\w$])(?:reset[A-Z]\w*|set(?!Immediate\b|Timeout\b|Interval\b)[A-Z]\w*)\(|\.resetForTests?\(|(?<![.\w$])install[A-Z]\w*ForTesting\(/,
  },
];

/**
 * Tier C files that must stay isolated anyway, keyed by path with the reason.
 * Add an entry when the nightly randomized lane shows a file depends on, or
 * leaks, cross-file state that the static signals miss.
 */
export const SHARED_PROCESS_EXCLUSIONS: Readonly<Record<string, string>> = {
  "test/utils/WorkProfileMonitor.test.ts":
    "its timeout/polling microtask-settling assertion fails in both shared and isolated " +
    "runs (#13568); preserve its isolated placement pending a test fix",
  "test/daemon/deviceSnapshotIncarnationInvalidator.test.ts":
    "asserts the daemon port's no-op default before the server registers its invalidator",
  "test/features/action/ClearAppData.test.ts":
    "its production DefaultDeviceWindowCacheInvalidator marks a pending window resolution " +
    "for device-123 in a module-level map that later files read",
  "test/features/action/BaseVisualChange.uiStability.test.ts":
    "reads the module-level pending window resolution for device-123; failed after " +
    "ClearAppData in a shared random order (seed 8)",
  "test/daemon/restartEndToEnd.test.ts":
    "its helpers (restartScenarioHarness, hostCommandGuard) spy on the database module and the " +
    "logger and replace node:child_process and Bun.spawn launchers for the whole file",
};

export const ALLOWLIST_PATH = "test/shared-process-allowlist.txt";

export interface Classification {
  readonly tier: Tier;
  readonly signals: readonly string[];
}

const SETTER_NAME = /^(?:set|reset)[A-Z]/;

/** Local names bound by value imports, split into bun:test spyOn aliases and the rest. */
function collectImportBindings(sourceFile: ts.SourceFile): {
  spyAliases: Set<string>;
  imported: Set<string>;
} {
  const spyAliases = new Set<string>();
  const imported = new Set<string>();
  for (const statement of sourceFile.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (!clause || clause.isTypeOnly || !ts.isImportDeclaration(statement)) {
      continue;
    }
    const fromBunTest =
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "bun:test";
    if (clause.name && !fromBunTest) {
      imported.add(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && !fromBunTest) {
      imported.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        const exported = (element.propertyName ?? element.name).text;
        if (exported === "spyOn") {
          spyAliases.add(element.name.text);
        } else if (!fromBunTest) {
          imported.add(element.name.text);
        }
      }
    }
  }
  return { spyAliases, imported };
}

/** The leftmost identifier of `a.b.c`, or undefined when the chain starts elsewhere. */
function rootIdentifier(expression: ts.Expression): string | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/**
 * Recognize direct spy callees (including import aliases and namespaces), and
 * set/reset calls on imported objects. Preserve the legacy setter matching;
 * calls on local fakes are not imported bindings, so they stay out.
 */
function collectAstSignals(sourceFile: ts.SourceFile): readonly { name: string; tier: "B" }[] {
  const { spyAliases, imported } = collectImportBindings(sourceFile);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const spyCallee = unwrap(callee);
      if (ts.isIdentifier(spyCallee) && spyAliases.has(spyCallee.text)) {
        found.add("spyOnAlias");
      } else if (
        (ts.isIdentifier(spyCallee) && spyCallee.text === "spyOn") ||
        (ts.isPropertyAccessExpression(spyCallee) && spyCallee.name.text === "spyOn") ||
        (ts.isElementAccessExpression(spyCallee) &&
          ts.isStringLiteralLike(spyCallee.argumentExpression) &&
          spyCallee.argumentExpression.text === "spyOn")
      ) {
        found.add("spyOn");
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const root = rootIdentifier(callee.expression);
        if (root !== undefined && imported.has(root) && SETTER_NAME.test(callee.name.text)) {
          found.add("importedSetter");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found].sort().map((name) => ({ name, tier: "B" as const }));
}

export function astSignals(source: string): readonly { name: string; tier: "B" }[] {
  return collectAstSignals(ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true));
}

export interface UnprovenSpy {
  readonly line: number;
  readonly reason: string;
}

type Callback = ts.ArrowFunction | ts.FunctionExpression;
interface TestContext {
  readonly callback: Callback;
  readonly kind: string;
  readonly scopes: readonly ts.Node[];
}

/**
 * A deliberately bounded proof, not general data flow: inline framework callbacks,
 * lexical handle identity, unconditional teardown, and known spy-preserving chains.
 * Unknown control flow, helper functions and computed handles fail closed.
 */
function spyRestoreProof(sourceFile: ts.SourceFile): { sites: number; unproven: UnprovenSpy[] } {
  const declarations = new Map<ts.Node, Map<string, ts.Identifier>>();
  const calls: ts.CallExpression[] = [];
  const writes: { target: ts.Expression; value?: ts.Expression; node: ts.Node }[] = [];
  const scopeOf = (node: ts.Node): ts.Node => {
    let scope = node.parent;
    while (
      scope.parent &&
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !ts.isFunctionLike(scope) &&
      !ts.isForOfStatement(scope) &&
      !ts.isForStatement(scope) &&
      !ts.isCatchClause(scope)
    ) {
      scope = scope.parent;
    }
    return scope;
  };
  const bind = (name: ts.BindingName, scope: ts.Node): void => {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          bind(element.name, scope);
        }
      }
      return;
    }
    const names = declarations.get(scope) ?? new Map<string, ts.Identifier>();
    names.set(name.text, name);
    declarations.set(scope, names);
  };
  const collect = (node: ts.Node): void => {
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      bind(node.name, node);
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      bind(node.name, scopeOf(node));
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        writes.push({ target: node.name, value: node.initializer, node });
      }
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      bind(node.name, scopeOf(node));
    } else if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportClause(node)
    ) {
      if (node.name) {
        bind(node.name, sourceFile);
      }
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      writes.push({ target: node.left, value: node.right, node });
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      writes.push({ target: node.operand, node });
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const resolve = (name: ts.Identifier): ts.Identifier | undefined => {
    for (let scope: ts.Node | undefined = name; scope; scope = scope.parent) {
      const declaration = declarations.get(scope)?.get(name.text);
      if (declaration) {
        return declaration;
      }
    }
    return undefined;
  };
  const importedName = (name: ts.Identifier): string | undefined => {
    const declaration = resolve(name);
    if (!declaration) {
      return name.text;
    } // Bun's global test APIs (also used in fixtures).
    const parent = declaration.parent;
    if (!ts.isImportSpecifier(parent) && !ts.isNamespaceImport(parent)) {
      return undefined;
    }
    let statement: ts.Node = parent;
    while (!ts.isImportDeclaration(statement) && statement.parent) {
      statement = statement.parent;
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "bun:test"
    ) {
      return undefined;
    }
    return ts.isImportSpecifier(parent) ? (parent.propertyName ?? parent.name).text : "namespace";
  };
  const apiName = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      return importedName(node);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      importedName(node.expression) === "namespace"
    ) {
      return node.name.text;
    }
    return undefined;
  };
  const isSpy = (call: ts.CallExpression): boolean => {
    const callee = unwrap(call.expression);
    // Keep recognizing non-Bun spyOn imports, as collectImportBindings did before.
    if (ts.isIdentifier(callee)) {
      const declaration = resolve(callee)?.parent;
      return (
        callee.text === "spyOn" ||
        (declaration !== undefined &&
          ts.isImportSpecifier(declaration) &&
          (declaration.propertyName ?? declaration.name).text === "spyOn")
      );
    }
    return (
      (ts.isPropertyAccessExpression(callee) && callee.name.text === "spyOn") ||
      (ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression) &&
        callee.argumentExpression.text === "spyOn")
    );
  };
  const callbackKind = (callback: Callback): string | undefined => {
    const parent = callback.parent;
    if (!ts.isCallExpression(parent) || !parent.arguments.includes(callback)) {
      return undefined;
    }
    let callee = parent.expression;
    // test.each(table)(...), test.skip/only(...), describe.each(table)(...).
    if (ts.isCallExpression(callee)) {
      callee = callee.expression;
    }
    while (
      ts.isPropertyAccessExpression(callee) &&
      ["each", "only", "skip", "todo"].includes(callee.name.text)
    ) {
      callee = callee.expression;
    }
    return apiName(callee);
  };
  const contextOf = (node: ts.Node): TestContext | undefined => {
    let callback: Callback | undefined;
    let kind: string | undefined;
    const scopes: ts.Node[] = [sourceFile];
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isFunctionLike(parent)) {
        continue;
      }
      if (!ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent)) {
        return undefined;
      }
      const role = callbackKind(parent);
      if (!callback) {
        callback = parent;
        kind = role;
      } else if (role === "describe") {
        scopes.push(parent);
      } else {
        return undefined;
      }
    }
    return callback && kind ? { callback, kind, scopes } : undefined;
  };
  const sameScopes = (a: TestContext, b: TestContext): boolean =>
    a.scopes.length === b.scopes.length && a.scopes.every((scope) => b.scopes.includes(scope));
  const covers = (cleanup: TestContext, install: TestContext): boolean =>
    cleanup.scopes.every((scope) => install.scopes.includes(scope));
  const containsExit = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) {
      return false;
    }
    if (
      ts.isReturnStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isBreakStatement(node) ||
      ts.isContinueStatement(node)
    ) {
      return true;
    }
    return ts.forEachChild(node, (child) => containsExit(child) || undefined) ?? false;
  };
  const unconditional = (node: ts.Node, callback: ts.Node): boolean => {
    for (let current = node; current !== callback; current = current.parent) {
      const parent = current.parent;
      if (!parent) {
        return false;
      }
      if (
        ts.isIfStatement(parent) ||
        ts.isConditionalExpression(parent) ||
        ts.isSwitchStatement(parent) ||
        ts.isIterationStatement(parent, false) ||
        ts.isCatchClause(parent) ||
        (ts.isFunctionLike(parent) && parent !== callback) ||
        (ts.isBinaryExpression(parent) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(parent.operatorToken.kind)) ||
        (ts.isCallExpression(current) &&
          (current.questionDotToken ||
            (ts.isPropertyAccessExpression(current.expression) &&
              current.expression.questionDotToken))) ||
        (ts.isPropertyAccessExpression(current) && current.questionDotToken)
      ) {
        return false;
      }
      if (ts.isTryStatement(parent) && current !== parent.finallyBlock) {
        return false;
      }
      if (ts.isBlock(parent)) {
        for (const statement of parent.statements) {
          if (statement.pos >= current.pos) {
            break;
          }
          if (containsExit(statement)) {
            return false;
          }
        }
      }
    }
    return true;
  };
  // A handle is a lexical binding plus a static property/index path. Shadowed
  // variables and similarly named fields in another describe never match.
  const handle = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const declaration = resolve(node);
      return declaration ? `@${declaration.pos}` : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const root = handle(node.expression);
      return root && `${root}[${JSON.stringify(node.name.text)}]`;
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      (ts.isStringLiteralLike(node.argumentExpression) ||
        ts.isNumericLiteral(node.argumentExpression))
    ) {
      const root = handle(node.expression);
      return root && `${root}[${JSON.stringify(node.argumentExpression.text)}]`;
    }
    return undefined;
  };
  // Like handle(), but an undeclared root is a global (console, process, Bun),
  // so spy targets such as `console.log` get a stable key too.
  const targetPath = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      return resolve(node) ? handle(node) : `global:${node.text}`;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const root = targetPath(node.expression);
      return root && `${root}[${JSON.stringify(node.name.text)}]`;
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      (ts.isStringLiteralLike(node.argumentExpression) ||
        ts.isNumericLiteral(node.argumentExpression))
    ) {
      const root = targetPath(node.expression);
      return root && `${root}[${JSON.stringify(node.argumentExpression.text)}]`;
    }
    return undefined;
  };
  // A spy restored through one handle only in afterAll is safe when every install
  // (each beforeEach run, test.each row, or test writing that handle) spies the
  // same object and method (#14515): Bun's spyOn returns the existing spy for an
  // already-spied method, so one restore puts the original back. A handle
  // overwritten by a spy on another target loses the earlier spy, which then
  // stays mocked for later files in the process. Invariant means a string-literal
  // method name on a static path whose root is a global, an import binding, or a
  // top-level const/function/class, with no write anywhere to that path or a prefix
  // of it. Anything chosen per test (locals, `let`, computed keys, calls) fails.
  const invariantTarget = (spy: ts.CallExpression): boolean => {
    const [object, method] = spy.arguments;
    if (!object || !method || !ts.isStringLiteralLike(method)) {
      return false;
    }
    const path = targetPath(object);
    let root = unwrap(object);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      root = unwrap(root.expression);
    }
    if (!path || !ts.isIdentifier(root)) {
      return false;
    }
    const declaration = resolve(root)?.parent;
    const topLevel =
      declaration === undefined ||
      ts.isImportSpecifier(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportClause(declaration) ||
      ((ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
        declaration.parent === sourceFile) ||
      (ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const &&
        declaration.parent.parent.parent === sourceFile);
    return (
      topLevel &&
      !writes.some((write) => {
        const other = write.node === declaration ? undefined : targetPath(write.target);
        return other !== undefined && (other === path || path.startsWith(`${other}[`));
      })
    );
  };
  const registeredUnconditionally = (context: TestContext): boolean => {
    // Hook registration hidden in an if/loop is not a guaranteed cleanup.
    for (let current: ts.Node = context.callback.parent; current.parent; current = current.parent) {
      if (
        ts.isCatchClause(current.parent) ||
        (ts.isTryStatement(current.parent) && current !== current.parent.finallyBlock) ||
        (ts.isCallExpression(current) &&
          (current.questionDotToken ||
            (ts.isPropertyAccessExpression(current.expression) &&
              current.expression.questionDotToken)))
      ) {
        return false;
      }
      if (ts.isBlock(current.parent)) {
        for (const statement of current.parent.statements) {
          if (statement.pos >= current.pos) {
            break;
          }
          if (containsExit(statement)) {
            return false;
          }
        }
      }
      if (ts.isFunctionLike(current.parent)) {
        if (!ts.isArrowFunction(current.parent) && !ts.isFunctionExpression(current.parent)) {
          return false;
        }
        if (callbackKind(current.parent) !== "describe") {
          return false;
        }
      } else if (
        ts.isIfStatement(current.parent) ||
        ts.isConditionalExpression(current.parent) ||
        ts.isIterationStatement(current.parent, false) ||
        ts.isSwitchStatement(current.parent) ||
        ts.isBinaryExpression(current.parent)
      ) {
        return false;
      }
    }
    return true;
  };
  const teardowns = calls.flatMap((call) => {
    const context = contextOf(call);
    return context &&
      ["afterEach", "afterAll"].includes(context.kind) &&
      unconditional(call, context.callback) &&
      registeredUnconditionally(context)
      ? [{ call, context }]
      : [];
  });
  const restoresAll = (call: ts.CallExpression): boolean => {
    if (apiName(call.expression) === "restoreAllMocks") {
      return true;
    }
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) {
      return false;
    }
    const root = apiName(callee.expression);
    return (
      (root === "mock" && callee.name.text === "restore") ||
      (root === "jest" && callee.name.text === "restoreAllMocks")
    );
  };
  const failures: UnprovenSpy[] = [];
  const spies = calls.filter(isSpy);
  for (const spy of spies) {
    const fail = (reason: string): void => {
      failures.push({
        line: sourceFile.getLineAndCharacterOfPosition(spy.getStart(sourceFile)).line + 1,
        reason,
      });
    };
    const install = contextOf(spy);
    if (!install || !["it", "test", "beforeEach"].includes(install.kind)) {
      fail(
        install
          ? `spy installed in ${install.kind}; only tests/beforeEach are allowed`
          : "spy installed outside an inline test/beforeEach callback (module, describe or helper)",
      );
      continue;
    }
    if (teardowns.some(({ call, context }) => covers(context, install) && restoresAll(call))) {
      continue;
    }
    let result: ts.Expression = spy;
    let immediatelyRestored = false;
    while (true) {
      const parent = result.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)
      ) {
        result = parent;
      } else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === result &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        !parent.questionDotToken &&
        !parent.parent.questionDotToken
      ) {
        if (parent.name.text === "mockRestore") {
          immediatelyRestored = true;
          break;
        }
        if (
          ![
            "mockImplementation",
            "mockImplementationOnce",
            "mockReturnValue",
            "mockReturnValueOnce",
            "mockResolvedValue",
            "mockResolvedValueOnce",
            "mockRejectedValue",
            "mockRejectedValueOnce",
            "mockName",
          ].includes(parent.name.text)
        ) {
          break;
        }
        result = parent.parent;
      } else {
        break;
      }
    }
    if (immediatelyRestored) {
      continue;
    }
    let binding = result.parent;
    if (
      ts.isVariableDeclaration(binding) &&
      ts.isVariableDeclarationList(binding.parent) &&
      (binding.parent.flags & ts.NodeFlags.Using) !== 0
    ) {
      continue;
    }
    let collection: string | undefined;
    let index: number | undefined;
    if (ts.isArrayLiteralExpression(binding)) {
      index = binding.elements.indexOf(result);
      result = binding;
      binding = binding.parent;
    }
    let target: ts.Expression | undefined;
    if (ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name)) {
      target = binding.name;
    }
    if (
      ts.isBinaryExpression(binding) &&
      binding.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      binding.right === result
    ) {
      target = binding.left;
    }
    if (
      ts.isCallExpression(binding) &&
      ts.isPropertyAccessExpression(binding.expression) &&
      binding.expression.name.text === "push" &&
      binding.arguments.includes(result)
    ) {
      target = binding.expression.expression;
      collection = handle(target);
    }
    let storage = target && handle(target);
    if (index !== undefined && storage) {
      collection = storage;
      storage = `${storage}[${JSON.stringify(String(index))}]`;
    }
    const key = storage;
    if (!key) {
      fail("spy result has no tracked variable or static field/index");
      continue;
    }
    // Support fixed array slots, and complete unfiltered for-of/forEach cleanup.
    // Slices, aliases, destructive iteration and arbitrary helper calls are unknown.
    const restores = calls.flatMap<{ call: ts.CallExpression; event: ts.Node }>((call) => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "mockRestore") {
        return [];
      }
      if (handle(callee.expression) === key && !collection) {
        return [{ call, event: call }];
      }
      if (handle(callee.expression) === key && index !== undefined) {
        return [{ call, event: call }];
      }
      if (!collection || !ts.isIdentifier(callee.expression)) {
        return [];
      }
      const declaration = resolve(callee.expression)?.parent;
      if (declaration && ts.isParameter(declaration)) {
        const callback = declaration.parent;
        if (
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          ts.isCallExpression(callback.parent) &&
          ts.isPropertyAccessExpression(callback.parent.expression) &&
          callback.parent.expression.name.text === "forEach" &&
          handle(callback.parent.expression.expression) === collection &&
          callback.parameters[0] === declaration &&
          unconditional(call, callback)
        ) {
          return [{ call, event: callback.parent }];
        }
      }
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        ts.isForOfStatement(declaration.parent.parent)
      ) {
        const loop = declaration.parent.parent;
        if (
          handle(loop.expression) === collection &&
          unconditional(call, loop.statement) &&
          !containsExit(loop.statement)
        ) {
          return [{ call, event: loop }];
        }
      }
      return [];
    });
    const proven = restores.some(({ call: restore, event }) => {
      const cleanup = contextOf(event);
      if (
        !cleanup ||
        !unconditional(event, cleanup.callback) ||
        !registeredUnconditionally(cleanup)
      ) {
        return false;
      }
      const sameTest =
        cleanup.callback === install.callback &&
        install.kind !== "beforeEach" &&
        restore.pos > spy.pos;
      // afterAll restores only the last spy held by this handle, after every
      // beforeEach run, test.each row and test that wrote it, so it proves
      // cleanup only when every install spied the same target (#14515).
      const teardown =
        (cleanup.kind === "afterEach" || (cleanup.kind === "afterAll" && invariantTarget(spy))) &&
        covers(cleanup, install);
      if (!sameTest && !teardown) {
        return false;
      }
      if (
        collection &&
        calls.some(
          (call) =>
            ts.isPropertyAccessExpression(call.expression) &&
            handle(call.expression.expression) === collection &&
            !["push", "forEach"].includes(call.expression.name.text),
        )
      ) {
        return false;
      }
      // Losing a handle to a reassignment cannot be repaired by restoring the
      // replacement. Ignore writes in independent test callbacks (unless cleanup
      // is afterAll) and cleanup writes after this restore; otherwise fail closed
      // on competing writes.
      return !writes.some((write) => {
        const other = handle(write.target);
        if (
          !other ||
          !(other === key || key.startsWith(`${other}[`) || other.startsWith(`${key}[`)) ||
          write.node === binding
        ) {
          return false;
        }
        const context = contextOf(write.node);
        if (context?.callback === cleanup.callback && write.node.pos > restore.pos) {
          return false;
        }
        if (context?.callback === install.callback) {
          return (
            (write.node.pos > spy.pos && write.node.pos < restore.pos) ||
            (!sameTest && write.node.pos > spy.pos)
          );
        }
        // An afterAll restore runs after every test, so another test's write to
        // this handle replaces the spy before it is restored (#14515).
        if (
          context &&
          ["test", "it"].includes(context.kind) &&
          install.kind !== "beforeEach" &&
          cleanup.kind !== "afterAll"
        ) {
          return false;
        }
        if (
          context &&
          !sameScopes(context, install) &&
          !covers(context, install) &&
          !covers(install, context)
        ) {
          return false;
        }
        if (context) {
          return true;
        }
        return write.node.pos > spy.pos;
      });
    });
    if (!proven) {
      fail(
        "no unconditional restore of the same binding in this test or a covering afterEach/afterAll (or handle reassigned)",
      );
    }
  }
  return { sites: spies.length, unproven: failures };
}

export function classifySource(source: string): Classification {
  return analyzeSource(source).classification;
}

function analyzeSource(source: string): {
  classification: Classification;
  unproven: readonly UnprovenSpy[];
} {
  const sourceFile = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const ast = collectAstSignals(sourceFile);
  let hits = [...SIGNAL_RULES.filter((rule) => rule.pattern.test(source)), ...ast];
  const { sites, unproven } = ast.some((hit) => hit.name === "spyOn" || hit.name === "spyOnAlias")
    ? spyRestoreProof(sourceFile)
    : { sites: 0, unproven: [] };
  if (sites > 0 && unproven.length === 0) {
    hits = hits.filter((hit) => hit.name !== "spyOn" && hit.name !== "spyOnAlias");
  } else if (
    unproven.length > 0 &&
    !hits.some((hit) => hit.name === "spyOn" || hit.name === "spyOnAlias")
  ) {
    hits.push({ name: "spyOn", tier: "B" });
  }
  const tier: Tier = hits.some((rule) => rule.tier === "A") ? "A" : hits.length > 0 ? "B" : "C";
  return {
    classification: { tier, signals: [...new Set(hits.map((rule) => rule.name))] },
    unproven,
  };
}

/** Mirrors discover_unit_test_files in scripts/test-ts.sh. */
export function isUnitTestPath(path: string): boolean {
  return (
    path.startsWith("test/") &&
    path.endsWith(".test.ts") &&
    !path.endsWith(".integration.test.ts") &&
    !path.startsWith("test/stress/")
  );
}

export function parseAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

const ALLOWLIST_HEADER = [
  "# Unit test files that run together in shared (non-isolated) Bun processes.",
  "# Every other unit file runs under `bun test --isolate` (#10583).",
  "#",
  "# Generated by `bun scripts/test/classify-shared-safe.ts`; do not edit by hand.",
  "# Fast Validation runs it with --check. A listed file that gains a tier A/B",
  "# signal (mock.module, global or native patching, chdir, unproven spy restores,",
  "# env writes, singletons and setters on imported objects, the DB helpers, testOverrides, system time) fails the check;",
  "# spies qualify only in tests/beforeEach with every restore proven (#13568).",
  "# Losing proof reports file:line:reason. beforeAll spies always stay isolated.",
  "# Regenerate to move it back to the isolated group. New files run isolated",
  "# until the list is regenerated. See docs/design-docs/ci/unit-lane-scaling.md.",
];

export function renderAllowlist(paths: readonly string[]): string {
  return `${[...ALLOWLIST_HEADER, ...paths].join("\n")}\n`;
}

export interface UnitFile {
  readonly path: string;
  readonly source: string;
}

export function buildAllowlist(
  files: readonly UnitFile[],
  exclusions: Readonly<Record<string, string>> = SHARED_PROCESS_EXCLUSIONS,
): string[] {
  return files
    .filter((file) => isUnitTestPath(file.path) && !(file.path in exclusions))
    .filter((file) => classifySource(file.source).tier === "C")
    .map((file) => file.path)
    .sort();
}

export interface AllowlistCheck {
  /** Each entry fails the check. */
  readonly problems: readonly string[];
  /** Tier C files not listed yet; informational (they run isolated). */
  readonly candidates: readonly string[];
}

export function checkAllowlist(
  listed: readonly string[],
  files: readonly UnitFile[],
  exclusions: Readonly<Record<string, string>> = SHARED_PROCESS_EXCLUSIONS,
): AllowlistCheck {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const problems: string[] = [];
  const seen = new Set<string>();
  listed.forEach((path, index) => {
    if (seen.has(path)) {
      problems.push(`${path}: listed more than once`);
    }
    seen.add(path);
    if (index > 0 && listed[index - 1] > path) {
      problems.push(`${path}: out of order (the list must be sorted)`);
    }
    const file = byPath.get(path);
    if (!isUnitTestPath(path) || !file) {
      problems.push(`${path}: not an existing unit-lane test file (stale entry)`);
      return;
    }
    if (path in exclusions) {
      problems.push(`${path}: excluded from shared processes (${exclusions[path]})`);
      return;
    }
    const {
      classification: { tier, signals },
      unproven,
    } = analyzeSource(file.source);
    if (tier !== "C") {
      problems.push(
        `${path}: gained tier ${tier} signal(s) ${signals.join(", ")}; it must run isolated`,
      );
      for (const spy of unproven) {
        problems.push(`${path}:${spy.line}: ${spy.reason}`);
      }
    }
  });
  const candidates = buildAllowlist(
    files.filter((file) => !seen.has(file.path)),
    exclusions,
  );
  return { problems, candidates };
}

export interface CliIo {
  listUnitFiles(): UnitFile[];
  readAllowlist(): string | undefined;
  writeAllowlist(text: string): void;
  log(message: string): void;
  error(message: string): void;
}

const REGENERATE_HINT = "Run `bun scripts/test/classify-shared-safe.ts` and commit the result.";

export function runCli(argv: readonly string[], io: CliIo): number {
  if (argv[0] === "--explain" && argv.length <= 2) {
    const files = io.listUnitFiles().filter((file) => !argv[1] || file.path === argv[1]);
    if (argv[1] && files.length === 0) {
      io.error(`Not a unit-lane test file: ${argv[1]}`);
      return 2;
    }
    for (const file of files) {
      const { classification, unproven } = analyzeSource(file.source);
      if (
        !argv[1] &&
        (classification.signals.length === 0 ||
          classification.signals.some((signal) => signal !== "spyOn" && signal !== "spyOnAlias"))
      ) {
        continue;
      }
      for (const spy of unproven) {
        io.log(`${file.path}:${spy.line}: ${spy.reason}`);
      }
    }
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    io.error(
      `Unknown argument(s): ${unknown.join(" ")}. Usage: classify-shared-safe.ts [--check | --explain [path]]`,
    );
    return 2;
  }
  const files = io.listUnitFiles();
  if (!argv.includes("--check")) {
    const paths = buildAllowlist(files);
    io.writeAllowlist(renderAllowlist(paths));
    io.log(`Wrote ${ALLOWLIST_PATH}: ${paths.length} of ${files.length} unit files run shared.`);
    return 0;
  }
  const text = io.readAllowlist();
  if (text === undefined) {
    io.error(`${ALLOWLIST_PATH} is missing. ${REGENERATE_HINT}`);
    return 1;
  }
  const listed = parseAllowlist(text);
  const { problems, candidates } = checkAllowlist(listed, files);
  if (candidates.length > 0) {
    io.log(
      `${candidates.length} tier C unit file(s) are not listed and run isolated; ` +
        `regenerate to share them: ${candidates.slice(0, 10).join(", ")}${candidates.length > 10 ? ", …" : ""}`,
    );
  }
  if (problems.length > 0) {
    io.error(`${ALLOWLIST_PATH} is stale (${problems.length} problem(s)):`);
    for (const problem of problems) {
      io.error(`  ${problem}`);
    }
    io.error(REGENERATE_HINT);
    return 1;
  }
  io.log(`${ALLOWLIST_PATH}: ${listed.length} shared unit files, all tier C.`);
  return 0;
}

function discoverTestFiles(root: string, directory: string): string[] {
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return discoverTestFiles(root, path);
    }
    return entry.isFile() && entry.name.endsWith(".test.ts")
      ? [relative(root, path).split(sep).join("/")]
      : [];
  });
}

export function fileSystemIo(root: string): CliIo {
  const allowlistFile = join(root, ALLOWLIST_PATH);
  return {
    listUnitFiles: () =>
      discoverTestFiles(root, join(root, "test"))
        .filter(isUnitTestPath)
        .sort()
        .map((path) => ({ path, source: readFileSync(join(root, path), "utf8") })),
    readAllowlist: () =>
      existsSync(allowlistFile) ? readFileSync(allowlistFile, "utf8") : undefined,
    writeAllowlist: (text) => writeFileSync(allowlistFile, text),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  };
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2), fileSystemIo(join(import.meta.dir, "../.."))));
}
