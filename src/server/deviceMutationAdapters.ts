import { DISPLAY_KEYS } from "../features/utility/DefaultDeviceSettingsAccess";
import { DISPLAY_GEOMETRY_FIELDS } from "../features/utility/AndroidDisplayGeometry";
import { ACCESSIBILITY_DISPLAY_FIELDS } from "../features/utility/AccessibilityDisplayPreferences";
import type { DeviceSettingKey } from "../models/DeviceSettingDefaults";
import type { Platform } from "../models";
import type { DeviceMutationInput } from "../daemon/sessionBroker/mutations/types";
import { isRecord } from "./pipeline/isRecord";
import { KEYBOARD_READ_ACTIONS } from "./interactionToolTypes";
import { dataToolMutations } from "./deviceMutationDataAdapters";
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

function permissionMutations(args: Record<string, unknown>): ToolMutation[] {
  if (args.action === "reset") {
    return [mutation("permission", "device")];
  }
  const permissions = Array.isArray(args.permissions) ? args.permissions : [];
  const keys = [
    ...permissions,
    ...["notificationsEnabled", "notificationPolicyAccess", "scheduleExactAlarm"].filter(
      (key) => args[key] !== undefined,
    ),
  ];
  return keys.map((key) =>
    mutation("permission", JSON.stringify([args.appId, args.userId ?? "default", key])),
  );
}

function deviceStateMutations(args: Record<string, unknown>): ToolMutation[] {
  const entries = [
    ["location", "location"],
    ["clock", "clock"],
    ["biometrics", "biometric-enrollment"],
    ["networkCondition", "network-condition"],
    ["doNotDisturb", "device-setting"],
    ["cameraPoster", "device-setting"],
    ["screenLock", "device-setting"],
    ["power", "device-setting"],
  ];
  const mutations = entries
    .filter(([field]) => args[field] !== undefined)
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
  return mutations;
}

function fileMutations(args: Record<string, unknown>): ToolMutation[] {
  if (!isRecord(args.target) || !Array.isArray(args.files)) {
    return [
      mutation("shared-file", JSON.stringify([args.appId, args.container, args.destinationPath])),
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
      ? [mutation(kind, JSON.stringify([...scope, "namespace-reset"]))]
      : []),
    ...args.files
      .filter(isRecord)
      .map((file) => mutation(kind, JSON.stringify([...scope, file.destinationPath]))),
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
    ? [mutation("opaque", `display:${args.display}`)]
    : [mutation("rotation")];
}

export function deviceToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] {
  if (mutationCallIsRead(name, args, platform) || mutationCallNotJournaled(name, args)) {
    return [];
  }
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
    setPosture: "device-setting",
    setUIState: "preference",
  };
  if (Object.hasOwn(opaqueKinds, name)) {
    return [mutation(opaqueKinds[name], name === "accessibility" ? "device" : `tool:${name}`)];
  }
  const mutations =
    directToolMutations(name, args, platform) ?? stateToolMutations(name, args, platform);
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
    case "installApp":
      return typeof args.appId === "string"
        ? [mutation("installed-app", args.appId)]
        : [mutation("opaque", "tool:installApp")];
    case "uninstallApp":
      return [mutation("installed-app", String(args.appId))];
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
          mutation(
            "device-setting",
            key === "locale" && args.appId ? JSON.stringify(["app-locale", args.appId]) : key,
          ),
        );
    case "setDeviceState":
      return deviceStateMutations(args);
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
