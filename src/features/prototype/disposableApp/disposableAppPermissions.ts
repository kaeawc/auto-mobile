import { ActionableError } from "../../../models/ActionableError";
import type { PrototypeJson } from "../prototypeJson";
import { expandPrototypeComponents } from "../prototypeComponents";
import { prototypePlatformError } from "../prototypePlatform";
import { prototypeRequiresSchema } from "../prototypePlatformSchema";

/**
 * Permissions and background entitlements of a disposable app (#14184), derived only from the
 * spec's root `requires` block (#14294). They never come from free-form tool input, so a spec
 * cannot ask for more than its nodes and actions use. The tables map the contract's canonical
 * names (#14297 permissions, #14301 background kinds) onto each platform.
 */

const ANDROID = "android.permission.";

/** Contract permission name → Android manifest permissions. Empty means none is needed. */
export const DISPOSABLE_APP_ANDROID_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  camera: [`${ANDROID}CAMERA`],
  microphone: [`${ANDROID}RECORD_AUDIO`],
  location: [`${ANDROID}ACCESS_FINE_LOCATION`, `${ANDROID}ACCESS_COARSE_LOCATION`],
  locationBackground: [`${ANDROID}ACCESS_BACKGROUND_LOCATION`],
  notifications: [`${ANDROID}POST_NOTIFICATIONS`],
  photos: [`${ANDROID}READ_MEDIA_IMAGES`, `${ANDROID}READ_MEDIA_VIDEO`],
  // MediaStore inserts need no permission on the API levels the template targets.
  photosAdd: [],
  contacts: [`${ANDROID}READ_CONTACTS`],
  calendar: [`${ANDROID}READ_CALENDAR`, `${ANDROID}WRITE_CALENDAR`],
  bluetooth: [`${ANDROID}BLUETOOTH_SCAN`, `${ANDROID}BLUETOOTH_CONNECT`],
  nearbyWifi: [`${ANDROID}NEARBY_WIFI_DEVICES`],
  motion: [`${ANDROID}ACTIVITY_RECOGNITION`],
  speech: [`${ANDROID}RECORD_AUDIO`],
};

/**
 * `requires.platform` module → Android install-time permissions its runtime uses. These have no
 * contract permission name because nothing is granted at runtime, so they come from the module
 * list; the template's merged manifest declares them, but stamping rebuilds the permission list.
 */
export const DISPOSABLE_APP_ANDROID_MODULE_PERMISSIONS: Readonly<
  Record<string, readonly string[]>
> = {
  biometric: [`${ANDROID}USE_BIOMETRIC`],
  // Google Cast needs INTERNET (always declared) and ACCESS_NETWORK_STATE (#14239).
  cast: [`${ANDROID}ACCESS_NETWORK_STATE`],
};

/** Contract background kind → Android foreground-service type permissions. */
export const DISPOSABLE_APP_ANDROID_BACKGROUND: Readonly<Record<string, readonly string[]>> = {
  audio: [`${ANDROID}FOREGROUND_SERVICE_MEDIA_PLAYBACK`],
  location: [`${ANDROID}FOREGROUND_SERVICE_LOCATION`],
  call: [`${ANDROID}FOREGROUND_SERVICE_PHONE_CALL`],
  connectedDevice: [`${ANDROID}FOREGROUND_SERVICE_CONNECTED_DEVICE`],
  transfer: [`${ANDROID}FOREGROUND_SERVICE_DATA_SYNC`],
  camera: [`${ANDROID}FOREGROUND_SERVICE_CAMERA`],
  microphone: [`${ANDROID}FOREGROUND_SERVICE_MICROPHONE`],
  // Push delivery needs no foreground service.
  remoteNotification: [],
};

/** Contract permission name → iOS Info.plist usage-description key. */
export const DISPOSABLE_APP_IOS_USAGE_KEYS: Readonly<Record<string, string>> = {
  camera: "NSCameraUsageDescription",
  microphone: "NSMicrophoneUsageDescription",
  location: "NSLocationWhenInUseUsageDescription",
  locationBackground: "NSLocationAlwaysAndWhenInUseUsageDescription",
  photos: "NSPhotoLibraryUsageDescription",
  photosAdd: "NSPhotoLibraryAddUsageDescription",
  contacts: "NSContactsUsageDescription",
  calendar: "NSCalendarsFullAccessUsageDescription",
  bluetooth: "NSBluetoothAlwaysUsageDescription",
  nearbyWifi: "NSLocalNetworkUsageDescription",
  motion: "NSMotionUsageDescription",
  speech: "NSSpeechRecognitionUsageDescription",
  // notifications has no usage key on iOS.
};

/** Contract background kind → iOS `UIBackgroundModes` values. */
export const DISPOSABLE_APP_IOS_BACKGROUND_MODES: Readonly<Record<string, readonly string[]>> = {
  audio: ["audio"],
  location: ["location"],
  call: ["voip"],
  connectedDevice: ["bluetooth-central"],
  transfer: ["processing"],
  // iOS has no background camera mode.
  camera: [],
  microphone: ["audio"],
  remoteNotification: ["remote-notification"],
};

