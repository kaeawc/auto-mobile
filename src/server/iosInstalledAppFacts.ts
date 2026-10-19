import {
  getIosInstalledAppBundleId,
  getIosInstalledAppPath,
  type IosInstalledAppRecord,
} from "../utils/ios-cmdline-tools/iosInstalledApp";
import {
  type AppsQueryAppInfo,
  type InstalledAppType,
  type IosInstalledAppInfo,
} from "./appResources";

function readIosStringField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readIosAppField(app: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readIosStringField(app[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function extractIosDisplayName(app: Record<string, unknown>): string | undefined {
  return readIosAppField(app, [
    "bundleDisplayName",
    "bundleName",
    "CFBundleDisplayName",
    "CFBundleName",
    "displayName",
    "name",
  ]);
}

export function extractIosVersion(app: Record<string, unknown>): string | undefined {
  return readIosAppField(app, [
    "bundleShortVersionString",
    "bundleVersion",
    "CFBundleShortVersionString",
    "CFBundleVersion",
    "BundleShortVersionString",
    "BundleVersion",
    "version",
  ]);
}

export function extractIosPath(app: Record<string, unknown>): string | undefined {
  // Shared with the devicectl listing so a physical device's `file://` bundle
  // URL reaches this resource as a filesystem path, same as a simulator's.
  return getIosInstalledAppPath(app);
}

/**
 * Classifies an iOS app as "user" or "system" so `type=user` (the documented
 * default, #6155) actually excludes preinstalled apps on iOS the same way it
 * excludes them on Android.
 *
 * `simctl listapps` reports an explicit `ApplicationType` ("System"/"Hidden"
 * vs "User") — when present it always wins. When it's absent:
 *  - On the simulator, an unexpected/incomplete record still falls back to
 *    Apple's `com.apple.` bundle-id namespace, which only first-party system
 *    apps use there.
 *  - On a PHYSICAL device, `devicectl device info apps --json-output` exposes
 *    no equivalent field at all (only bundleIdentifier/name/version/
 *    bundleVersion/url/appClip, per Apple's devicectl output), so the
 *    `com.apple.` heuristic would misclassify a user's own Apple-published
 *    apps (Pages, Numbers, Keynote, TestFlight, ...) as hidden system apps and
 *    silently drop them from `type=user`. Without a reliable signal there,
 *    default to "user" rather than guessing "system" (#6216 review).
 */
const IOS_APPLICATION_TYPE_KEYS = ["ApplicationType", "applicationType", "type", "Type"];

function readIosRawApplicationType(app: Record<string, unknown>): string | undefined {
  return readIosAppField(app, IOS_APPLICATION_TYPE_KEYS);
}

function hasIosHiddenSpringBoardTag(app: Record<string, unknown>): boolean {
  return (
    Array.isArray(app.SBAppTags) &&
    app.SBAppTags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "hidden")
  );
}

// Exported for tests: pure classification, no device/cache I/O (#6155).
export function extractIosApplicationType(
  app: Record<string, unknown>,
  bundleId: string,
  isPhysicalDevice: boolean,
): InstalledAppType {
  const raw = readIosRawApplicationType(app);
  if (raw) {
    const normalized = raw.toLowerCase();
    if (normalized === "system" || normalized === "hidden") {
      return "system";
    }
    if (normalized === "user") {
      return "user";
    }
  }
  if (isPhysicalDevice) {
    return "user";
  }
  return bundleId.startsWith("com.apple.") ? "system" : "user";
}

// Exported for tests: pure check, no device/cache I/O (#6216 review, round 5).
export function isIosApplicationTypeUnclassified(
  app: Record<string, unknown>,
  isPhysicalDevice: boolean,
): boolean {
  return isPhysicalDevice && !readIosRawApplicationType(app);
}

// Exported for tests: pure classification, no device/cache I/O (#6798).
export function extractIosLaunchable(app: Record<string, unknown>): boolean | undefined {
  if (hasIosHiddenSpringBoardTag(app)) {
    return false;
  }
  const raw = readIosRawApplicationType(app)?.toLowerCase();
  if (raw === "hidden") {
    return false;
  }
  if (raw === "user" || raw === "system") {
    return true;
  }
  return undefined;
}

// Exported for tests: pure conversion, no device/cache I/O (#6216 review).
export function toQueryIosApp(app: IosInstalledAppInfo): AppsQueryAppInfo {
  return {
    packageName: app.bundleId,
    type: app.type,
    userId: 0,
    // iOS has no Android-style multi-user profiles — every app belongs to the
    // single (profile 0) user. filterAppsByQuery's profile check only reads
    // `userIds` for non-"user" apps; without this, any profile filter (e.g.
    // the common profile:0 case) would silently drop every iOS system app
    // because `userIds` was left undefined (#6216 review).
    userIds: [0],
    userProfile: "personal",
    foreground: false,
    recent: false,
    ...(app.displayName ? { displayName: app.displayName, label: app.displayName } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
  };
}

export function collectIosInstalledApps(
  rawApps: readonly IosInstalledAppRecord[],
  isPhysicalDevice: boolean,
): {
  apps: IosInstalledAppInfo[];
  queryApps: AppsQueryAppInfo[];
  iosTypeClassificationUnreliable: boolean;
} {
  const apps: IosInstalledAppInfo[] = [];
  const queryApps: AppsQueryAppInfo[] = [];
  let iosTypeClassificationUnreliable = false;

  for (const app of rawApps) {
    const bundleId = getIosInstalledAppBundleId(app);
    if (!bundleId) {
      continue;
    }
    const rawApp = app;
    const displayName = extractIosDisplayName(rawApp);
    const version = extractIosVersion(rawApp);
    const path = extractIosPath(rawApp);
    const type = extractIosApplicationType(rawApp, bundleId, isPhysicalDevice);
    if (isIosApplicationTypeUnclassified(rawApp, isPhysicalDevice)) {
      iosTypeClassificationUnreliable = true;
    }
    const launchable = extractIosLaunchable(rawApp);
    const info: IosInstalledAppInfo = {
      bundleId,
      type,
      displayName,
      ...(version ? { version } : {}),
      ...(path ? { path } : {}),
      ...(launchable === undefined ? {} : { launchable }),
    };
    apps.push(info);
    queryApps.push({
      ...toQueryIosApp(info),
    });
  }

  return { apps, queryApps, iosTypeClassificationUnreliable };
}
