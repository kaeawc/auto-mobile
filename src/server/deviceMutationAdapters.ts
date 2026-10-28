import {
  legacyAppContainerFileKey,
  scopedAppFileKey,
} from "../daemon/sessionBroker/mutations/appContainerFileKey";
import { DISPLAY_KEYS } from "../features/utility/DefaultDeviceSettingsAccess";
import { DISPLAY_GEOMETRY_FIELDS } from "../features/utility/AndroidDisplayGeometry";
import { ACCESSIBILITY_DISPLAY_FIELDS } from "../features/utility/AccessibilityDisplayPreferences";
import type { DeviceSettingKey } from "../models/DeviceSettingDefaults";
import type { Platform } from "../models";
import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import { appLocaleJournalKey } from "../daemon/sessionBroker/appLocaleJournalKey";
import type { DeviceMutationInput } from "../daemon/sessionBroker/mutations/types";
import { isRecord } from "./pipeline/isRecord";
import { KEYBOARD_READ_ACTIONS } from "./interactionToolTypes";
import { dataToolMutations } from "./deviceMutationDataAdapters";
import { appearanceToolMutations } from "./deviceMutationAppearanceAdapters";
import { interactionToolMutations } from "./deviceMutationInteractionAdapters";
import { lifecycleToolMutations } from "./deviceMutationLifecycleAdapters";
import { orchestrationToolMutations } from "./deviceMutationOrchestrationAdapters";
import {
  deviceConditionSkewsClock,
  deviceStateToolMutations,
  devicePowerMutations,
  deviceStateFallbackMutations,
} from "./deviceMutationDeviceStateAdapters";
import { normalizeAndroidPermissionName } from "../features/action/GrantAndroidPermissions";
import type { AndroidPermissionTarget } from "./deviceMutationPermissionPriorReader";
import { isReadOnlySqlQuery } from "../features/database/sqlQueryClassification";
import {
  DEVICE_MUTATION_TOOL_COVERAGE,
  DEVICE_MUTATION_CALL_EXEMPTIONS,
} from "../daemon/sessionBroker/mutations/toolCoverage";

export type ToolMutation = Pick<DeviceMutationInput, "kind" | "key">;

function mutation(kind: string, key = "device"): ToolMutation {
  return { kind, key };
}

/** The displayConfig argument that selects each journaled display setting. */
function displayArgument(key: DeviceSettingKey): string {
  return key === "nightMode" ? "theme" : key;
}

/**
 * Every displayConfig setting a call can change, in journal vocabulary: the display keys plus the
 * accessibility display preferences (#14790). The iOS Simulator has no density, and its font
 * scale is the Dynamic Type category, so the scale is journaled as `contentSize`, the setting
 * that is actually restored.
 */
function settingMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  const reset = args.reset === true;
  const keys: DeviceSettingKey[] = [...DISPLAY_KEYS, ...ACCESSIBILITY_DISPLAY_FIELDS].filter(
    (key) =>
      args[displayArgument(key)] !== undefined ||
      // Reset restores what an earlier call journaled, so it records the display keys only.
      (reset && (DISPLAY_KEYS as readonly string[]).includes(key)),
  );
  const journaled =
    platform === "ios"
      ? keys
          .filter((key) => key !== "density")
          .map((key) => (key === "fontScale" ? "contentSize" : key))
      : keys;
  return [...new Set(journaled), ...geometryKeys(args, platform)].map((key) =>
    mutation("device-setting", key),
  );
}

/**
 * Runtime size, navigation mode and cutout (#14101) have no journal vocabulary: their prior
 * state is not a readable setting, so they record one opaque intent (restored by the session's
 * display-profile cleanup, not by a revert). The iOS Simulator and devices refuse them.
 */
function geometryKeys(args: Record<string, unknown>, platform?: Platform): string[] {
  return platform !== "ios" && DISPLAY_GEOMETRY_FIELDS.some((field) => args[field] !== undefined)
    ? ["tool:displayConfig"]
    : [];
}

const ANDROID_SPECIFIC_PERMISSION_FIELDS = [
  "notificationsEnabled",
  "notificationPolicyAccess",
  "scheduleExactAlarm",
];

/**
 * The `runtime:<user>:<package>:<permission>` key the Android reset port reverts in place, for a
 * permission (or a `notificationsEnabled` that toggles POST_NOTIFICATIONS) of a resolved target.
 * Notification policy access and the exact-alarm app-op have no such key.
 */
