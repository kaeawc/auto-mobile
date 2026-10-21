import registry from "../../../schemas/android-launcher-packages.json";

/** One known Android HOME launcher, from `schemas/android-launcher-packages.json` (#14056). */
export interface AndroidLauncherEntry {
  readonly packageName: string;
  readonly label: string;
  /** `legacy` for entries that predate the evidence rule, else a captured hierarchy fixture path. */
  readonly evidence: string;
}

/** Every known launcher, in priority order. The JSON file is the single source. */
export const ANDROID_LAUNCHERS: readonly AndroidLauncherEntry[] = registry.launchers;

/** Package names of {@link ANDROID_LAUNCHERS}, in the same order. */
export const ANDROID_LAUNCHER_PACKAGES: readonly string[] = ANDROID_LAUNCHERS.map(
  (entry) => entry.packageName,
);