const ANDROID_ALWAYS = [`${ANDROID}INTERNET`];
const ANDROID_FOREGROUND_SERVICE = `${ANDROID}FOREGROUND_SERVICE`;

export interface DisposableAppDeclarations {
  /** Contract permission names from `requires.permissions`, sorted. */
  permissions: string[];
  /** Contract background kinds from `requires.background`, sorted. */
  background: string[];
  android: { permissions: string[] };
  ios: { usageDescriptions: Record<string, string>; backgroundModes: string[] };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function moduleRequirements(requires: ReturnType<typeof prototypeRequiresSchema.parse>) {
  return Array.isArray(requires) ? {} : requires;
}

function assertSpecPermissionsDeclared(spec: PrototypeJson): void {
  // Tool callers already validate the schema. Reuse the platform semantic rules here so direct
  // manager callers cannot bypass call/node permission checks, including inside components.
  const expansion = expandPrototypeComponents(spec);
  const problem = expansion.success
    ? prototypePlatformError(expansion.spec, [], () => undefined)
    : expansion.error;
  if (problem) {
    const path = expansion.success ? expansion.locate(problem.path) : problem.path;
    throw new ActionableError(
      `Cannot derive disposable app permissions at ${path}: ${problem.message}. If a permission is required, declare it in requires.permissions and retry.`,
    );
  }
}

export function disposableAppDeclarations(spec: PrototypeJson): DisposableAppDeclarations {
  const raw = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec.requires ?? {}) : {};
  const parsed = prototypeRequiresSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ActionableError(
      `The spec's requires block is invalid, so the disposable app's permissions cannot be derived: ${parsed.error.issues[0]?.message ?? "unknown error"}. Validate the spec and retry.`,
    );
  }
  assertSpecPermissionsDeclared(spec);
  const declarations = moduleRequirements(parsed.data);
  const permissionEntries = declarations.permissions ?? [];
  const permissions = sortedUnique(permissionEntries.map((entry) => entry.name));
  const background = sortedUnique(declarations.background ?? []);
  const modules = declarations.platform ?? [];
  const services = background.flatMap((kind) => DISPOSABLE_APP_ANDROID_BACKGROUND[kind] ?? []);
  return {
    permissions,
    background,
    android: {
      permissions: sortedUnique([
        ...ANDROID_ALWAYS,
        ...permissions.flatMap((name) => DISPOSABLE_APP_ANDROID_PERMISSIONS[name] ?? []),
        ...modules.flatMap((name) => DISPOSABLE_APP_ANDROID_MODULE_PERMISSIONS[name] ?? []),
        ...(services.length > 0 ? [ANDROID_FOREGROUND_SERVICE, ...services] : []),
      ]),
    },
    ios: {
      usageDescriptions: Object.fromEntries(
        permissionEntries.flatMap((entry) => {
          const key = DISPOSABLE_APP_IOS_USAGE_KEYS[entry.name];
          return key ? [[key, entry.purpose]] : [];
        }),
      ),
      backgroundModes: sortedUnique(
        background.flatMap((kind) => DISPOSABLE_APP_IOS_BACKGROUND_MODES[kind] ?? []),
      ),
    },
  };
}

/** The #14297 permission modes: `prompt` leaves every grant to the user. */
export type DisposableAppPermissionMode =
  | "prompt"
  | "grantDeclared"
  | { grant?: readonly string[]; deny?: readonly string[] };

export interface DisposableAppPermissionGrants {
  granted: string[];
  denied: string[];
}

/**
 * Resolve a permission mode against the declared contract names. A grant or deny of an
 * undeclared name is refused: the spec's `requires` is the only source of permissions.
 */
export function resolveDisposableAppGrants(
  mode: DisposableAppPermissionMode,
  declared: readonly string[],
): DisposableAppPermissionGrants {
  if (mode === "prompt") {
    return { granted: [], denied: [] };
  }
  if (mode === "grantDeclared") {
    return { granted: [...declared], denied: [] };
  }
  const granted = sortedUnique(mode.grant ?? []);
  const denied = sortedUnique(mode.deny ?? []);
  const undeclared = [...granted, ...denied].filter((name) => !declared.includes(name));
  if (undeclared.length > 0) {
    throw new ActionableError(
      `app.permissions names ${undeclared.join(", ")}, which the spec does not declare in requires.permissions (declared: ${declared.join(", ") || "none"}). Add the permission to requires.permissions or drop it from the mode.`,
    );
  }
  const both = granted.filter((name) => denied.includes(name));
  if (both.length > 0) {
    throw new ActionableError(
      `app.permissions both grants and denies ${both.join(", ")}. Choose one.`,
    );
  }
  return { granted, denied };
}
