import type { Platform } from "../models";
import type {
  AppsCacheEntry,
  AppsQueryAppInfo,
  AppsQueryOptions,
  AppsQueryType,
} from "./appResourcesTypes";

/**
 * True when the device reported apps but not one of them carried a
 * launchability signal — an old on-device CtrlProxy plus a failed `cmd package`
 * probe, or a physical iOS device. The `launchable` filter must degrade rather
 * than report every app as unlaunchable (#6798). A device with zero apps is not
 * "unknown": there is nothing to misreport.
 */
export function isLaunchabilityUnknown(queryApps: AppsQueryAppInfo[]): boolean {
  return queryApps.length > 0 && queryApps.every((app) => app.launchable === undefined);
}

/** The profiles an app belongs to: its own user for a user app, every user it is installed for otherwise. */
function profilesForQueryApp(app: AppsQueryAppInfo): number[] {
  if (app.type === "user") {
    return app.userId === undefined ? [] : [app.userId];
  }
  return app.userIds ?? [];
}

/**
 * Profiles that reported apps but no launchability for any of them. The launcher
 * probe runs once per Android user, so a work profile's probe can fail while the
 * owner's succeeds — and the device-wide `every` check would then call
 * launchability "known" and quietly report every work-profile app as
 * unlaunchable (#6798 review).
 */
export function launchabilityUnknownProfiles(queryApps: AppsQueryAppInfo[]): number[] {
  const known = new Set<number>();
  const seen = new Set<number>();
  for (const app of queryApps) {
    for (const profile of profilesForQueryApp(app)) {
      seen.add(profile);
      if (launchabilityForProfile(app, profile) !== undefined) {
        known.add(profile);
      }
    }
  }
  return Array.from(seen)
    .filter((profile) => !known.has(profile))
    .sort((a, b) => a - b);
}

// Exported for tests: pure filtering, no device/cache I/O (#6155).
export function filterAppsByQuery(
  apps: AppsQueryAppInfo[],
  options: AppsQueryOptions,
): AppsQueryAppInfo[] {
  // Trim + lowercase so callers get case-insensitive, whitespace-tolerant
  // search (" Camera " matches "Camera") whether search arrives from the
  // listApps tool schema (unnormalized) or the apps resource's query string
  // (#6216 review).
  const searchTerm = options.search?.trim().toLowerCase() || undefined;
  // Documented default is "launchable" (#6798, superseding the "user" default of
  // #6155) — an omitted type must not fall through to "no filter" and return
  // providers and overlays too.
  const effectiveType = options.type ?? "launchable";

  return apps.filter(
    (app) =>
      matchesAppsQueryType(app, effectiveType, options.profile) &&
      matchesAppsQueryProfile(app, options.profile) &&
      matchesAppsQuerySearch(app, searchTerm),
  );
}

/**
 * Launchability as it applies to one profile, or to the app as a whole when no
 * profile was requested. A deduplicated system app can launch in a work profile
 * and not for the owner, so a profile-scoped query must read that profile's
 * value rather than the "launches somewhere" scalar (#6798 review).
 */
export function launchabilityForProfile(
  app: AppsQueryAppInfo,
  profile: number | undefined,
): boolean | undefined {
  if (profile === undefined || app.launchableByUserId === undefined) {
    return app.launchable;
  }
  return app.launchableByUserId[profile];
}

// Exported for tests: keeps the existing profile and search predicates authoritative.
export function launchabilityUnknownApps(
  queryApps: AppsQueryAppInfo[],
  options: AppsQueryOptions,
): string[] {
  return filterAppsByQuery(queryApps, { ...options, type: "all" })
    .filter((app) => launchabilityForProfile(app, options.profile) === undefined)
    .map((app) => app.packageName);
}

function matchesAppsQueryType(
  app: AppsQueryAppInfo,
  effectiveType: AppsQueryType,
  profile: number | undefined,
): boolean {
  if (effectiveType === "launchable") {
    // Strictly `=== true`: an app whose launchability was never reported is not
    // evidence that it launches.
    return launchabilityForProfile(app, profile) === true;
  }
  return effectiveType === "all" || app.type === effectiveType;
}

function matchesAppsQueryProfile(app: AppsQueryAppInfo, profile: number | undefined): boolean {
  if (profile === undefined) {
    return true;
  }
  return app.type === "user" ? app.userId === profile : (app.userIds?.includes(profile) ?? false);
}

function matchesAppsQuerySearch(app: AppsQueryAppInfo, searchTerm: string | undefined): boolean {
  if (!searchTerm) {
    return true;
  }
  return (
    app.packageName.toLowerCase().includes(searchTerm) ||
    (app.label?.toLowerCase().includes(searchTerm) ?? false)
  );
}

