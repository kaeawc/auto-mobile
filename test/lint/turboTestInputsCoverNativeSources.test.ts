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
  ] as const;

  interface TurboConfig {
    readonly tasks: Record<string, { readonly inputs?: readonly string[]; readonly description?: string }>;
  }

  function loadTurbo(): TurboConfig {
    return JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as TurboConfig;
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
          const rel = abs.slice(ROOT.length + 1);
          // Skip this guard itself: its REQUIRED_NATIVE_GLOBS and
          // NOT_READ_EXEMPTIONS literals would otherwise make every entry
          // trivially "referenced" by its own definition, so the stale-exemption
          // and coverage checks below would be self-satisfying and never bite.
          if (rel === GUARD_PATH) {
            continue;
          }
          const source = readFileSync(abs, "utf8");
          for (const match of source.matchAll(/(?<![A-Za-z0-9_.-])(android|ios)\/[A-Za-z0-9._/-]+/g)) {
            const path = match[0].replace(/\/+$/, "");
            // SwiftPM's generated output can exist after a local native build
            // but is never a source input for a TypeScript unit test.
            if (path.split("/").includes(".build")) {
              continue;
            }
            if (!existsSync(join(ROOT, path))) {
              continue;
            }
            if (!found.has(path)) {
              found.set(path, new Set());
            }
            found.get(path)!.add(rel);
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
    ["ios/screen-capture/.build/debug/screen-capture-helper", "generated CI fixture path asserted from workflow-YAML; the test never reads the helper binary"],
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

  test("no not-read exemption is stale", () => {
    const referenced = referencedNativePaths();
    const stale = [...NOT_READ_EXEMPTIONS.keys()].filter(path => !referenced.has(path));
    expect(stale, `NOT_READ_EXEMPTIONS entries no longer referenced by any test — prune them: ${stale.join(", ")}`).toEqual([]);
  });
});
