import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { KNOWN_ANDROID_LAUNCHER_PACKAGES } from "../../../src/features/observe/androidLauncherRegistry";

const REPO_ROOT = new URL("../../../", import.meta.url);

const DESKTOP_CONTENT_KT =
  "android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/AutoMobileContent.kt";

/**
 * Captured evidence for each registry entry: a fixture, relative to the repo
 * root, captured on a device whose foreground launcher is that package. A new
 * registry entry must add a row here (#14056).
 */
const LAUNCHER_EVIDENCE: Record<string, string> = {
  "com.google.android.apps.nexuslauncher":
    "test/fixtures/android-launcher/launcher-home-emulator-5600.json",
};

/**
 * Entries that predate the captured-evidence rule. They stay until a real
 * capture from #14048 replaces the exemption with a {@link LAUNCHER_EVIDENCE}
 * row. Do not add to this list: a new launcher needs a fixture.
 */
const EXEMPT_PRE_EVIDENCE_LAUNCHERS: readonly string[] = [
  "com.android.launcher3",
  "com.sec.android.app.launcher",
  "com.huawei.android.launcher",
  "com.miui.home",
  "com.android.launcher",
  "com.samsung.android.app.launcher",
  "com.oneplus.launcher",
];

/**
 * The quoted package names in the Kotlin `ANDROID_LAUNCHERS` declaration. The whole
 * initializer, up to the next top-level declaration, must be a single `listOf(...)` of
 * string literals: anything else (a concatenated `+ listOf(...)`, a computed value) fails
 * here rather than escaping the parity check.
 */
function kotlinLauncherList(source: string): string[] {
  const marker = "private val ANDROID_LAUNCHERS =";
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const afterMarker = source.slice(start + marker.length);
  // The declaration ends where the next top-level (column-0) line begins.
  const end = afterMarker.search(/\n(?=\S)/);
  const initializer = (end === -1 ? afterMarker : afterMarker.slice(0, end))
    .replace(/\/\/[^\n]*/g, "")
    .trim();
  const match = /^listOf\(((?:\s*"[^"]+"\s*,?)*)\s*\)$/.exec(initializer);
  expect(
    match,
    `ANDROID_LAUNCHERS must be one listOf(...) literal, got: ${initializer}`,
  ).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

describe("Android launcher registry (#14056)", () => {
  test("has no duplicate packages", () => {
    expect(new Set(KNOWN_ANDROID_LAUNCHER_PACKAGES).size).toBe(
      KNOWN_ANDROID_LAUNCHER_PACKAGES.length,
    );
  });

  test("the desktop's Kotlin launcher list equals the registry, in order", () => {
    const source = readFileSync(new URL(DESKTOP_CONTENT_KT, REPO_ROOT), "utf8");
    expect(kotlinLauncherList(source)).toEqual([...KNOWN_ANDROID_LAUNCHER_PACKAGES]);
  });

  test("every entry has captured evidence or a pre-rule exemption, never both", () => {
    const covered = [...Object.keys(LAUNCHER_EVIDENCE), ...EXEMPT_PRE_EVIDENCE_LAUNCHERS];
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual([...KNOWN_ANDROID_LAUNCHER_PACKAGES].sort());
  });

  test("each evidence fixture exists and shows that launcher in the foreground", () => {
    for (const [packageName, fixture] of Object.entries(LAUNCHER_EVIDENCE)) {
      const url = new URL(fixture, REPO_ROOT);
      expect(existsSync(url)).toBe(true);
      const capture = JSON.parse(readFileSync(url, "utf8")) as {
        activeWindow?: { appId?: string };
      };
      expect(capture.activeWindow?.appId).toBe(packageName);
    }
  });
});
