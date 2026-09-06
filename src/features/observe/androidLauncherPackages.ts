/**
 * Known Android launcher package names (or their sub-packages), used to
 * verify that a "go home" action actually landed on the home screen.
 *
 * Background (issue #6147): on Android API 28 the CtrlProxy accessibility
 * global action for "home" can report success while the foreground app is
 * unchanged (or even navigates within the same app, mimicking Back). Home
 * actions must not report success on the strength of that self-reported
 * result alone -- they need to confirm the foreground package actually
 * became the launcher.
 */
const LAUNCHER_PACKAGES: readonly string[] = [
  "com.android.launcher3",
  "com.google.android.apps.nexuslauncher",
  "com.samsung.android.app.launcher",
  "com.miui.home",
  "com.oneplus.launcher",
  "com.huawei.android.launcher",
  "com.sec.android.app.launcher",
];

/**
 * True when `appId` is a known launcher package or a sub-package of one
 * (e.g. `com.miui.home.settings`). Matches by prefix, not substring
 * containment, so short package names cannot be misclassified (cf. issue
 * #4172's equivalent fix for `Idle.isSystemLauncher`).
 */
export function isLauncherPackage(appId: string | null | undefined): boolean {
  if (!appId) {
    return false;
  }
  return LAUNCHER_PACKAGES.some(
    (launcherPackage) => appId === launcherPackage || appId.startsWith(`${launcherPackage}.`),
  );
}
