import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";

/**
 * Journal vocabulary for `setDeviceState.power` and the `deviceCondition` power faults (#14359):
 * one `device-setting` intent per power control, so each prior is read with the same primitive
 * the control writes and the Android reset port can put each one back. The adapter that records
 * the intents (`src/server`) and the port that reverts them share these keys.
 */
export const POWER_FIELD_KEYS = [
  "battery",
  "doze",
  "thermal",
  "dataSaver",
  "batterySaver",
] as const;
export type PowerFieldKey = (typeof POWER_FIELD_KEYS)[number];

export const POWER_APP_FIELD_KEYS = ["standby", "inactive"] as const;
export type PowerAppFieldKey = (typeof POWER_APP_FIELD_KEYS)[number];

export type PowerIntent =
  | { field: PowerFieldKey; appId?: undefined }
  | { field: PowerAppFieldKey; appId: string };

const POWER_PREFIX = "power:";

export function powerIntentKey(intent: PowerIntent): string {
  return intent.appId === undefined
    ? `${POWER_PREFIX}${intent.field}`
    : `${POWER_PREFIX}${intent.field}:${intent.appId}`;
}

function powerField(field: string): PowerFieldKey | undefined {
  return POWER_FIELD_KEYS.find((candidate) => candidate === field);
}

function powerAppField(field: string): PowerAppFieldKey | undefined {
  return POWER_APP_FIELD_KEYS.find((candidate) => candidate === field);
}

/** The power intent a journal key names, or null for any other key (including a bad app id). */
export function parsePowerIntentKey(key: string): PowerIntent | null {
  if (!key.startsWith(POWER_PREFIX)) {
    return null;
  }
  const [field = "", ...rest] = key.slice(POWER_PREFIX.length).split(":");
  if (rest.length === 0) {
    const known = powerField(field);
    return known ? { field: known } : null;
  }
  const appId = rest.join(":");
  const appField = powerAppField(field);
  return appField && ANDROID_PACKAGE_NAME_PATTERN.test(appId) ? { field: appField, appId } : null;
}
