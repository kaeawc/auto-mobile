/**
 * The single source of known Android HOME launcher packages (#14056).
 *
 * Three copies of this list used to drift apart: the home-verification
 * fallback set in `androidLauncherPackages.ts`, the gfxinfo-less package check
 * in `Idle.ts`, and the desktop's default-app picker
 * (`ANDROID_LAUNCHERS` in `AutoMobileContent.kt`). The TypeScript consumers
 * now read this list, and `test/features/observe/androidLauncherRegistry.test.ts`
 * fails when the Kotlin copy differs from it.
 *
 * Order is preference order: the desktop picks the first package in this list
 * that is installed as the default app to show.
 *
 * Entries are matched by EXACT package name unless a consumer documents
 * otherwise. A new entry needs captured evidence (an `observe` capture or
 * hierarchy dump from a device running that launcher) under `test/fixtures/`;
 * the registry test enforces this and lists the entries that predate the rule.
 */
export const KNOWN_ANDROID_LAUNCHER_PACKAGES: readonly string[] = [
  // Pixel Launcher.
  "com.google.android.apps.nexuslauncher",
  // AOSP Launcher3.
  "com.android.launcher3",
  // Samsung One UI.
  "com.sec.android.app.launcher",
  // Huawei.
  "com.huawei.android.launcher",
  // Xiaomi MIUI.
  "com.miui.home",
  // Legacy AOSP launcher.
  "com.android.launcher",
  // Samsung.
  "com.samsung.android.app.launcher",
  // OnePlus.
  "com.oneplus.launcher",
];