/**
 * Rejects an explicit `type` the cached listing cannot answer honestly.
 *
 * An EXPLICIT type=system/type=user filter on a physical iOS device with no
 * reliable classification signal must not silently return an empty (or
 * over-inclusive) result — that reads as "no system apps exist" rather than
 * "we can't tell". type=all is unaffected (#6216 review, round 5).
 *
 * An OMITTED type on such a device is the more common case, and must not be
  // silently defaulted to "user" either: `--include-all-apps` is passed
  // unconditionally when listing a physical device (DeviceAppManager), so the
  // cached apps already include system records, and every unclassified one
  // was defaulted to "user" (extractIosApplicationType). Applying the normal
  // "user" default filter here would therefore let system apps straight
  // through while the response still claimed `query.type: "user"` — exactly
  // the over-inclusive-but-mislabeled result Codex flagged (#6216 review,
  // round 6). Report the effective type as "all" (the truthful description
  // of what this transport can actually filter) and skip the "user" default
 * filter, rather than rejecting the common omitted-type call outright.
 *
 * An explicit type=launchable against a device that reported no launchability
 * signal at all would return an empty list that reads as "nothing on this
 * device can be launched". Reject it the same way an unclassifiable
 * type=user/type=system is rejected (#6798). The same reasoning applies per
 * profile: the launcher probe runs once per Android user, so an explicit
 * type=launchable scoped to a profile whose probe failed must be rejected
 * rather than answered with an authoritative-looking empty list (#6798 review).
 */
export function assertRequestedTypeIsAnswerable(
  deviceId: string,
  platform: Platform,
  options: AppsQueryOptions,
  cacheEntry: AppsCacheEntry,
): void {
  if (
    options.type !== undefined &&
    options.type !== "all" &&
    cacheEntry.iosTypeClassificationUnreliable
  ) {
    throw new Error(
      `Cannot filter by type=${options.type} for device ${deviceId}: iOS user/system ` +
        "app classification is not available on this transport (physical device via devicectl). " +
        "Use type=all (or omit type) to list every app.",
    );
  }
  if (
    options.type === "launchable" &&
    isLaunchabilityUnknownForQuery(cacheEntry, options.profile)
  ) {
    if (platform === "ios") {
      throw new Error(
        `Cannot filter by type=launchable for device ${deviceId}${
          options.profile === undefined ? "" : ` profile ${options.profile}`
        }: simctl's app listing omitted ApplicationType for every app on this device, so ` +
          "launchability could not be determined. Re-run after the simulator finishes booting, " +
          `or check \`xcrun simctl listapps ${deviceId}\` output directly. Use type=user, ` +
          "type=system or type=all.",
      );
    }
    throw new Error(
      `Cannot filter by type=launchable for device ${deviceId}${
        options.profile === undefined ? "" : ` profile ${options.profile}`
      }: no launchability signal is available (the installed CtrlProxy APK predates the field ` +
        "and the `cmd package query-activities` probe did not answer). Use type=user, type=system " +
        "or type=all.",
    );
  }
}

/**
 * The type actually applied, reported back to the caller as `query.type` so a
 * response never claims a filter it did not apply. Precedence:
 *  1. A physical iOS device with no user/system signal reports "all" for an
 *     omitted type (#6216 review, round 6) — it cannot honor any narrower one.
 *  2. An omitted type is "launchable" (#6798), degrading to "user" when no app
 *     reported launchability, which is the pre-#6798 behavior.
 *  3. Anything explicit is honored verbatim.
 */
export function resolveEffectiveAppsQueryType(
  requested: AppsQueryType | undefined,
  cacheEntry: AppsCacheEntry,
  profile: number | undefined,
): AppsQueryType {
  if (requested !== undefined) {
    return requested;
  }
  if (cacheEntry.iosTypeClassificationUnreliable) {
    return "all";
  }
  return isLaunchabilityUnknownForQuery(cacheEntry, profile) ? "user" : "launchable";
}

/**
 * Whether the `launchable` filter can be applied honestly to what this query
 * asks for: the whole device when no profile was named, otherwise just that
 * profile (#6798 review).
 */
function isLaunchabilityUnknownForQuery(
  cacheEntry: AppsCacheEntry,
  profile: number | undefined,
): boolean {
  if (profile === undefined) {
    return cacheEntry.launchabilityUnknown === true;
  }
  return cacheEntry.launchabilityUnknownProfiles?.includes(profile) === true;
}
