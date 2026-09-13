/**
 * Android app catalog: display labels and launchability per package.
 *
 * `listApps` has to answer "which package do I launch for Contacts?" (issue
 * #6798), which needs two things `pm list packages` never reports: the launcher
 * label a human sees, and whether the package can be launched at all (content
 * providers and RRO overlays cannot).
 *
 * Sources, cheapest first:
 *  - CtrlProxy's `installed_packages` result. The accessibility service already
 *    holds a `PackageManager`, so `getApplicationLabel` /
 *    `getLaunchIntentForPackage` come back for every package in the ONE
 *    round-trip the listing already makes. This is the only source of a
 *    *resolved* label: a label is a resource id (`labelRes`), and no adb shell
 *    surface resolves resource ids — `pm list packages`, `dumpsys package` and
 *    `cmd package query-activities` all report `labelRes=0x…` /
 *    `nonLocalizedLabel=null` and nothing more.
 *  - A single batched `cmd package query-activities --brief` over
 *    MAIN/LAUNCHER. One adb round-trip for the whole user, and it answers
 *    launchability (but not labels) when CtrlProxy is unavailable or predates
 *    the field.
 */

import type { InstalledPackageRecord } from "./android/types";

export interface AndroidAppCatalogEntry {
  /** Launcher label as a human sees it ("Contacts"), when a source reported one. */
  label?: string;
  /** True when the package exposes a MAIN/LAUNCHER entry point. */
  launchable?: boolean;
}

export type AndroidAppCatalog = Map<string, AndroidAppCatalogEntry>;

/**
 * One batched read of every MAIN/LAUNCHER activity visible to `userId`. Scoped
 * per user because a work-profile package set differs from the primary user's.
 */
export function launcherActivitiesCommand(userId: number): string {
  return (
    `shell cmd package query-activities --brief --user ${userId} ` +
    "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER"
  );
}

// `--brief` prints one flattened `pkg/activity` component per line, but the
// surrounding "N activities found:" / "Activity #0:" chrome varies by API
// level, so match the component lines rather than assuming a layout.
const COMPONENT_LINE = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/\S+$/;

/** Package names that own at least one MAIN/LAUNCHER activity. */
export function parseLauncherPackages(stdout: string): Set<string> {
  const packages = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const match = COMPONENT_LINE.exec(rawLine.trim());
    if (match) {
      packages.add(match[1]);
    }
  }
  return packages;
}

function normalizeLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Catalog from a CtrlProxy `installed_packages` result. An older on-device SDK
 * omits `label`/`launchable`; the entry is then left undefined rather than
 * guessed, so callers can tell "no launcher entry" from "not reported".
 */
export function catalogFromPackageRecords(
  records: readonly InstalledPackageRecord[],
): AndroidAppCatalog {
  const catalog: AndroidAppCatalog = new Map();
  for (const record of records) {
    const label = normalizeLabel(record.label);
    catalog.set(record.packageName, {
      ...(label ? { label } : {}),
      ...(record.launchable === undefined ? {} : { launchable: record.launchable }),
    });
  }
  return catalog;
}

/** True when no record carried a launchability signal, so the adb probe earns its round-trip. */
export function needsLauncherProbe(catalog: AndroidAppCatalog): boolean {
  for (const entry of catalog.values()) {
    if (entry.launchable !== undefined) {
      return false;
    }
  }
  return true;
}

/**
 * Fold a launcher-package set into a catalog. Every package the caller knows
 * about gets a definite `launchable`, so "absent from the launcher set" reads
 * as false rather than unknown.
 */
export function applyLauncherPackages(
  catalog: AndroidAppCatalog,
  packageNames: Iterable<string>,
  launcherPackages: ReadonlySet<string>,
): AndroidAppCatalog {
  for (const packageName of packageNames) {
    const entry = catalog.get(packageName) ?? {};
    catalog.set(packageName, { ...entry, launchable: launcherPackages.has(packageName) });
  }
  return catalog;
}
