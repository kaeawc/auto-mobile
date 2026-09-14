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
    /**
     * Symbols acquitted by a `.mockRestore()` on the handle that
     * `spyOn(<Symbol>, "getInstance")` returned — the only `.mockRestore()` that
     * actually restores this seam.
     */
    readonly restoredBySpy: ReadonlySet<CtrlProxySymbol>;
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

  /** The CtrlProxy symbol an expression names directly (after unwrapping), if any. */
  function symbolOf(
    node: ts.Expression,
    symbolAliases: ReadonlyMap<string, CtrlProxySymbol>,
  ): CtrlProxySymbol | undefined {
    const core = unwrap(node);
    if (ts.isIdentifier(core)) {
      return (
        symbolAliases.get(core.text) ??
        (SYMBOL_SET.has(core.text) ? (core.text as CtrlProxySymbol) : undefined)
      );
    }
    return undefined;
  }

  /** The `<Symbol>.getInstance` an assignment target names (after unwrapping), if any. */
  function getInstanceTarget(
    node: ts.Expression,
    symbolAliases: ReadonlyMap<string, CtrlProxySymbol>,
  ): CtrlProxySymbol | undefined {
    const core = unwrap(node);
    if (ts.isPropertyAccessExpression(core) && core.name.text === "getInstance") {
      return symbolOf(core.expression, symbolAliases);
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
    symbolAliases: ReadonlyMap<string, CtrlProxySymbol>,
  ): CtrlProxySymbol | undefined {
    return getInstanceTarget(node, symbolAliases);
  }

  /**
   * If an expression is (or chains onto) `spyOn(<Symbol>, "getInstance")`, the
   * symbol it spies. Handles `spyOn(X, "getInstance").mockReturnValue(...)`.
   */
  function spyOnGetInstanceSymbol(
    node: ts.Expression,
    symbolAliases: ReadonlyMap<string, CtrlProxySymbol>,
  ): CtrlProxySymbol | undefined {
    let expr: ts.Expression = unwrap(node);
    for (;;) {
      if (ts.isCallExpression(expr)) {
        const callee = unwrap(expr.expression);
        if (ts.isIdentifier(callee) && callee.text === "spyOn" && expr.arguments.length >= 2) {
          const target = symbolOf(expr.arguments[0], symbolAliases);
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
    const sf = ts.createSourceFile(relPathHint, source, ts.ScriptTarget.Latest, true);
    const symbolAliases = new Map<string, CtrlProxySymbol>();
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
          symbolAliases.set(specifier.name.text, exportedName as CtrlProxySymbol);
        }
      }
    }

    let nextScopeId = 0;
    const scopeIds = new Map<ts.Node, number>();
    const declaredBindings = new Set<string>();
    const scopeChain = (node: ts.Node): ts.Node[] => {
      const scopes: ts.Node[] = [];
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (ts.isBlock(current) || ts.isFunctionLike(current) || ts.isSourceFile(current)) {
          scopes.push(current);
        }
      }
      return scopes;
    };
    const keyForScope = (scope: ts.Node, name: string): string => {
      let id = scopeIds.get(scope);
      if (id === undefined) {
        id = nextScopeId++;
        scopeIds.set(scope, id);
      }
      return `${id}:${name}`;
    };
    const declarationKey = (name: ts.Identifier): string => {
      const [scope] = scopeChain(name);
      return keyForScope(scope, name.text);
    };
    const bindingKeyForReference = (name: ts.Identifier): string | undefined => {
      for (const scope of scopeChain(name)) {
        const key = keyForScope(scope, name.text);
        if (declaredBindings.has(key)) {
          return key;
        }
      }
      return undefined;
    };

    // First pass: learn what every bare identifier was bound to, so a later
    // `Symbol.getInstance = someId` can tell a fresh mock from an original
    // capture, and which locals are `spyOn(<Symbol>, "getInstance")` handles.
    const idIsMock = new Set<string>();
    const idIsOriginalCapture = new Map<string, CtrlProxySymbol>();
    const spyVarSymbol = new Map<string, CtrlProxySymbol>();
    const mockRestoreTargets: ts.Identifier[] = [];

    const learn = (binding: string, init: ts.Expression): void => {
      const spied = spyOnGetInstanceSymbol(init, symbolAliases);
      if (spied !== undefined) {
        spyVarSymbol.set(binding, spied);
      }
      if (isFreshMock(init)) {
        idIsMock.add(binding);
      } else {
        const captured = capturesOriginal(init, symbolAliases);
        if (captured !== undefined) {
          idIsOriginalCapture.set(binding, captured);
        }
      }
    };

    const learnWalk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const binding = declarationKey(node.name);
        declaredBindings.add(binding);
        if (node.initializer) {
          learn(binding, node.initializer);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrap(node.left))
      ) {
        const name = unwrap(node.left) as ts.Identifier;
        const binding = bindingKeyForReference(name) ?? declarationKey(name);
        declaredBindings.add(binding);
        learn(binding, node.right);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "mockRestore"
      ) {
        const receiver = unwrap(node.expression.expression);
        if (ts.isIdentifier(receiver)) {
          mockRestoreTargets.push(receiver);
        }
      }
      ts.forEachChild(node, learnWalk);
    };
    learnWalk(sf);

    const directInstalls = new Set<CtrlProxySymbol>();
    const spyInstalls = new Set<CtrlProxySymbol>();
    const restores = new Set<CtrlProxySymbol>();

    const recordInstall = (symbol: CtrlProxySymbol, rhs: ts.Expression): void => {
      const core = unwrap(rhs);
      const binding = ts.isIdentifier(core) ? bindingKeyForReference(core) : undefined;
      if (
        spyOnGetInstanceSymbol(rhs, symbolAliases) === symbol ||
        (binding !== undefined && spyVarSymbol.get(binding) === symbol)
      ) {
        spyInstalls.add(symbol);
      } else {
        directInstalls.add(symbol);
      }
    };

    const classifyWalk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const symbol = getInstanceTarget(node.left, symbolAliases);
        if (symbol !== undefined) {
          const rhs = node.right;
          const core = unwrap(rhs);
          if (isFreshMock(rhs)) {
            recordInstall(symbol, rhs);
          } else if (ts.isIdentifier(core)) {
            const binding = bindingKeyForReference(core);
            const capturedFrom =
              binding === undefined ? undefined : idIsOriginalCapture.get(binding);
            if (binding !== undefined && idIsMock.has(binding)) {
              recordInstall(symbol, rhs);
            } else if (capturedFrom === symbol) {
              restores.add(symbol);
            } else {
              // Cannot prove this identifier holds this symbol's captured original,
              // so it is not a verifiable restore — treat it as a fresh install.
              recordInstall(symbol, rhs);
            }
          } else {
            // Any other RHS shape is a fresh value, not an original capture.
            recordInstall(symbol, rhs);
          }
        }
      }
      ts.forEachChild(node, classifyWalk);
    };
    classifyWalk(sf);

    const restoredBySpy = new Set<CtrlProxySymbol>();
    for (const target of mockRestoreTargets) {
      const binding = bindingKeyForReference(target);
      const symbol = binding === undefined ? undefined : spyVarSymbol.get(binding);
      if (symbol !== undefined) {
        restoredBySpy.add(symbol);
      }
    }

    const installs = new Set([...directInstalls, ...spyInstalls]);
    return { installs, directInstalls, spyInstalls, restores, restoredBySpy };
  }

  /** Symbols a file installs without any in-file restoration (a leak). */
  function leaksOf(file: string, facts: FileFacts): string[] {
    const leaks: string[] = [];
    for (const symbol of facts.directInstalls) {
      if (!facts.restores.has(symbol)) {
        leaks.push(`${file}: installs ${symbol}.getInstance but never restores it`);
      }
    }
    for (const symbol of facts.spyInstalls) {
      if (!facts.restoredBySpy.has(symbol)) {
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
    "test/features/observe/TakeScreenshot.test.ts",
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
