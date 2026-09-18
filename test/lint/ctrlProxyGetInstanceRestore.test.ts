import ts from "typescript";
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Leak guard for the CtrlProxy singletons' `getInstance` seam (issue #7052).
 *
 * `AndroidCtrlProxyClient` / `IOSCtrlProxyClient` / `AndroidCtrlProxyManager` /
 * `IOSCtrlProxyManager` are process-wide singletons. Their static `getInstance`
 * is the seam tests replace with a bare assignment to observe how a feature
 * routes through the proxy. Bun runs an entire `bun test` invocation in ONE
 * process, so a mock left installed on `getInstance` outlives the file that set
 * it and contaminates every later suite in the run.
 *
 * That is exactly what #7052 was: a daemon suite installed a mock and its
 * teardown "restored" a value it had captured AFTER the mock was already in
 * place, so `getInstance` stayed a mock. A later `spyOn(AndroidCtrlProxyClient,
 * "getInstance")` in `test/server/resources/bootedDevices.test.ts` then wrapped
 * that leaked mock — which an intervening suite had already called — and the
 * "constructs no CtrlProxy" assertion saw a phantom call. `bun test test/server`
 * alone passed; only `bun test test/daemon test/server` in one invocation failed.
 *
 * This is an ORDERING/lifetime obligation ("whatever you install, restore before
 * the file ends"), which no type can express, so it is a source scan. The rule
 * is deliberately narrow: any test file that INSTALLS a fresh `getInstance`
 * implementation by DIRECT ASSIGNMENT (`<Symbol>.getInstance = …`) MUST also
 * RESTORE that same symbol somewhere in the file, and the file must appear in
 * the inventory below. A new installer — a new file, or a new symbol in a listed
 * file — fails here until it is both restored and inventoried. The count of
 * installs is intentionally NOT pinned (suites add per-test mocks freely); only
 * "installs ⇒ a restore exists for that symbol" is.
 *
 * It cannot prove a restore is CORRECT (the #7052 file had a restore that saved
 * the wrong value); the real fix for that lives in the suite. What it does
 * guarantee is that the "installed but never restored" class — the simplest and
 * most common way to leak this seam — cannot be introduced silently.
 *
 * The classifier is structural, not textual. Earlier revisions matched
 * `<Symbol>.getInstance =` with one regex, which let three real false negatives
 * through (PR #7058 review): a typed cast the regex could not spell
 * (`(Symbol as unknown as { … }).getInstance =`), a named local mock assigned by
 * bare identifier (`Symbol.getInstance = fakeGetInstance`, which the regex read
 * as a restore), and a file-wide `.mockRestore()` acquittal that any unrelated
 * spy could satisfy. It now parses the file with the TypeScript AST — unwrapping
 * casts/parens on both sides of the assignment, following an assigned
 * identifier back to its declaration to tell a fresh mock from an original-value
 * capture, and tying a `.mockRestore()` acquittal to the specific spy handle
 * returned by `spyOn(<Symbol>, "getInstance")`.
 */
describe("CtrlProxy getInstance mocks are restored in-file (issue #7052)", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const TEST = join(ROOT, "test");

  /** The singleton symbols whose `getInstance` seam must not leak across files. */
  const SYMBOLS = [
    "AndroidCtrlProxyClient",
    "IOSCtrlProxyClient",
    "AndroidCtrlProxyManager",
    "IOSCtrlProxyManager",
  ] as const;
  type CtrlProxySymbol = (typeof SYMBOLS)[number];
  const SYMBOL_SET = new Set<string>(SYMBOLS);

  /**
   * A cheap raw-byte prefilter: only files that mention `CtrlProxy` at all pay
   * for AST parsing and scanning, which keeps this inside the 100ms budget.
   */
  const PREFILTER = "CtrlProxy";

  // This guard's own file, excluded from the scan: its example snippets live in
  // string literals fed to the classifier directly, not as real seams.
  const SELF = "test/lint/ctrlProxyGetInstanceRestore.test.ts";

  interface FileFacts {
    /** Symbols whose `getInstance` this file replaces with a fresh implementation. */
    readonly installs: ReadonlySet<CtrlProxySymbol>;
    /** Symbols installed by a direct assignment rather than a `spyOn` handle. */
    readonly directInstalls: ReadonlySet<CtrlProxySymbol>;
    /** Symbols installed by assigning a `spyOn(<Symbol>, "getInstance")` handle. */
    readonly spyInstalls: ReadonlySet<CtrlProxySymbol>;
    /** Symbols this file assigns a captured original back to (a direct restore). */
    readonly restores: ReadonlySet<CtrlProxySymbol>;
    /** The final direct-install position for each symbol, used to prove ordering. */
    readonly directInstallPositions: ReadonlyMap<CtrlProxySymbol, number>;
    /** The final spy-handle-install position for each symbol, used to prove ordering. */
    readonly spyInstallPositions: ReadonlyMap<CtrlProxySymbol, number>;
    /** The final direct-restore position for each symbol, used to prove ordering. */
    readonly restorePositions: ReadonlyMap<CtrlProxySymbol, number>;
    /**
     * Symbols acquitted by a `.mockRestore()` on the handle that
     * `spyOn(<Symbol>, "getInstance")` returned — the only `.mockRestore()` that
     * actually restores this seam.
     */
    readonly restoredBySpy: ReadonlySet<CtrlProxySymbol>;
    /** The final matching spy-handle restore position for each symbol. */
    readonly spyRestorePositions: ReadonlyMap<CtrlProxySymbol, number>;
  }

  /** Peel `(expr)`, `expr as T`, `<T>expr`, `expr!`, `expr satisfies T` down to the core. */
  function unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    for (;;) {
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      return current;
    }
  }

  /**
   * Test-framework teardown callbacks execute after the test bodies even when
   * their registration appears first in source. Model their restores as the
   * final file event so source ordering catches ordinary direct code without
   * rejecting established `afterEach(() => restore())` and
   * `afterEach(restore)` suite patterns.
   */
  function runsInTeardownCallback(
    node: ts.Node,
    teardownCallbacks: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): boolean {
    for (let current = node.parent; current;) {
      if (!ts.isFunctionLike(current)) {
        current = current.parent;
        continue;
      }
      if (teardownCallbacks.has(current)) {
        return true;
      }
      const call = current.parent;
      if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === current)) {
        return false;
      }
      current = call.parent;
    }
    return false;
  }

  type SymbolResolver = (name: ts.Identifier) => CtrlProxySymbol | undefined;

  /** The CtrlProxy symbol an expression names directly (after unwrapping), if any. */
  function symbolOf(
    node: ts.Expression,
    resolveSymbol: SymbolResolver,
  ): CtrlProxySymbol | undefined {
    const core = unwrap(node);
    if (ts.isIdentifier(core)) {
      return resolveSymbol(core);
    }
    return undefined;
  }

  /** The `<Symbol>.getInstance` an assignment target names (after unwrapping), if any. */
  function getInstanceTarget(
    node: ts.Expression,
    resolveSymbol: SymbolResolver,
  ): CtrlProxySymbol | undefined {
    const core = unwrap(node);
    if (ts.isPropertyAccessExpression(core) && core.name.text === "getInstance") {
      return symbolOf(core.expression, resolveSymbol);
    }
    return undefined;
  }

  /**
   * A fresh implementation of the seam: an inline function, or a factory call
   * (`mock(...)` / `spyOn(...)`, including a chained `spyOn(...).mockX(...)`).
   * These are installs wherever they appear on the RHS.
   */
  function isFreshMock(node: ts.Expression): boolean {
    const core = unwrap(node);
    if (ts.isArrowFunction(core) || ts.isFunctionExpression(core)) {
      return true;
    }
    if (ts.isCallExpression(core)) {
      const callee = leftmostCallName(core);
      return callee === "mock" || callee === "spyOn";
    }
    return false;
  }

  /** The leftmost callee identifier of a (possibly chained) call expression. */
  function leftmostCallName(call: ts.CallExpression): string | undefined {
    let expr: ts.Expression = unwrap(call.expression);
    for (;;) {
      if (ts.isPropertyAccessExpression(expr)) {
        expr = unwrap(expr.expression);
        continue;
      }
      if (ts.isCallExpression(expr)) {
        expr = unwrap(expr.expression);
        continue;
      }
      return ts.isIdentifier(expr) ? expr.text : undefined;
    }
  }

  /** True when an expression captures the live `<Symbol>.getInstance` value. */
  function capturesOriginal(
    node: ts.Expression,
    resolveSymbol: SymbolResolver,
  ): CtrlProxySymbol | undefined {
    return getInstanceTarget(node, resolveSymbol);
  }

  /**
   * If an expression is (or chains onto) `spyOn(<Symbol>, "getInstance")`, the
   * symbol it spies. Handles `spyOn(X, "getInstance").mockReturnValue(...)`.
   */
  function spyOnGetInstanceSymbol(
    node: ts.Expression,
    resolveSymbol: SymbolResolver,
  ): CtrlProxySymbol | undefined {
    let expr: ts.Expression = unwrap(node);
    for (;;) {
      if (ts.isCallExpression(expr)) {
        const callee = unwrap(expr.expression);
        if (ts.isIdentifier(callee) && callee.text === "spyOn" && expr.arguments.length >= 2) {
          const target = symbolOf(expr.arguments[0], resolveSymbol);
          const prop = expr.arguments[1];
          if (target !== undefined && ts.isStringLiteralLike(prop) && prop.text === "getInstance") {
            return target;
          }
        }
        // Not this call; descend through a chain like `.mockReturnValue(...)`.
        if (ts.isPropertyAccessExpression(callee)) {
          expr = unwrap(callee.expression);
          continue;
        }
        return undefined;
      }
      if (ts.isPropertyAccessExpression(expr)) {
        expr = unwrap(expr.expression);
        continue;
      }
      return undefined;
    }
  }

  /**
   * Parse one source and classify every `<Symbol>.getInstance =` assignment as
   * an install (fresh implementation) or a restore (a captured original). The
   * `relPathHint` only labels the synthetic parse; nothing keys off it.
   */
  function analyzeSource(source: string, relPathHint = "synthetic.ts"): FileFacts {
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noResolve: true,
      target: ts.ScriptTarget.Latest,
    };
    const host = ts.createCompilerHost(compilerOptions);
    host.getSourceFile = (fileName, languageVersion) =>
      fileName === relPathHint
        ? ts.createSourceFile(fileName, source, languageVersion, true)
        : undefined;
    host.fileExists = (fileName) => fileName === relPathHint;
    host.readFile = (fileName) => (fileName === relPathHint ? source : undefined);
    const program = ts.createProgram([relPathHint], compilerOptions, host);
    const sf = program.getSourceFile(relPathHint);
    if (sf === undefined) {
      throw new Error(`TypeScript did not create source file: ${relPathHint}`);
    }
    const checker = program.getTypeChecker();
    const ctrlProxyBindings = new Map<ts.Symbol, CtrlProxySymbol>();
    for (const statement of sf.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      for (const specifier of statement.importClause.namedBindings.elements) {
        const exportedName = specifier.propertyName?.text ?? specifier.name.text;
        if (SYMBOL_SET.has(exportedName)) {
          const binding = checker.getSymbolAtLocation(specifier.name);
          if (binding !== undefined) {
            ctrlProxyBindings.set(binding, exportedName as CtrlProxySymbol);
          }
        }
      }
    }

    const isTeardownHook = (callee: ts.Expression): boolean => {
      const core = unwrap(callee);
      if (!ts.isIdentifier(core) || (core.text !== "afterEach" && core.text !== "afterAll")) {
        return false;
      }
      const binding = checker.getSymbolAtLocation(core);
      if (binding === undefined) {
        return true;
      }
      return (binding.declarations ?? []).some((declaration) => {
        if (!ts.isImportSpecifier(declaration)) {
          return false;
        }
        const importDeclaration = declaration.parent.parent.parent;
        return (
          ts.isImportDeclaration(importDeclaration) &&
          ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === "bun:test"
        );
      });
    };
    const reassignedBindings = new Set<ts.Symbol>();
    const recordReassignedTarget = (target: ts.Expression): void => {
      const core = unwrap(target);
      if (ts.isIdentifier(core)) {
        const binding = checker.getSymbolAtLocation(core);
        if (binding !== undefined) {
          reassignedBindings.add(binding);
        }
        return;
      }
      if (ts.isArrayLiteralExpression(core)) {
        for (const element of core.elements) {
          if (ts.isOmittedExpression(element)) {
            continue;
          }
          recordReassignedTarget(ts.isSpreadElement(element) ? element.expression : element);
        }
        return;
      }
      if (ts.isObjectLiteralExpression(core)) {
        for (const property of core.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            recordReassignedTarget(property.name);
          } else if (ts.isPropertyAssignment(property) || ts.isSpreadAssignment(property)) {
            recordReassignedTarget(property.initializer ?? property.expression);
          }
        }
      }
    };
    const reassignmentWalk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
        recordReassignedTarget(node.left);
      }
      ts.forEachChild(node, reassignmentWalk);
    };
    reassignmentWalk(sf);

    const teardownCallbacks = new Set<ts.FunctionLikeDeclaration>();
    const addTeardownCallback = (argument: ts.Expression): void => {
      if (ts.isFunctionLike(argument)) {
        teardownCallbacks.add(argument);
        return;
      }
      if (!ts.isIdentifier(argument)) {
        return;
      }
      const binding = checker.getSymbolAtLocation(argument);
      if (binding === undefined || reassignedBindings.has(binding)) {
        return;
      }
      for (const declaration of binding?.declarations ?? []) {
        if (ts.isFunctionDeclaration(declaration)) {
          teardownCallbacks.add(declaration);
        }
      }
    };
    const teardownWalk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (isTeardownHook(node.expression)) {
          for (const argument of node.arguments) {
            if (!ts.isSpreadElement(argument)) {
              addTeardownCallback(argument);
            }
          }
        }
      }
      ts.forEachChild(node, teardownWalk);
    };
    teardownWalk(sf);

    const eventPosition = (node: ts.Node): number =>
      runsInTeardownCallback(node, teardownCallbacks) ? Number.MAX_SAFE_INTEGER : node.pos;

    const resolveSymbol: SymbolResolver = (name) => {
      const binding = checker.getSymbolAtLocation(name);
      if (binding !== undefined) {
        return ctrlProxyBindings.get(binding);
      }
      return SYMBOL_SET.has(name.text) ? (name.text as CtrlProxySymbol) : undefined;
    };

    // First pass: learn what every bare identifier was bound to, so a later
    // `Symbol.getInstance = someId` can tell a fresh mock from an original
    // capture, and which locals are `spyOn(<Symbol>, "getInstance")` handles.
    const idIsMock = new Set<ts.Symbol>();
    const idIsOriginalCapture = new Map<ts.Symbol, CtrlProxySymbol>();
    const spyVarSymbol = new Map<ts.Symbol, CtrlProxySymbol>();
    const mockRestoreTargets: { readonly receiver: ts.Identifier; readonly pos: number }[] = [];

    const learn = (binding: ts.Symbol | undefined, init: ts.Expression): void => {
      if (binding === undefined) {
        return;
      }
      const spied = spyOnGetInstanceSymbol(init, resolveSymbol);
      if (spied !== undefined) {
        spyVarSymbol.set(binding, spied);
      }
      if (isFreshMock(init)) {
        idIsMock.add(binding);
      } else {
        const captured = capturesOriginal(init, resolveSymbol);
        if (captured !== undefined) {
          idIsOriginalCapture.set(binding, captured);
        }
      }
    };

    const learnWalk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const binding = checker.getSymbolAtLocation(node.name);
        if (node.initializer) {
          learn(binding, node.initializer);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrap(node.left))
      ) {
        const name = unwrap(node.left) as ts.Identifier;
        const binding = checker.getSymbolAtLocation(name);
        learn(binding, node.right);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "mockRestore"
      ) {
        const receiver = unwrap(node.expression.expression);
        if (ts.isIdentifier(receiver)) {
          mockRestoreTargets.push({ receiver, pos: eventPosition(node) });
        }
      }
      ts.forEachChild(node, learnWalk);
    };
    learnWalk(sf);

    const directInstalls = new Set<CtrlProxySymbol>();
    const spyInstalls = new Set<CtrlProxySymbol>();
    const restores = new Set<CtrlProxySymbol>();
    const directInstallPositions = new Map<CtrlProxySymbol, number>();
    const spyInstallPositions = new Map<CtrlProxySymbol, number>();
    const restorePositions = new Map<CtrlProxySymbol, number>();

    /** Keep the final event of each kind even if an AST shape is revisited. */
    const recordFinalPosition = (
      positions: Map<CtrlProxySymbol, number>,
      symbol: CtrlProxySymbol,
      pos: number,
    ): void => {
      if ((positions.get(symbol) ?? -1) < pos) {
        positions.set(symbol, pos);
      }
    };

    const recordInstall = (symbol: CtrlProxySymbol, rhs: ts.Expression, pos: number): void => {
      const core = unwrap(rhs);
      const binding = ts.isIdentifier(core) ? checker.getSymbolAtLocation(core) : undefined;
      if (
        spyOnGetInstanceSymbol(rhs, resolveSymbol) === symbol ||
        (binding !== undefined && spyVarSymbol.get(binding) === symbol)
      ) {
        spyInstalls.add(symbol);
        recordFinalPosition(spyInstallPositions, symbol, pos);
      } else {
        directInstalls.add(symbol);
        recordFinalPosition(directInstallPositions, symbol, pos);
      }
    };

    const classifyWalk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const symbol = getInstanceTarget(node.left, resolveSymbol);
        if (symbol !== undefined) {
          const rhs = node.right;
          const core = unwrap(rhs);
          if (isFreshMock(rhs)) {
            recordInstall(symbol, rhs, eventPosition(node));
          } else if (ts.isIdentifier(core)) {
            const binding = checker.getSymbolAtLocation(core);
            const capturedFrom =
              binding === undefined ? undefined : idIsOriginalCapture.get(binding);
            if (binding !== undefined && idIsMock.has(binding)) {
              recordInstall(symbol, rhs, eventPosition(node));
            } else if (capturedFrom === symbol) {
              restores.add(symbol);
              recordFinalPosition(restorePositions, symbol, eventPosition(node));
            } else {
              // Cannot prove this identifier holds this symbol's captured original,
              // so it is not a verifiable restore — treat it as a fresh install.
              recordInstall(symbol, rhs, eventPosition(node));
            }
          } else {
            // Any other RHS shape is a fresh value, not an original capture.
            recordInstall(symbol, rhs, eventPosition(node));
          }
        }
      }
      ts.forEachChild(node, classifyWalk);
    };
    classifyWalk(sf);

    const restoredBySpy = new Set<CtrlProxySymbol>();
    const spyRestorePositions = new Map<CtrlProxySymbol, number>();
    for (const target of mockRestoreTargets) {
      const binding = checker.getSymbolAtLocation(target.receiver);
      const symbol = binding === undefined ? undefined : spyVarSymbol.get(binding);
      if (symbol !== undefined) {
        restoredBySpy.add(symbol);
        recordFinalPosition(spyRestorePositions, symbol, target.pos);
      }
    }

    const installs = new Set([...directInstalls, ...spyInstalls]);
    return {
      installs,
      directInstalls,
      spyInstalls,
      restores,
      directInstallPositions,
      spyInstallPositions,
      restorePositions,
      restoredBySpy,
      spyRestorePositions,
    };
  }

  /** Symbols a file installs without any in-file restoration (a leak). */
  function leaksOf(file: string, facts: FileFacts): string[] {
    const leaks: string[] = [];
    for (const symbol of facts.directInstalls) {
      const installPos = facts.directInstallPositions.get(symbol);
      const restorePos = facts.restorePositions.get(symbol);
      if (installPos === undefined || restorePos === undefined || restorePos <= installPos) {
        leaks.push(`${file}: installs ${symbol}.getInstance but never restores it`);
      }
    }
    for (const symbol of facts.spyInstalls) {
      const installPos = facts.spyInstallPositions.get(symbol);
      const directRestorePos = facts.restorePositions.get(symbol);
      const spyRestorePos = facts.spyRestorePositions.get(symbol);
      if (
        installPos === undefined ||
        ((directRestorePos === undefined || directRestorePos <= installPos) &&
          (spyRestorePos === undefined || spyRestorePos <= installPos))
      ) {
        leaks.push(`${file}: installs ${symbol}.getInstance but never restores it`);
      }
    }
    return leaks;
  }

  function walk(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, files);
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  let cached: Map<string, FileFacts> | undefined;

  beforeAll(() => {
    scan();
  });

  function scan(): Map<string, FileFacts> {
    if (cached !== undefined) {
      return cached;
    }
    const facts = new Map<string, FileFacts>();
    for (const file of walk(TEST)) {
      if (!readFileSync(file).includes(PREFILTER)) {
        continue;
      }
      const relPath = relative(ROOT, file).split(sep).join("/");
      if (relPath === SELF) {
        continue;
      }
      const f = analyzeSource(readFileSync(file, "utf8"), relPath);
      if (f.installs.size > 0 || f.restores.size > 0) {
        facts.set(relPath, f);
      }
    }
    cached = facts;
    return facts;
  }

  /**
   * The inventory of test files that install a CtrlProxy `getInstance` mock by
   * direct assignment. Presence here is the whole assertion — a file is listed
   * once and only its "every install is restored" obligation (below) is
   * enforced, so the list does not churn as suites add or drop individual
   * per-test mocks. Add a new file here only after confirming its teardown
   * restores every symbol it installs.
   */
  const INSTALLERS: readonly string[] = [
    "test/daemon/socketServerInputGesture.integration.test.ts",
    "test/daemon/socketServerInputSwipe.integration.test.ts",
    "test/daemon/socketServerInputTap.integration.test.ts",
    "test/daemon/socketServerInputTypeText.integration.test.ts",
    "test/daemon/socketServerKeyValue.integration.test.ts",
    "test/daemon/socketServerToolCapabilities.integration.test.ts",
    "test/features/action/ClearText.adbFactory.test.ts",
    "test/features/action/InputText.test.ts",
    "test/features/observe/TakeScreenshot.AndroidCancellation.test.ts",
    "test/features/observe/TakeScreenshot.AndroidCtrlProxy.test.ts",
    "test/features/observe/TakeScreenshot.iOS.test.ts",
    "test/server/ToolExecutionContext.test.ts",
    "test/server/databaseIos.test.ts",
    "test/server/databaseResourcesPagination.test.ts",
    "test/server/deviceTools.killDevice.test.ts",
    "test/server/toolRegistry.pipeline.test.ts",
    "test/server/unissuedSessionBoundConnection.integration.test.ts",
  ];

  test("every file that installs a CtrlProxy getInstance mock is inventoried", () => {
    const facts = scan();
    const listed = new Set(INSTALLERS);
    const unlisted = [...facts.entries()]
      .filter(([file, f]) => f.installs.size > 0 && !listed.has(file))
      .map(([file]) => file)
      .sort();
    expect(unlisted).toEqual([]);
  });

  test("every inventoried installer still installs (prune stale entries)", () => {
    const facts = scan();
    const stale = INSTALLERS.filter((file) => {
      const f = facts.get(file);
      return f === undefined || f.installs.size === 0;
    }).sort();
    expect(stale).toEqual([]);
  });

  test("every installed getInstance symbol is restored in the same file", () => {
    const facts = scan();
    const leaks: string[] = [];
    for (const [file, f] of facts) {
      leaks.push(...leaksOf(file, f));
    }
    expect(leaks.sort()).toEqual([]);
  });

  // --- Self-tests: the classifier proven on synthetic snippets --------------
  // These plant the exact shapes the earlier regex mishandled and assert the AST
  // classifier reads them correctly. Each parses a tiny string, so it stays well
  // inside the 100ms budget without touching the memoized real-tree scan.

  test("a fresh inline mock assigned directly is an install", () => {
    const f = analyzeSource(
      `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n` +
        `IOSCtrlProxyClient.getInstance = (() => ({})) as never;\n` +
        `AndroidCtrlProxyManager.getInstance = async () => ({});\n`,
    );
    expect([...f.installs].sort()).toEqual([
      "AndroidCtrlProxyClient",
      "AndroidCtrlProxyManager",
      "IOSCtrlProxyClient",
    ]);
    expect([...f.restores]).toEqual([]);
  });

  test("a captured original assigned back is a restore, not an install", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n` +
        `AndroidCtrlProxyClient.getInstance = original;\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("x", f)).toEqual([]);
  });

  test("import-alias installs are inventoried and flagged when unrestored", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `Client.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("alias.ts", f)).toEqual([
      "alias.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
    const restored = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `const originalCapturedFromClient = Client.getInstance;\n` +
        `Client.getInstance = mock(() => ({}));\n` +
        `Client.getInstance = originalCapturedFromClient;\n`,
    );
    expect([...restored.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...restored.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("alias-restored.ts", restored)).toEqual([]);
  });

  test("a captured original from another CtrlProxy symbol is not a restore", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `IOSCtrlProxyClient.getInstance = mock(() => ({}));\n` +
        `IOSCtrlProxyClient.getInstance = original;\n`,
    );
    expect([...f.installs]).toEqual(["IOSCtrlProxyClient"]);
    expect([...f.restores]).toEqual([]);
    expect(leaksOf("cross-symbol.ts", f)).toEqual([
      "cross-symbol.ts: installs IOSCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("a restored getInstance spy does not acquit a separate direct assignment", () => {
    const f = analyzeSource(
      `const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");\n` +
        `getInstanceSpy.mockRestore();\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restoredBySpy]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("separate.ts", f)).toEqual([
      "separate.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("HOLE 1: a shadowed CtrlProxy import alias cannot restore an outer install", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `Client.getInstance = mock(() => ({}));\n` +
        `function unrelatedThing(Client: SomeOtherType) {\n` +
        `  const original = Client.getInstance;\n` +
        `  Client.getInstance = mock(() => ({}));\n` +
        `  Client.getInstance = original;\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual([]);
    expect(leaksOf("shadowed-alias.ts", f)).toEqual([
      "shadowed-alias.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("HOLE 2: a var capture restores outside its nested block", () => {
    const f = analyzeSource(
      `function setup() {\n` +
        `  { var original = AndroidCtrlProxyClient.getInstance; }\n` +
        `  AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n` +
        `  AndroidCtrlProxyClient.getInstance = original;\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("var-capture.ts", f)).toEqual([]);
  });

  test("HOLE 3: a direct restore acquits a spy-handle install", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");\n` +
        `AndroidCtrlProxyClient.getInstance = getInstanceSpy;\n` +
        `AndroidCtrlProxyClient.getInstance = original;\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.spyInstalls]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("direct-spy-restore.ts", f)).toEqual([]);
  });

  test("REGRESSION 1: a spy install after a direct restore is still a leak", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `AndroidCtrlProxyClient.getInstance = original;\n` +
        `const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");\n` +
        `AndroidCtrlProxyClient.getInstance = getInstanceSpy;\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.spyInstalls]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("restore-before-spy-install.ts", f)).toEqual([
      "restore-before-spy-install.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("REGRESSION 1: a spy restore before a spy-handle install is still a leak", () => {
    const f = analyzeSource(
      `const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");\n` +
        `getInstanceSpy.mockRestore();\n` +
        `AndroidCtrlProxyClient.getInstance = getInstanceSpy;\n`,
    );
    expect([...f.spyInstalls]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restoredBySpy]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("spy-restore-before-install.ts", f)).toEqual([
      "spy-restore-before-install.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("REGRESSION 2: a real install before a loop-scoped alias shadow is still detected", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `function setup(someArray: unknown[]) {\n` +
        `  Client.getInstance = mock(() => ({}));\n` +
        `  for (const Client of someArray) {\n` +
        `    void Client;\n` +
        `  }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("loop-shadow.ts", f)).toEqual([
      "loop-shadow.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("REGRESSION 2: a clean loop-local alias use is not misattributed", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `for (const Client of someArray) {\n` +
        `  Client.getInstance = () => ({});\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual([]);
    expect(leaksOf("loop-local.ts", f)).toEqual([]);
  });

  test("THREAD A: a catch-local alias cannot hide a prior imported-alias install", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `function setup() {\n` +
        `  Client.getInstance = mock(() => ({}));\n` +
        `  try {} catch (Client) {\n` +
        `    void Client;\n` +
        `  }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("catch-shadow.ts", f)).toEqual([
      "catch-shadow.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD A: a switch case-local alias cannot hide a prior imported-alias install", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `function setup(value: unknown) {\n` +
        `  Client.getInstance = mock(() => ({}));\n` +
        `  switch (value) {\n` +
        `    case 1:\n` +
        `      const Client = other;\n` +
        `      void Client;\n` +
        `      break;\n` +
        `  }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("case-shadow.ts", f)).toEqual([
      "case-shadow.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD A: harmless catch- and case-local aliases are not misattributed", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `function setup(value: unknown) {\n` +
        `  try {} catch (Client) {\n` +
        `    Client.getInstance = () => ({});\n` +
        `  }\n` +
        `  switch (value) {\n` +
        `    case 1:\n` +
        `      const Client = other;\n` +
        `      Client.getInstance = () => ({});\n` +
        `      break;\n` +
        `  }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual([]);
    expect(leaksOf("clean-local-aliases.ts", f)).toEqual([]);
  });

  test("THREAD B: nested using aliases cannot hide a prior imported-alias install", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `async function setup() {\n` +
        `  Client.getInstance = mock(() => ({}));\n` +
        `  { using Client = someResource; void Client; }\n` +
        `  { await using Client = anotherResource; void Client; }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("using-shadow.ts", f)).toEqual([
      "using-shadow.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD B: a nested using alias is not misattributed", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `async function setup() {\n` +
        `  {\n` +
        `    await using Client = someResource;\n` +
        `    Client.getInstance = () => ({});\n` +
        `  }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual([]);
    expect(leaksOf("clean-using-local.ts", f)).toEqual([]);
  });

  test("THREAD C: nested helper callbacks inside afterEach restore teardown-ordered installs", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n` +
        `afterEach(() => helper(() => helper(() => {\n` +
        `  AndroidCtrlProxyClient.getInstance = original;\n` +
        `})));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("nested-teardown-restore.ts", f)).toEqual([]);
  });

  test("THREAD C: a later teardown spy install remains a leak after a nested helper restore", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `afterEach(() => helper(() => helper(() => {\n` +
        `  AndroidCtrlProxyClient.getInstance = original;\n` +
        `})));\n` +
        `afterEach(() => {\n` +
        `  const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");\n` +
        `  AndroidCtrlProxyClient.getInstance = getInstanceSpy;\n` +
        `});\n`,
    );
    expect([...f.spyInstalls]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("restore-before-later-teardown-spy.ts", f)).toEqual([
      "restore-before-later-teardown-spy.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD 1: a block-level function cannot hide a prior imported-alias install", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `function setup() {\n` +
        `  Client.getInstance = mock(() => ({}));\n` +
        `  { function Client() {} }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("block-function-shadow.ts", f)).toEqual([
      "block-function-shadow.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD 1: a block-level function's local use is not misattributed", () => {
    const f = analyzeSource(
      `import { AndroidCtrlProxyClient as Client } from "some/path";\n` +
        `function setup() {\n` +
        `  { function Client() { Client.getInstance = mock(() => ({})); } }\n` +
        `}\n`,
    );
    expect([...f.installs]).toEqual([]);
    expect(leaksOf("block-function-local.ts", f)).toEqual([]);
  });

  test("THREAD 2: a named afterEach callback restores a later install", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `function restoreSingleton() {\n` +
        `  AndroidCtrlProxyClient.getInstance = original;\n` +
        `}\n` +
        `afterEach(restoreSingleton);\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("named-teardown-restore.ts", f)).toEqual([]);
  });

  test("THREAD 2: an ordinary named function does not become teardown", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `function restoreSingleton() {\n` +
        `  AndroidCtrlProxyClient.getInstance = original;\n` +
        `}\n` +
        `restoreSingleton();\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("ordinary-named-restore.ts", f)).toEqual([
      "ordinary-named-restore.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("a local afterEach helper does not make a restore teardown-ordered", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `function afterEach(callback: () => void) { callback(); }\n` +
        `afterEach(() => { AndroidCtrlProxyClient.getInstance = original; });\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("local-after-each.ts", f)).toEqual([
      "local-after-each.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("a reassigned named teardown callback does not restore a later install", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `function restoreSingleton() {\n` +
        `  AndroidCtrlProxyClient.getInstance = original;\n` +
        `}\n` +
        `restoreSingleton = () => {};\n` +
        `afterEach(restoreSingleton);\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("reassigned-named-teardown.ts", f)).toEqual([
      "reassigned-named-teardown.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("an uncalled nested function in teardown does not restore a later install", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `afterEach(() => {\n` +
        `  function neverCalled() { AndroidCtrlProxyClient.getInstance = original; }\n` +
        `});\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("uncalled-nested-function.ts", f)).toEqual([
      "uncalled-nested-function.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("a destructuring reassignment invalidates a named teardown callback", () => {
    const f = analyzeSource(
      `const original = AndroidCtrlProxyClient.getInstance;\n` +
        `function restoreSingleton() {\n` +
        `  AndroidCtrlProxyClient.getInstance = original;\n` +
        `}\n` +
        `[restoreSingleton] = [() => {}];\n` +
        `afterEach(restoreSingleton);\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("destructured-named-teardown.ts", f)).toEqual([
      "destructured-named-teardown.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD 1: a typed-cast install with no restore is flagged", () => {
    const f = analyzeSource(
      `(\n` +
        `  IOSCtrlProxyManager as unknown as {\n` +
        `    getInstance: typeof IOSCtrlProxyManager.getInstance;\n` +
        `  }\n` +
        `).getInstance = () => ({ stop: () => x });\n`,
    );
    expect([...f.installs]).toEqual(["IOSCtrlProxyManager"]);
    expect(leaksOf("cast.ts", f)).toEqual([
      "cast.ts: installs IOSCtrlProxyManager.getInstance but never restores it",
    ]);
  });

  test("THREAD 1: a typed-cast install with a matching cast restore is clean", () => {
    const f = analyzeSource(
      `const originalGetInstance = IOSCtrlProxyManager.getInstance;\n` +
        `(IOSCtrlProxyManager as unknown as { getInstance: unknown }).getInstance =\n` +
        `  () => ({ stop: () => x });\n` +
        `(IOSCtrlProxyManager as unknown as { getInstance: unknown }).getInstance =\n` +
        `  originalGetInstance;\n`,
    );
    expect([...f.installs]).toEqual(["IOSCtrlProxyManager"]);
    expect([...f.restores]).toEqual(["IOSCtrlProxyManager"]);
    expect(leaksOf("cast.ts", f)).toEqual([]);
  });

  test("THREAD 2: a named local mock assigned by identifier is an install and flagged", () => {
    const f = analyzeSource(
      `const fakeGetInstance = mock(() => ({}));\n` +
        `AndroidCtrlProxyClient.getInstance = fakeGetInstance;\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual([]);
    expect(leaksOf("named.ts", f)).toEqual([
      "named.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD 2: an arrow-returning-client local mock assigned by identifier is an install", () => {
    const f = analyzeSource(
      `const fake = () => ({ requestSetText: async () => ({}) });\n` +
        `AndroidCtrlProxyClient.getInstance = fake as never;\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restores]).toEqual([]);
  });

  test("THREAD 3: an unrelated mockRestore does not acquit a direct assignment", () => {
    const f = analyzeSource(
      `const executeSpy = spyOn(fakeClient, "executeCommand").mockImplementation(() => {});\n` +
        `AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n` +
        `executeSpy.mockRestore();\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restoredBySpy]).toEqual([]);
    expect(leaksOf("unrelated.ts", f)).toEqual([
      "unrelated.ts: installs AndroidCtrlProxyClient.getInstance but never restores it",
    ]);
  });

  test("THREAD 3: mockRestore on the getInstance spy handle acquits that symbol", () => {
    const f = analyzeSource(
      `const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({} as never);\n` +
        `AndroidCtrlProxyClient.getInstance = getInstanceSpy;\n` +
        `getInstanceSpy.mockRestore();\n`,
    );
    expect([...f.installs]).toEqual(["AndroidCtrlProxyClient"]);
    expect([...f.restoredBySpy]).toEqual(["AndroidCtrlProxyClient"]);
    expect(leaksOf("spy.ts", f)).toEqual([]);
  });

  test("an assignment that only appears in a comment is not counted", () => {
    const f = analyzeSource(
      `// AndroidCtrlProxyClient.getInstance = mock(() => ({}));\n` +
        `/* IOSCtrlProxyClient.getInstance = mock(() => ({})); */\n` +
        `const x = 1;\n`,
    );
    expect([...f.installs]).toEqual([]);
    expect([...f.restores]).toEqual([]);
  });

  test("a getInstance mention inside a string literal is not an assignment", () => {
    const f = analyzeSource(
      `const doc = "AndroidCtrlProxyClient.getInstance = mock(() => ({}))";\n`,
    );
    expect([...f.installs]).toEqual([]);
    expect([...f.restores]).toEqual([]);
  });
});
