import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  const CACHED_TASKS = ["test", "test:coverage"] as const;

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
    // The same parity suite also parses the drag-threshold constants
    // (MIN_SWIPE_DISTANCE_PX / MAX_COVERED_NATIVE_SCALE / IOS_TOUCH_SLOP_POINTS)
    // out of DeviceDragGesturePolicy.kt and asserts the bound matches the golden
    // fixture's largest device scale (issue #4550). Without this input a
    // Kotlin-only edit to those constants would leave the turbo hash unchanged,
    // so CI would replay a cached green Bun result and never re-run the check.
    "android/desktop-domain/src/main/kotlin/**",
  ] as const;

  interface TurboConfig {
    readonly tasks: Record<string, { readonly inputs?: readonly string[]; readonly description?: string }>;
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

  for (const taskName of CACHED_TASKS) {
    describe(`tasks.${taskName}.inputs`, () => {
      test("declares every native source tree a guard reads", () => {
        const inputs = loadTurbo().tasks[taskName]?.inputs ?? [];
        const missing = REQUIRED_NATIVE_GLOBS.filter(glob => !inputs.includes(glob));
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
          for (const match of source.matchAll(/(?<![A-Za-z0-9_.-])(android|ios)\/[A-Za-z0-9._/-]+/g)) {
            record(match[0].replace(/\/+$/, ""));
          }
          // ALSO reconstruct `join(..., "android", "desktop-core", ...)`-style
          // segmented paths: the golden-vector parity guards build their Kotlin/
          // Swift read targets this way, which the literal regex above cannot
          // see — exactly how the coordinate-mapping guard's cross-tree read
          // initially slipped past this lint (issue #4547 follow-up). Single-
          // segment reconstructions ("ios" alone) are skipped: they are always
          // temp-dir fixtures or prose, and the bare repo dir is never a read.
          // Known regex miss cases (nested calls in join args, template
          // literals, computed segments) are tracked in #4568 (AST promotion);
          // REQUIRED_NATIVE_GLOBS still enforces every declared read meanwhile.
          for (const call of source.matchAll(/\bjoin\(([^)]*)\)/gs)) {
            const literals = [...call[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
            const start = literals.findIndex(l => l === "android" || l === "ios");
            if (start >= 0 && literals.length - start >= 2) {
              record(literals.slice(start).join("/"));
            }
          }
        }
      }
    };
    walk(join(ROOT, "test"));
    return found;
  }

  /** Prefixes a declared glob matches, i.e. `foo/bar/**` covers `foo/bar` and below. */
  function coveredBy(inputs: readonly string[], path: string): boolean {
    return inputs.some(glob => {
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
    ["android/video-server", "bare dir named in a comment / workflow-YAML string; the kotlin tree under it is a declared input"],
    ["ios/control-proxy", "bare dir in a `cd ios/control-proxy && swift test` doc line; Sources/ under it is a declared input"],
    ["ios/screen-capture", "named only inside the workflow-YAML text asserted by webrtcDeviceIntegrationWorkflow.test.ts"],
    ["ios/control-proxy/project.yml", "xcodegen drift check creates a required spec copy in a temp repo"],
    ["ios/control-proxy/CtrlProxy.xcodeproj", "xcodegen drift check rebuilds a copy in a temp dir; the tracked pbxproj is not a test cache input"],
    ["ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj", "same xcodegen drift fixture, copied into a temp repo"],
  ]);

  test("every native path a test references is a declared input or a documented not-read exemption", () => {
    const inputs = loadTurbo().tasks.test?.inputs ?? [];
    const referenced = referencedNativePaths();
    const uncovered = [...referenced.entries()]
      .filter(([path]) => !coveredBy(inputs, path) && !NOT_READ_EXEMPTIONS.has(path))
      .map(([path, tests]) => `${path} (referenced by ${[...tests].join(", ")})`);
    expect(
      uncovered,
      `Native paths referenced by tests but neither a declared test input nor exempted:\n${uncovered.join("\n")}\n` +
        `Add a narrow glob to REQUIRED_NATIVE_GLOBS (and turbo.json) if a test reads it, or a NOT_READ_EXEMPTIONS entry if it does not.`
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
    for (const [path, tests] of referencedNativePaths()) {
      expect([...tests], `${path} attributed to the scanner itself`).not.toContain(GUARD_PATH);
    }
  });

  test("no not-read exemption is stale", () => {
    const referenced = referencedNativePaths();
    const stale = [...NOT_READ_EXEMPTIONS.keys()].filter(path => !referenced.has(path));
    expect(stale, `NOT_READ_EXEMPTIONS entries no longer referenced by any test — prune them: ${stale.join(", ")}`).toEqual([]);
  });
});