function runtimePermissionKey(
  appId: unknown,
  key: unknown,
  target: AndroidPermissionTarget | undefined,
): string | undefined {
  if (!target || typeof appId !== "string" || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(appId)) {
    return undefined;
  }
  const permission =
    key === "notificationsEnabled"
      ? target.notificationsAreRuntime
        ? "android.permission.POST_NOTIFICATIONS"
        : undefined
      : typeof key === "string" && !ANDROID_SPECIFIC_PERMISSION_FIELDS.includes(key)
        ? normalizeAndroidPermissionName(key)
        : undefined;
  return permission && /^[A-Za-z0-9_.]+$/.test(permission)
    ? `runtime:${target.userId}:${appId}:${permission}`
    : undefined;
}

function permissionMutations(
  args: Record<string, unknown>,
  target?: AndroidPermissionTarget,
): ToolMutation[] {
  if (args.action === "reset") {
    return [mutation("permission", "device")];
  }
  const permissions = Array.isArray(args.permissions) ? args.permissions : [];
  const keys = [
    ...permissions,
    ...ANDROID_SPECIFIC_PERMISSION_FIELDS.filter((key) => args[key] !== undefined),
  ];
  const journalKeys = keys.map(
    (key) =>
      runtimePermissionKey(args.appId, key, target) ??
      JSON.stringify([args.appId, args.userId ?? "default", key]),
  );
  return [...new Set(journalKeys)].map((key) => mutation("permission", key));
}

/** setAppPermissions intents once the host resolved the Android user and notification path. */
export function androidPermissionMutations(
  args: Record<string, unknown>,
  target: AndroidPermissionTarget,
): ToolMutation[] {
  return permissionMutations(args, target);
}

/**
 * Every `setDeviceState` field that changes device state (`deviceCondition` shares the power
 * controls' keys). `power` records one intent per control (see `devicePowerMutations`); a
 * `power` with nothing recognizable records one generic breadcrumb so the call still journals.
 * Android effects nothing reverts (emulator GPS fix, lock credential, camera poster) add an
 * opaque `fallback:` intent that forces keep-booted reset to escalate.
 */
function deviceStateMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  const entries = [
    ["location", "location"],
    ["clock", "clock"],
    ["biometrics", "biometric-enrollment"],
    ["networkCondition", "network-condition"],
    ["doNotDisturb", "device-setting"],
    ["cameraPoster", "device-setting"],
    ["screenLock", "device-setting"],
  ];
  const mutations = entries
    .filter(
      ([field]) =>
        args[field] !== undefined || (field === "clock" && deviceConditionSkewsClock(args)),
    )
    .map(([field, kind]) => {
      const value = args[field];
      const key =
        field === "networkCondition" && isRecord(value) && value.appId
          ? JSON.stringify(["app", value.appId])
          : kind === "device-setting"
            ? field
            : "device";
      return mutation(kind, key);
    });
  if (isRecord(args.connectivity)) {
    mutations.push(...Object.keys(args.connectivity).map((key) => mutation("device-setting", key)));
  }
  const power = devicePowerMutations(args);
  mutations.push(
    ...(power.length === 0 && args.power !== undefined
      ? [mutation("device-setting", "power")]
      : power),
    ...deviceStateFallbackMutations(args, platform),
  );
  return mutations;
}

function fileMutations(args: Record<string, unknown>): ToolMutation[] {
  if (!isRecord(args.target) || !Array.isArray(args.files)) {
    return [
      mutation(
        "shared-file",
        legacyAppContainerFileKey(args.appId, args.container, args.destinationPath),
      ),
    ];
  }
  const target = args.target;
  const kind = target.domain === "media_library" ? "media" : "shared-file";
  const scope = [
    target.domain,
    target.appId,
    target.container,
    target.namespace,
    args.userId ?? "default",
  ];
  return [
    ...(target.reset === true
      ? [mutation(kind, scopedAppFileKey(target, args.userId, "namespace-reset"))]
      : []),
    ...args.files
      .filter(isRecord)
      .map((file) => mutation(kind, scopedAppFileKey(target, args.userId, file.destinationPath))),
    ...(target.indexMedia === true ? [mutation("media", JSON.stringify(scope))] : []),
  ];
}

function mutationCallIsRead(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): boolean {
  switch (name) {
    case "accessibility":
      return args.talkback === undefined && args.voiceover === undefined;
    case "keyboard":
      return typeof args.action === "string" && KEYBOARD_READ_ACTIONS.has(args.action);
    case "clipboard":
      return args.action === "get";
    case "sqlQuery":
      return typeof args.query === "string" && isReadOnlySqlQuery(args.query);
    case "displayConfig":
      return settingMutations(args, platform).length === 0;
    case "network":
      return Object.keys(args).every((key) =>
        ["platform", "device", "deviceId", "sessionUuid"].includes(key),
      );
    default:
      return false;
  }
}

