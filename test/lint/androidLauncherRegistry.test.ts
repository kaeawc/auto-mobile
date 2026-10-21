import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ANDROID_LAUNCHERS,
  ANDROID_LAUNCHER_PACKAGES,
} from "../../src/features/observe/androidLauncherRegistry";

/**
 * One launcher list source (#14056). `schemas/android-launcher-packages.json` is the registry; the
 * TypeScript users import it, and the desktop's Kotlin copy must match it entry for entry.
 */

const root = resolve(import.meta.dir, "../..");
const KOTLIN_COPY = join(
  root,
  "android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/AutoMobileContent.kt",
);

/**
 * The entries that predate the evidence rule. This list only shrinks: an entry gains a captured
 * fixture and leaves it, and a new launcher must arrive with its fixture (#14048 captures).
 */
const LEGACY_ENTRIES = [
  "com.google.android.apps.nexuslauncher",
  "com.android.launcher3",
  "com.sec.android.app.launcher",
  "com.huawei.android.launcher",
  "com.miui.home",
  "com.samsung.android.app.launcher",
  "com.oneplus.launcher",
  "com.android.launcher",
];

/** The string literals of the Kotlin `ANDROID_LAUNCHERS = listOf(...)` declaration. */
function kotlinLaunchers(source: string): string[] {
  const start = source.indexOf("private val ANDROID_LAUNCHERS =");
  if (start < 0) {
    throw new Error("ANDROID_LAUNCHERS declaration not found in AutoMobileContent.kt");
  }
  const end = source.indexOf(")", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("Android launcher registry", () => {
  test("packages are unique Android package names", () => {
    expect(new Set(ANDROID_LAUNCHER_PACKAGES).size).toBe(ANDROID_LAUNCHER_PACKAGES.length);
    for (const name of ANDROID_LAUNCHER_PACKAGES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
    }
  });

  test("every entry is legacy or names a captured fixture that exists", () => {
    const unproven = ANDROID_LAUNCHERS.filter((entry) =>
      entry.evidence === "legacy"
        ? !LEGACY_ENTRIES.includes(entry.packageName)
        : !entry.evidence.startsWith("test/fixtures/") || !existsSync(join(root, entry.evidence)),
    );
    expect(unproven).toEqual([]);
  });

  test("the legacy allowance only shrinks", () => {
    const legacy = ANDROID_LAUNCHERS.filter((entry) => entry.evidence === "legacy");
    expect(LEGACY_ENTRIES.filter((name) => !legacy.some((e) => e.packageName === name))).toEqual(
      [],
    );
  });

  test("the desktop Kotlin copy matches the registry in order", () => {
    expect(kotlinLaunchers(readFileSync(KOTLIN_COPY, "utf8"))).toEqual([
      ...ANDROID_LAUNCHER_PACKAGES,
    ]);
  });

  test("the Kotlin reader finds every literal of a declaration", () => {
    const source =
      'private val ANDROID_LAUNCHERS =\n  listOf(\n    "a.b",\n    "c.d",\n  )\nval x = "e.f"';
    expect(kotlinLaunchers(source)).toEqual(["a.b", "c.d"]);
  });
});
