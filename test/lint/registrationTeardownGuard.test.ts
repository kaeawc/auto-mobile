import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Registration/teardown symmetry guard for the mobile SDK + control-proxy source.
 *
 * Origin: the 2026-07 cross-language bug-hunt shipped fixes for a whole class of
 * "OS listener registered but never torn down" leaks. The canonical instance was
 * the Android network-mock `BroadcastReceiver` (#3599): `registerReceiver` was
 * called on (re)init with no matching `unregisterReceiver`, so every re-init
 * leaked a receiver. The iOS SDK had the mirror shape latent in its
 * `NotificationCenter` / `NWPathMonitor` observers.
 *
 * Static analysis can't reach these files — Kotlin runs no detekt/ktlint here (by
 * project preference) and SwiftLint has no rule for lifecycle symmetry. So this is
 * a source-scan meta-test in the repo's established idiom (cf.
 * `sessionCacheNoEscapeHatch.test.ts`, `errorHandlingConvention.test.ts`): it runs
 * in the fast `bun test` leg — no simulator or emulator — and fails HERE if someone
 * adds a new OS-listener registration without a matching teardown, instead of
 * shipping a latent leak.
 *
 * The invariant is deliberately NOT "every register has an unregister" — it is
 * "register and teardown live in the same file". Today every registration in scope
 * satisfies it. If a future registration is legitimately process-lifetime (a single
 * guarded registration that lives for the whole process does not leak) or is torn
 * down in a sibling lifecycle owner, that PR should add an explicit, justified
 * exception here — rather than paper over the guard with a no-op teardown.
 */
describe("OS-listener registration has a matching teardown (issue #3599 class)", () => {
  const ROOT = join(__dirname, "..", "..");

  interface Pair {
    /** Human label for the OS primitive, used in failure messages. */
    readonly name: string;
    /** Matches a registration call. Must NOT match its own teardown call. */
    readonly register: RegExp;
    /** Matches the teardown call that balances `register`. */
    readonly teardown: RegExp;
  }

  interface Scope {
    readonly lang: "swift" | "kotlin";
    readonly ext: string;
    /** Source roots to walk, relative to repo root. */
    readonly dirs: readonly string[];
    /** File-path substrings that exclude a file from the scan. */
    readonly excludes: readonly string[];
    readonly pairs: readonly Pair[];
  }

  const SCOPES: readonly Scope[] = [
    {
      lang: "swift",
      ext: ".swift",
      dirs: ["ios/auto-mobile-sdk/Sources", "ios/control-proxy/Sources"],
      // Test targets and hand-written fakes register/tear down on their own schedule.
      excludes: ["/Tests/", "Fakes.swift", "Mock", "Fake"],
      pairs: [
        {
          name: "NotificationCenter observer",
          // `.addObserver(` also lexically appears in `.removeObserver(`? No — distinct
          // tokens, so no self-match. KVO `addObserver(_:forKeyPath:)` is intentionally
          // covered too: it leaks the same way and is balanced by `removeObserver`.
          register: /\.addObserver\s*\(/,
          teardown: /\.removeObserver\s*\(/,
        },
        {
          name: "NWPathMonitor",
          // The only file that constructs an `NWPathMonitor` balances it with
          // `.cancel()` on shutdown; a new path monitor without a cancel leaks the
          // network-path callback the same way an unbalanced observer does.
          register: /NWPathMonitor\s*\(/,
          teardown: /\.cancel\s*\(/,
        },
      ],
    },
    {
      lang: "kotlin",
      ext: ".kt",
      dirs: ["android/auto-mobile-sdk/src/main/kotlin", "android/control-proxy/src/main/kotlin"],
      excludes: ["/test/", "/androidTest/"],
      pairs: [
        {
          name: "BroadcastReceiver",
          // `(?<!un)` so `unregisterReceiver(` does not count as a registration.
          register: /(?<!un)registerReceiver\s*\(/,
          teardown: /unregisterReceiver\s*\(/,
        },
        {
          name: "ActivityLifecycleCallbacks",
          register: /(?<!un)registerActivityLifecycleCallbacks\s*\(/,
          teardown: /unregisterActivityLifecycleCallbacks\s*\(/,
        },
      ],
    },
  ];

  function walk(absDir: string, ext: string, excludes: readonly string[]): string[] {
    if (!existsSync(absDir)) {
      return [];
    }
    const out: string[] = [];
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(abs, ext, excludes));
      } else if (entry.name.endsWith(ext) && !excludes.some((x) => abs.includes(x))) {
        out.push(abs);
      }
    }
    return out;
  }

  /** All (repo-relative file, pair) that register the primitive but never tear it down. */
  function unbalanced(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const scope of SCOPES) {
      const files = scope.dirs.flatMap((d) => walk(join(ROOT, d), scope.ext, scope.excludes));
      for (const abs of files) {
        const source = readFileSync(abs, "utf8");
        const rel = relative(ROOT, abs);
        for (const pair of scope.pairs) {
          if (pair.register.test(source) && !pair.teardown.test(source)) {
            if (!result.has(rel)) {
              result.set(rel, new Set());
            }
            result.get(rel)!.add(pair.name);
          }
        }
      }
    }
    return result;
  }

  test("every registration is balanced by a teardown in the same file", () => {
    const offenders: string[] = [];
    for (const [rel, pairs] of unbalanced()) {
      for (const pairName of pairs) {
        offenders.push(
          `${rel} registers a ${pairName} but has no matching teardown in the same file. ` +
            `Add the teardown (e.g. in shutdown()/reset()). If the registration is ` +
            `genuinely process-lifetime, or is torn down in a sibling lifecycle owner, ` +
            `add an explicit, justified exception in this test instead.`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the scan reaches every source root (no vacuous pass from a broken path)", () => {
    // If a dirs/excludes entry ever silently matches nothing, the primary test
    // passes vacuously. Assert every scope root resolves to at least one file so a
    // rename or glob break fails here instead.
    const empty: string[] = [];
    for (const scope of SCOPES) {
      for (const dir of scope.dirs) {
        if (walk(join(ROOT, dir), scope.ext, scope.excludes).length === 0) {
          empty.push(`${dir} (*${scope.ext}) matched no files`);
        }
      }
    }
    expect(empty, empty.join("\n")).toEqual([]);
  });
});