function rotationMutations(args: Record<string, unknown>): ToolMutation[] {
  return typeof args.display === "number" && args.display !== 0
    ? [mutation("opaque", opaqueIntentKey("rotate", "display", args.display))]
    : [mutation("rotation")];
}

/** The tool families that own their intents; the first that recognizes the tool answers. */
const FAMILY_ADAPTERS = [
  appearanceToolMutations,
  lifecycleToolMutations,
  interactionToolMutations,
  orchestrationToolMutations,
  deviceStateToolMutations,
] as const;

function familyToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  for (const adapter of FAMILY_ADAPTERS) {
    const mutations = adapter(name, args, platform);
    if (mutations !== undefined) {
      return mutations;
    }
  }
  return undefined;
}

/** Tools whose intent is fixed by their name (and, for two, an action). */
function namedToolMutations(
  name: string,
  args: Record<string, unknown>,
): ToolMutation[] | undefined {
  if (name === "rotate") {
    return rotationMutations(args);
  }
  if (name === "keyboard" && args.action === "setProfile") {
    return [mutation("keyboard", "profile")];
  }
  const opaqueKinds: Readonly<Record<string, string>> = {
    accessibility: "screen-reader",
    keyboard: "keyboard",
    postNotification: "notification",
    resetKeychain: "keychain",
    windowMode: "device-setting",
    setNotificationPolicy: "notification",
    setUIState: "preference",
  };
  return Object.hasOwn(opaqueKinds, name)
    ? [mutation(opaqueKinds[name], name === "accessibility" ? "device" : `tool:${name}`)]
    : undefined;
}

export function deviceToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] {
  if (
    DEVICE_MUTATION_TOOL_COVERAGE[name]?.status === "notJournaled" ||
    mutationCallIsRead(name, args, platform) ||
    mutationCallNotJournaled(name, args)
  ) {
    // A notJournaled tool changes no device state a later session could observe (#14359).
    return [];
  }
  const named = namedToolMutations(name, args);
  if (named !== undefined) {
    return named;
  }
  const family = familyToolMutations(name, args, platform);
  if (family !== undefined) {
    return family;
  }
  const direct = directToolMutations(name, args, platform);
  if (direct !== undefined) {
    // An adapter that answered [] decided this call changes nothing.
    return direct;
  }
  const mutations = stateToolMutations(name, args, platform);
  return mutations.length > 0 || DEVICE_MUTATION_TOOL_COVERAGE[name]?.status !== "journaled"
    ? mutations
    : [mutation("opaque", `tool:${name}`)];
}

export function mutationCallNotJournaled(name: string, args: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(DEVICE_MUTATION_CALL_EXEMPTIONS, name) &&
    DEVICE_MUTATION_CALL_EXEMPTIONS[name].actions.includes(String(args.action))
  );
}

function directToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  switch (name) {
    case "setAppPermissions":
      return permissionMutations(args);
    case "clipboard":
      if (args.action === "get") {
        return [];
      }
      return [
        mutation(
          args.action === "paste" ? "preference" : "clipboard",
          args.action === "paste" ? "focused-field" : "device",
        ),
      ];
    case "openLink":
      return [mutation("opened-url", String(args.url))];
    default:
      return dataToolMutations(name, args, platform);
  }
}

function stateToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] {
  switch (name) {
    case "displayConfig":
      return settingMutations(args, platform);
    case "changeLocalization":
      return ["locale", "timeZone", "textDirection", "timeFormat", "calendarSystem"]
        .filter((key) => args[key] !== undefined)
        .map((key) =>
          // The time zone is the clock family's `timezone`, which the reset ports restore.
          key === "timeZone"
            ? mutation("clock", "timezone")
            : mutation(
                "device-setting",
                key === "locale" && args.appId ? appLocaleJournalKey(String(args.appId)) : key,
              ),
        );
    case "setDeviceState":
      return deviceStateMutations(args, platform);
    case "biometricAuth":
      return [
        mutation(
          "biometric-enrollment",
          args.action === "enroll" || args.action === "unenroll" ? "device" : "auth-override",
        ),
      ];
    case "network":
      return Object.keys(args)
        .filter((key) =>
          [
            "capture",
            "simulateErrors",
            "notifFilter",
            "notifDebounceMs",
            "slowThresholdMs",
          ].includes(key),
        )
        .map((key) => mutation("network-condition", `sdk:${key}`));
    case "putAppFile":
      return fileMutations(args);
    default:
      return [];
  }
}
