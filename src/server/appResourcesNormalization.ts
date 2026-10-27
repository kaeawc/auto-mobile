import type { InstalledApp, InstalledAppsByProfile, SystemInstalledApp } from "../models";
import type { ListInstalledApps } from "../features/observe/ListInstalledApps";
import {
  getIosInstalledAppBundleId,
  getIosInstalledAppPath,
} from "../utils/ios-cmdline-tools/iosInstalledApp";
import type {
  AndroidInstalledAppInfo,
  AppsQueryAppInfo,
  InstalledAppInfo,
  InstalledAppType,
  IosInstalledAppInfo,
} from "./appResourcesTypes";

function userProfileForUserId(
  userId: number,
  profileType?: InstalledApp["profileType"],
): "personal" | "work" | "secondary" | "unknown" {
  if (profileType === "managed") {
    return "work";
  }
  if (profileType === "secondary") {
    return "secondary";
  }
  if (profileType === "primary" || userId === 0) {
    return "personal";
  }
  return "unknown";
}

function toInstalledAppInfo(app: InstalledApp): InstalledAppInfo {
  return {
    packageName: app.packageName,
    userId: app.userId,
    userProfile: userProfileForUserId(app.userId, app.profileType),
    foreground: app.foreground,
    recent: app.recent,
    ...(app.label ? { label: app.label } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
  };
}

function toQueryAndroidApp(app: AndroidInstalledAppInfo): AppsQueryAppInfo {
  return {
    packageName: app.packageName,
    type: "user",
    userId: app.userId,
    userProfile: app.userProfile,
    foreground: app.foreground,
    recent: app.recent,
    ...(app.label ? { label: app.label } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
  };
}

function toQuerySystemApp(app: SystemInstalledApp): AppsQueryAppInfo {
  return {
    packageName: app.packageName,
    type: "system",
    userIds: app.userIds,
    foreground: app.foreground,
    recent: app.recent,
    ...(app.label ? { label: app.label } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
    ...(app.launchableByUserId === undefined ? {} : { launchableByUserId: app.launchableByUserId }),
  };
}

export function normalizeAndroidApps(installedApps: InstalledAppsByProfile): {
  userApps: AndroidInstalledAppInfo[];
  queryApps: AppsQueryAppInfo[];
} {
  const userApps: AndroidInstalledAppInfo[] = [];
  const queryApps: AppsQueryAppInfo[] = [];

  for (const profileApps of Object.values(installedApps.profiles)) {
    for (const app of profileApps) {
      const info = toInstalledAppInfo(app) as AndroidInstalledAppInfo;
      userApps.push(info);
      queryApps.push(toQueryAndroidApp(info));
    }
  }

  for (const systemApp of installedApps.system) {
    queryApps.push(toQuerySystemApp(systemApp));
  }

  return { userApps, queryApps };
}

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

function extractIosDisplayName(app: Record<string, unknown>): string | undefined {
  return readIosAppField(app, [
    "bundleDisplayName",
    "bundleName",
    "CFBundleDisplayName",
    "CFBundleName",
    "displayName",
    "name",
  ]);
}

function extractIosVersion(app: Record<string, unknown>): string | undefined {
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

function extractIosPath(app: Record<string, unknown>): string | undefined {
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

/**
 * True when `extractIosApplicationType` had no reliable signal and had to
 * default a physical-device app to "user" — i.e. devicectl reported no
 * `ApplicationType`-equivalent field. An explicit `type=system`/`type=user`
 * filter must not be silently applied against such apps: it would report an
 * empty or over-inclusive result that looks like "no system apps exist"
 * rather than "we can't tell" (#6216 review, round 5). Always false on the
 * simulator and for apps that do carry a real classification.
 */
// Exported for tests: pure check, no device/cache I/O (#6216 review, round 5).
export function isIosApplicationTypeUnclassified(
  app: Record<string, unknown>,
  isPhysicalDevice: boolean,
): boolean {
  return isPhysicalDevice && !readIosRawApplicationType(app);
}

/**
 * iOS launchability from simctl's `ApplicationType` (#6798). "Hidden" is
 * Apple's marker for a bundle with no home-screen entry point (SpringBoard's
 * own internal apps, app extensions); "User" and "System" both launch. A
 * physical device has no equivalent field, so launchability stays undefined
 * there rather than being guessed.
 */
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

function getInstalledAppIdentifier(app: InstalledAppInfo): string {
  return "bundleId" in app ? app.bundleId : app.packageName;
}

export function buildAppsByPackage(apps: InstalledAppInfo[]): Map<string, InstalledAppInfo[]> {
  const appsByPackage = new Map<string, InstalledAppInfo[]>();
  for (const app of apps) {
    const identifier = getInstalledAppIdentifier(app);
    const existing = appsByPackage.get(identifier);
    if (existing) {
      existing.push(app);
    } else {
      appsByPackage.set(identifier, [app]);
    }
  }
  return appsByPackage;
}

export function normalizeIosApps(
  installedApps: Awaited<ReturnType<ListInstalledApps["executeIosDetailedResult"]>>["apps"],
  isPhysicalDevice: boolean,
) {
  const apps: IosInstalledAppInfo[] = [];
  const queryApps: AppsQueryAppInfo[] = [];
  let iosTypeClassificationUnreliable = false;

  for (const rawApp of installedApps) {
    const bundleId = getIosInstalledAppBundleId(rawApp);
    if (!bundleId) {
      continue;
    }
    const version = extractIosVersion(rawApp);
    const path = extractIosPath(rawApp);
    if (isIosApplicationTypeUnclassified(rawApp, isPhysicalDevice)) {
      iosTypeClassificationUnreliable = true;
    }
    const launchable = extractIosLaunchable(rawApp);
    const info: IosInstalledAppInfo = {
      bundleId,
      type: extractIosApplicationType(rawApp, bundleId, isPhysicalDevice),
      displayName: extractIosDisplayName(rawApp),
      ...(version ? { version } : {}),
      ...(path ? { path } : {}),
      ...(launchable === undefined ? {} : { launchable }),
    };
    apps.push(info);
    queryApps.push(toQueryIosApp(info));
  }

  return { apps, queryApps, iosTypeClassificationUnreliable };
}
