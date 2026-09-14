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
 * implementation MUST also RESTORE that same symbol somewhere in the file, and
 * the file must appear in the inventory below. A new installer — a new file, or
 * a new symbol in a listed file — fails here until it is both restored and
 * inventoried. The count of installs is intentionally NOT pinned (suites add
 * per-test mocks freely); only "installs ⇒ a restore exists for that symbol" is.
 *
 * It cannot prove a restore is CORRECT (the #7052 file had a restore that saved
 * the wrong value); the real fix for that lives in the suite. What it does
 * guarantee is that the "installed but never restored" class — the simplest and
 * most common way to leak this seam — cannot be introduced silently.
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
  type Symbol = (typeof SYMBOLS)[number];

  /**
   * A cheap raw-byte prefilter: only files that mention `CtrlProxy` at all pay
   * for comment stripping and scanning, which keeps this inside the 100ms budget.
   */
  const PREFILTER = "CtrlProxy";

  // This guard's own file, excluded from the scan: its example snippets live in
  // string literals the comment-blanker cannot neutralize.
  const SELF = "test/lint/ctrlProxyGetInstanceRestore.test.ts";

  /**
   * Matches an assignment to `<Symbol>.getInstance`, tolerating an `as any`
   * cast and its parenthesis (`(AndroidCtrlProxyClient as any).getInstance =`),
   * and captures the symbol and the first non-space character of the RHS. A
   * single `=` only — `getInstanceSpy = spyOn(...)` and `===` comparisons never
   * match because they are not `<Symbol>.getInstance =`.
   */
  const ASSIGN =
    /(AndroidCtrlProxyClient|IOSCtrlProxyClient|AndroidCtrlProxyManager|IOSCtrlProxyManager)(?:\s+as\s+\w+)?\s*\)?\s*\.getInstance\s*=\s*([^=\s])/g;

  /**
   * An INSTALL replaces the seam with a fresh implementation; a RESTORE assigns
   * back a previously-captured original (a bare identifier such as
   * `originalGetInstance` / `origClient`). Installs here always begin with
   * `mock(`, an arrow `(`, `async`, or `function`; a restore begins with an
   * identifier character that is not one of those. `.mockRestore()` is also a
   * restore, matched separately below.
   */
  function isInstallRhs(firstChar: string, rest: string): boolean {
    const rhs = firstChar + rest;
    return /^(mock\b|\(|async\b|function\b)/.test(rhs);
  }

  interface FileFacts {
    readonly installs: ReadonlySet<Symbol>;
    readonly restores: ReadonlySet<Symbol>;
    /** True if the file calls `.mockRestore()` at least once (a blanket restore). */
    readonly hasMockRestore: boolean;
  }

  /**
   * Blank every comment's characters (newlines preserved) so a symbol named in
   * prose or in commented-out code is not counted, while every byte offset — and
   * so every regex position — is unchanged. The TypeScript scanner is used
   * rather than a comment-stripping regex so that a `//` inside a string literal
   * is not mistaken for a comment.
   */
  function blankComments(source: string): string {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      /* skipTrivia */ false,
      ts.LanguageVariant.Standard,
      source,
    );
    const out = source.split("");
    let offset = 0;
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      const text = scanner.getTokenText();
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        for (let index = offset; index < offset + text.length; index += 1) {
          if (out[index] !== "\n" && out[index] !== "\r") {
            out[index] = " ";
          }
        }
      }
      offset += text.length;
    }
    return out.join("");
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
      // Skip this guard's own source: it contains example CtrlProxy.getInstance
      // assignments in string literals (not comments) that are not real seams.
      if (relPath === SELF) {
        continue;
      }
      const source = blankComments(readFileSync(file, "utf8"));
      const installs = new Set<Symbol>();
      const restores = new Set<Symbol>();
      for (let m = ASSIGN.exec(source); m !== null; m = ASSIGN.exec(source)) {
        const symbol = m[1] as Symbol;
        const rest = source.slice(m.index + m[0].length, m.index + m[0].length + 8);
        if (isInstallRhs(m[2], rest)) {
          installs.add(symbol);
        } else {
          restores.add(symbol);
        }
      }
      ASSIGN.lastIndex = 0;
      if (installs.size > 0 || restores.size > 0) {
        facts.set(relPath, {
          installs,
          restores,
          hasMockRestore: /\.mockRestore\s*\(/.test(source),
        });
      }
    }
    cached = facts;
    return facts;
  }

  /**
   * The inventory of test files that install a CtrlProxy `getInstance` mock.
   * Presence here is the whole assertion — a file is listed once and only its
   * "every install is restored" obligation (below) is enforced, so the list does
   * not churn as suites add or drop individual per-test mocks. Add a new file
   * here only after confirming its teardown restores every symbol it installs.
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
      if (f.hasMockRestore) {
        // A `.mockRestore()` (paired with spyOn) restores whatever it wrapped;
        // treat the file as restoring every symbol it installs.
        continue;
      }
      for (const symbol of f.installs) {
        if (!f.restores.has(symbol)) {
          leaks.push(`${file}: installs ${symbol}.getInstance but never restores it`);
        }
      }
    }
    expect(leaks.sort()).toEqual([]);
  });

  test("the install/restore classifier splits the two assignment shapes", () => {
    // Fresh implementations are installs; a bare captured identifier is a restore.
    expect(isInstallRhs("m", "ock(() => ({}))")).toBe(true);
    expect(isInstallRhs("(", "() => ({}))")).toBe(true);
    expect(isInstallRhs("a", "sync () => ({})")).toBe(true);
    expect(isInstallRhs("o", "riginalGetInstance;")).toBe(false);
    expect(isInstallRhs("o", "rigClient;")).toBe(false);
  });

  test("the scanner ignores an assignment that only appears in a comment", () => {
    // A commented-out install must not be counted, or a doc example would trip
    // the inventory. Offsets are preserved so the real matcher still runs.
    const blanked = blankComments(
      "// AndroidCtrlProxyClient.getInstance = mock(() => ({}));\nconst x = 1;",
    );
    ASSIGN.lastIndex = 0;
    expect(ASSIGN.exec(blanked)).toBeNull();
    ASSIGN.lastIndex = 0;
  });
});
