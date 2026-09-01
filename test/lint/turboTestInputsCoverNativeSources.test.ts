import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * `turbo run test` cache-key guard (issue #4351).
 *
 * The Bun test suite includes source-scan meta-tests that read Kotlin/Swift
 * files straight off disk — cross-language contract guards that no `import` can
 * reach (`registrationTeardownGuard`, `ctrlProxyProtocol`, `ctrlProxyWireParity`,
 * `webrtcDeviceCaptureLatency`). CI restores `.turbo` across runs and replays a
 * cached `test` result whenever none of `tasks.test.inputs` changed
 * (`.github/workflows/pull_request.yml`). Those native trees are NOT under any
 * declared input, so a PR that changes only Kotlin/Swift hits the cache and the
 * guards never run — the exact drift they exist to catch ships silently.
 *
 * This guard makes the coupling explicit and self-policing:
 *
 *  1. Every native source tree a test reads is a declared `inputs` glob on both
 *     the `test` and `test:coverage` tasks, so touching it busts the cache.
 *  2. `turbo.json` itself is an input of both, so editing one task's input list
 *     can never leave the other replaying a stale hash.
 *  3. Each task's `description` names this file, so the "why is a directory no TS
 *     test imports in the input list" note cannot be dropped in a later cleanup.
 *  4. Any `android/`/`ios/` path literal a test references that exists on disk is
 *     either covered by a declared glob OR carries a one-line not-read exemption
 *     here — so a future guard that starts reading a new native dir fails HERE
 *     instead of going quietly stale.
 */
describe("turbo test inputs cover native sources a guard reads (issue #4351)", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const GUARD_PATH = "test/lint/turboTestInputsCoverNativeSources.test.ts";
  const CACHED_TASKS = ["test", "test:unit", "test:coverage"] as const;

  /**
   * Native trees that a TS test reads off disk. Each must gate both cached tasks
   * so a change there busts the cache. Keep these narrow (per-module
   * `src/main/kotlin` / `Sources`) — widening to `android/**` would invalidate
   * the whole TS test cache on unrelated Gradle/AGP/doc churn (issue #4351
   * non-goal).
   */
  const REQUIRED_NATIVE_GLOBS = [
    // registrationTeardownGuard.test.ts walks these four for listener leaks.
    "android/auto-mobile-sdk/src/main/kotlin/**",
    "android/control-proxy/src/main/kotlin/**",
    "ios/auto-mobile-sdk/Sources/**",
    "ios/control-proxy/Sources/**",
    // ctrlProxyProtocol.test.ts reads the @SerialName set from this tree.
    "android/protocol/src/main/kotlin/**",
    // webrtcDeviceCaptureLatency.test.ts mirrors QualityPreset.MEDIUM.fps.
    "android/video-server/src/main/kotlin/**",
    // pinchGoldenVectorParity.test.ts parses the inline golden tables out of
    // PinchGeometryTest.kt / PinchGeometryTests.swift (issue #2997).
    "android/control-proxy/src/test/kotlin/**",
    "ios/control-proxy/Tests/**",
    // coordinateMappingGoldenVectorParity.test.ts parses the inline golden
    // tables out of CoordinateMappingGoldenVectorTest.kt (issue #4547).
    "android/desktop-core/src/test/kotlin/**",
  ] as const;

  interface TurboConfig {
    readonly tasks: Record<
      string,
      {
        readonly inputs?: readonly string[];
        readonly description?: string;
        readonly env?: readonly string[];
      }
    >;
  }

  function loadTurbo(): TurboConfig {
    return JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as TurboConfig;
  }

  /**
   * Repo-relative form of an absolute path, ALWAYS forward-slashed (#4367 hazard class: Windows
   * `path.join` produces backslashed absolutes, and every comparison downstream — the owner-file
   * exclusion, glob coverage, exemption keys, reporting — is forward-slash-sensitive). Without
   * this single choke-point normalization the owner exclusion fails on Windows, the scanner reads
   * its own source, and the join-segment example in the scan's comment self-flags as a referenced
   * native path.
   */
  function repoRelative(abs: string): string {
    return abs.slice(ROOT.length + 1).replace(/\\/g, "/");
  }

  function nativePathCandidates(source: string): string[] {
    const paths = new Set<string>();
    const sourceFile = ts.createSourceFile(
      "native-path-scan.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    interface ConstBinding {
      readonly declaration: ts.VariableDeclaration;
      readonly scope: ts.Node;
    }
    const bindings = new Map<string, ConstBinding[]>();

    const isPathCharacter = (character: string): boolean => {
      const code = character.charCodeAt(0);
      return (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        character === "." ||
        character === "_" ||
        character === "-" ||
        character === "/"
      );
    };

    const isIdentifierCharacter = (character: string): boolean =>
      character !== "/" && isPathCharacter(character);

    const nativeRootInText = (text: string): string | undefined => {
      const normalized = text.replaceAll("\\", "/");
      for (const root of ["android/", "ios/"]) {
        let index = normalized.indexOf(root);
        while (index >= 0) {
          const previous = normalized[index - 1];
          if (previous === undefined || !isIdentifierCharacter(previous)) {
            return root.slice(0, -1);
          }
          index = normalized.indexOf(root, index + root.length);
        }
      }
      return undefined;
    };

    const hasNativePathInText = (text: string): boolean => {
      const normalized = text.replaceAll("\\", "/");
      for (const root of ["android/", "ios/"]) {
        let index = normalized.indexOf(root);
        while (index >= 0) {
          const previous = normalized[index - 1];
          const next = normalized[index + root.length];
          if (
            (previous === undefined || !isIdentifierCharacter(previous)) &&
            next !== undefined &&
            next !== "/" &&
            isPathCharacter(next)
          ) {
            return true;
          }
          index = normalized.indexOf(root, index + root.length);
        }
      }
      return false;
    };

    const nativeRootInUnresolvedTemplate = (node: ts.Expression): string | undefined => {
      if (!ts.isTemplateExpression(node)) {
        return undefined;
      }
      const texts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      if (texts.some(hasNativePathInText)) {
        return undefined;
      }
      return texts.map(nativeRootInText).find(Boolean);
    };

    const addPathsFromText = (text: string): void => {
      const normalized = text.replaceAll("\\", "/");
      for (const root of ["android/", "ios/"]) {
        let index = normalized.indexOf(root);
        while (index >= 0) {
          const previous = normalized[index - 1];
          if (previous === undefined || !isIdentifierCharacter(previous)) {
            let end = index + root.length;
            while (end < normalized.length && isPathCharacter(normalized[end])) {
              end += 1;
            }
            let path = normalized.slice(index, end);
            while (path.endsWith("/")) {
              path = path.slice(0, -1);
            }
            if (path !== root.slice(0, -1)) {
              paths.add(path);
            }
          }
          index = normalized.indexOf(root, index + root.length);
        }
      }
    };

    const lexicalScope = (node: ts.Node): ts.Node => {
      for (let current = node.parent; current; current = current.parent) {
        if (
          ts.isSourceFile(current) ||
          ts.isBlock(current) ||
          ts.isModuleBlock(current) ||
          ts.isCaseBlock(current)
        ) {
          return current;
        }
      }
      return sourceFile;
    };

    const collectBindings = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        const entries = bindings.get(node.name.text) ?? [];
        entries.push({ declaration: node, scope: lexicalScope(node) });
        bindings.set(node.name.text, entries);
      }
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(sourceFile);

    const isJoinCall = (node: ts.CallExpression): boolean =>
      (ts.isIdentifier(node.expression) && node.expression.text === "join") ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join");

    const bindingFor = (node: ts.Identifier): ConstBinding | undefined => {
      const position = node.getStart(sourceFile);
      return (bindings.get(node.text) ?? [])
        .filter(
          (binding) =>
            binding.scope.pos <= position &&
            position < binding.scope.end &&
            binding.declaration.getStart(sourceFile) < position,
        )
        .sort(
          (left, right) =>
            left.scope.end - left.scope.pos - (right.scope.end - right.scope.pos) ||
            right.declaration.getStart(sourceFile) - left.declaration.getStart(sourceFile),
        )[0];
    };

    const resolveStaticText = (
      node: ts.Expression,
      resolving = new Set<ts.VariableDeclaration>(),
    ): string | undefined => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
      }
      if (ts.isParenthesizedExpression(node)) {
        return resolveStaticText(node.expression, resolving);
      }
      if (ts.isTemplateExpression(node)) {
        let text = node.head.text;
        for (const span of node.templateSpans) {
          const expression = resolveStaticText(span.expression, resolving);
          if (expression === undefined) {
            return undefined;
          }
          text += expression + span.literal.text;
        }
        return text;
      }
      if (ts.isCallExpression(node) && isJoinCall(node)) {
        const segments = node.arguments.map((argument) => resolveStaticText(argument, resolving));
        return segments.every((segment): segment is string => segment !== undefined)
          ? segments.join("/")
          : undefined;
      }
      if (ts.isIdentifier(node)) {
        const binding = bindingFor(node);
        if (binding && !resolving.has(binding.declaration)) {
          const nested = new Set(resolving);
          nested.add(binding.declaration);
          return resolveStaticText(binding.declaration.initializer!, nested);
        }
      }
      return undefined;
    };

    const stringLeaves = (node: ts.Expression): string[] => {
      const resolved = resolveStaticText(node);
      if (resolved !== undefined) {
        return [resolved];
      }
      if (ts.isCallExpression(node)) {
        return node.arguments.flatMap(stringLeaves);
      }
      return [];
    };

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        addPathsFromText(node.text);
      } else if (ts.isTemplateExpression(node)) {
        const resolved = resolveStaticText(node);
        if (resolved !== undefined) {
          addPathsFromText(resolved);
        } else {
          addPathsFromText(node.head.text);
          for (const span of node.templateSpans) {
            addPathsFromText(span.literal.text);
          }
          const nativeRoot = nativeRootInUnresolvedTemplate(node);
          if (nativeRoot) {
            paths.add(nativeRoot);
          }
        }
      } else if (
        ts.isCallExpression(node) &&
        isJoinCall(node) &&
        !(ts.isCallExpression(node.parent) && isJoinCall(node.parent))
      ) {
        const segments = node.arguments.map((argument) => {
          const leaves = stringLeaves(argument);
          return leaves.length === 1 ? leaves[0] : undefined;
        });
        const start = segments.findIndex(
          (segment) =>
            segment === "android" ||
            segment === "ios" ||
            segment?.startsWith("android/") ||
            segment?.startsWith("ios/"),
        );
        const unresolvedTemplateRoot = node.arguments
          .filter((_, index) => segments[index] === undefined)
          .map(nativeRootInUnresolvedTemplate)
          .find(Boolean);
        if (start < 0 && unresolvedTemplateRoot) {
          paths.add(unresolvedTemplateRoot);
        } else if (start >= 0 && segments.length - start >= 2) {
          const nativeSegments = segments.slice(start);
          if (nativeSegments.every((segment): segment is string => segment !== undefined)) {
            addPathsFromText(nativeSegments.join("/"));
          } else {
            // An unresolved segment must not disappear and shorten the candidate
            // to a potentially unrelated existing parent path. Treating the
            // native root as a candidate keeps the cache-input guard fail-closed.
            paths.add(segments[start]!);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      source,
    );
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        addPathsFromText(scanner.getTokenText());
      }
    }

    return [...paths];
  }

  for (const taskName of CACHED_TASKS) {
    describe(`tasks.${taskName}.inputs`, () => {
      test("declares every native source tree a guard reads", () => {
        const inputs = loadTurbo().tasks[taskName]?.inputs ?? [];
        const missing = REQUIRED_NATIVE_GLOBS.filter((glob) => !inputs.includes(glob));
        expect(missing, `tasks.${taskName}.inputs is missing: ${missing.join(", ")}`).toEqual([]);
      });

      test("includes turbo.json so editing the other task's inputs busts this hash", () => {
        const inputs = loadTurbo().tasks[taskName]?.inputs ?? [];
        expect(inputs).toContain("turbo.json");
      });

      test("description points at this guard so the native-input note is not cleaned up later", () => {
        const description = loadTurbo().tasks[taskName]?.description ?? "";
        expect(description).toContain(GUARD_PATH);
      });
    });
  }

  test("test tasks forward runner controls through Turbo strict env mode", () => {
    const tasks = loadTurbo().tasks;
    const expectedByTask = {
      test: ["AUTOMOBILE_UNIT_TEST_WORKERS"],
      "test:unit": ["AUTOMOBILE_UNIT_TEST_WORKERS"],
      "test:changed": ["AUTOMOBILE_UNIT_TEST_WORKERS"],
      "test:integration": ["AUTOMOBILE_INTEGRATION_TEST_WORKERS"],
      "test:stress": [],
      "test:all": ["AUTOMOBILE_UNIT_TEST_WORKERS", "AUTOMOBILE_INTEGRATION_TEST_WORKERS"],
      "test:coverage": ["AUTOMOBILE_UNIT_TEST_WORKERS"],
    } as const;

    for (const [taskName, workerControls] of Object.entries(expectedByTask)) {
      const env = tasks[taskName]?.env ?? [];
      expect(env, taskName).toEqual(
        expect.arrayContaining([
          "AUTOMOBILE_TEST_TIMEOUT_MS",
          "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS",
          ...workerControls,
        ]),
      );
    }
  });

  test("integration caching includes scripts and workflows its tests read from disk", () => {
    const inputs = loadTurbo().tasks["test:integration"]?.inputs ?? [];

    expect(inputs).toEqual(
      expect.arrayContaining(["scripts/**", ".github/workflows/**", "turbo.json"]),
    );
  });

  /**
   * `android/`/`ios/` path literals referenced by any test that resolve to a real
   * file or directory on disk. Comment or docstring mentions count too — the
   * point is to notice a native path entering the test tree, not to prove it is
   * a live `readFileSync` target.
   */
  function referencedNativePaths(): Map<string, Set<string>> {
    const found = new Map<string, Set<string>>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.name.endsWith(".ts")) {
          const rel = repoRelative(abs);
          // Skip this guard itself: its REQUIRED_NATIVE_GLOBS and
          // NOT_READ_EXEMPTIONS literals would otherwise make every entry
          // trivially "referenced" by its own definition, so the stale-exemption
          // and coverage checks below would be self-satisfying and never bite.
          if (rel === GUARD_PATH) {
            continue;
          }
          const source = readFileSync(abs, "utf8");
          const record = (path: string): void => {
            // SwiftPM's `.build` and Gradle's `build` outputs can exist after a
            // local native build but are never source inputs for a TS unit test.
            const segments = path.split("/");
            if (segments.includes(".build") || segments.includes("build")) {
              return;
            }
            if (!existsSync(join(ROOT, path))) {
              return;
            }
            if (!found.has(path)) {
              found.set(path, new Set());
            }
            found.get(path)!.add(rel);
          };
          for (const path of nativePathCandidates(source)) {
            record(path);
          }
        }
      }
    };
    walk(join(ROOT, "test"));
    return found;
  }

  test("finds a native path nested inside a join argument", () => {
    const source = 'join(ROOT, dirFor("android"), "control-proxy", "src", "main", "kotlin");';
    expect(nativePathCandidates(source)).toContain("android/control-proxy/src/main/kotlin");
  });

  test("finds a native path in a property-access join call", () => {
    const source = 'path.join(ROOT, "android", "control-proxy", "src", "main", "kotlin");';
    expect(nativePathCandidates(source)).toContain("android/control-proxy/src/main/kotlin");
  });

  test("resolves nested join calls without reporting their partial parent path", () => {
    const source = 'join(ROOT, join("android", "desktop-core"), "src", "test", "kotlin");';
    expect(nativePathCandidates(source)).toContain("android/desktop-core/src/test/kotlin");
    expect(nativePathCandidates(source)).not.toContain("android/desktop-core");
  });

  test("finds native paths formed by template literals", () => {
    const source = [
      "join(ROOT, `android`, `desktop-core`, `src`, `test`, `kotlin`);",
      "const path = `${ROOT}/ios/control-proxy/Sources`;",
    ].join("\n");
    expect(nativePathCandidates(source)).toEqual(
      expect.arrayContaining(["android/desktop-core/src/test/kotlin", "ios/control-proxy/Sources"]),
    );
  });

  test("resolves a template literal with a constant interpolation", () => {
    const source = [
      'const moduleName = "control-proxy";',
      "const target = `android/${moduleName}/src/main/kotlin`;",
    ].join("\n");
    expect(nativePathCandidates(source)).toContain("android/control-proxy/src/main/kotlin");
  });

  test("resolves a constant computed join segment", () => {
    const source = [
      'const moduleName = "desktop-core";',
      'join(ROOT, "android", moduleName, "src", "test", "kotlin");',
    ].join("\n");
    expect(nativePathCandidates(source)).toContain("android/desktop-core/src/test/kotlin");
  });

  test("does not resolve a mutable join segment as static", () => {
    const source = [
      'let moduleName = "desktop-core";',
      'join(ROOT, "android", moduleName, "src", "test", "kotlin");',
    ].join("\n");
    expect(nativePathCandidates(source)).toContain("android");
    expect(nativePathCandidates(source)).not.toContain("android/desktop-core/src/test/kotlin");
  });

  test("resolves a constant join segment in its lexical scope", () => {
    const source = [
      "{",
      '  const moduleName = "control-proxy";',
      '  join(ROOT, "android", moduleName, "src", "main", "kotlin");',
      "}",
      'const moduleName = "desktop-core";',
    ].join("\n");
    expect(nativePathCandidates(source)).toContain("android/control-proxy/src/main/kotlin");
  });

  test("keeps an unresolved native join segment from shortening the candidate path", () => {
    const source = 'join(ROOT, "android", moduleName, "src", "test", "kotlin");';
    expect(nativePathCandidates(source)).toContain("android");
    expect(nativePathCandidates(source)).not.toContain("android/src/test/kotlin");
  });

  test("keeps an unresolved native template join segment from disappearing", () => {
    const source = "join(ROOT, `android/${moduleName}/src/main/kotlin`);";
    expect(nativePathCandidates(source)).toContain("android");
  });

  test("normalizes Windows separators in literals and comments", () => {
    const source = String.raw`
      const target = "android\\control-proxy\\src\\main\\kotlin";
      // ios\control-proxy\Sources
    `;
    expect(nativePathCandidates(source)).toEqual(
      expect.arrayContaining([
        "android/control-proxy/src/main/kotlin",
        "ios/control-proxy/Sources",
      ]),
    );
  });

  /** Prefixes a declared glob matches, i.e. `foo/bar/**` covers `foo/bar` and below. */
  function coveredBy(inputs: readonly string[], path: string): boolean {
    return inputs.some((glob) => {
      const prefix = glob.replace(/\/\*\*$/, "");
      return path === prefix || path.startsWith(`${prefix}/`);
    });
  }

  /**
   * Native paths a test references but deliberately does NOT read as a cache
   * input — bare parent dirs mentioned in prose, xcodegen fixtures rebuilt in a
   * temp dir, workflow-YAML string contents. Each stays honest: the guard fails
   * if an entry is no longer referenced (prune it) so this cannot rot into a
   * blanket allow-list.
   */
  const NOT_READ_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
    [
      "android/video-server",
      "bare dir named in a comment / workflow-YAML string; the kotlin tree under it is a declared input",
    ],
    [
      "ios/control-proxy",
      "bare dir in a `cd ios/control-proxy && swift test` doc line; Sources/ under it is a declared input",
    ],
    [
      "ios/screen-capture",
      "named only inside the workflow-YAML text asserted by webrtcDeviceIntegrationWorkflow.test.ts",
    ],
    [
      "ios/control-proxy/project.yml",
      "xcodegen drift check creates a required spec copy in a temp repo",
    ],
    [
      "ios/control-proxy/CtrlProxy.xcodeproj",
      "xcodegen drift check rebuilds a copy in a temp dir; the tracked pbxproj is not a test cache input",
    ],
    [
      "ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj",
      "same xcodegen drift fixture, copied into a temp repo",
    ],
    [
      "ios/XCTestRunner/Sources/XCTestRunnerTests/Resources/Plans/launch-reminders-app.yaml",
      "plan contract reads a YAML fixture; no native source tree is read",
    ],
  ]);
  // One immutable scan feeds all assertions. Keeping repository I/O out of
  // individual test bodies preserves the unit timing contract.
  const referencedNativePathsSnapshot = referencedNativePaths();

  test("every native path a test references is a declared input or a documented not-read exemption", () => {
    const inputs = loadTurbo().tasks.test?.inputs ?? [];
    const uncovered = [...referencedNativePathsSnapshot.entries()]
      .filter(([path]) => !coveredBy(inputs, path) && !NOT_READ_EXEMPTIONS.has(path))
      .map(([path, tests]) => `${path} (referenced by ${[...tests].join(", ")})`);
    expect(
      uncovered,
      `Native paths referenced by tests but neither a declared test input nor exempted:\n${uncovered.join("\n")}\n` +
        `Add a narrow glob to REQUIRED_NATIVE_GLOBS (and turbo.json) if a test reads it, or a NOT_READ_EXEMPTIONS entry if it does not.`,
    ).toEqual([]);
  });

  test("#4367 hazard: a win32 backslashed absolute normalizes to the forward-slash owner path", () => {
    // Deterministic reproduction of the Windows CI failure shape: path.join on win32 yields
    // `ROOT\test\lint\...`, and without normalization `rel === GUARD_PATH` is false, so the
    // scanner reads its own source and self-flags the join-segment example in its comments.
    const winAbs = `${ROOT}\\test\\lint\\turboTestInputsCoverNativeSources.test.ts`;
    expect(repoRelative(winAbs)).toBe(GUARD_PATH);
  });

  test("the scan never attributes a native path to its own owner file", () => {
    // Belt to the normalization above: whatever the platform separator, the owner exclusion must
    // hold — the guard's own comments deliberately contain scan-pattern examples.
    for (const [path, tests] of referencedNativePathsSnapshot) {
      expect([...tests], `${path} attributed to the scanner itself`).not.toContain(GUARD_PATH);
    }
  });

  test("no not-read exemption is stale", () => {
    const stale = [...NOT_READ_EXEMPTIONS.keys()].filter(
      (path) => !referencedNativePathsSnapshot.has(path),
    );
    expect(
      stale,
      `NOT_READ_EXEMPTIONS entries no longer referenced by any test — prune them: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
