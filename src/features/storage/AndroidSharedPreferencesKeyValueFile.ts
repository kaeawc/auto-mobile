import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ActionableError } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  arrayOfNodes,
  parseAndroidPreferencesXml,
  readAndroidPreferencesXml,
  removeNamedNodes,
  sanitizeAndroidPreferencesFileName,
  serializeAndroidPreferencesXml,
  writeAndroidPreferencesXml,
  type AndroidPreferencesXmlDocument,
} from "../preferences/AndroidPreferencesXmlFile";
import type { KeyValueType } from "./storageTypes";

/**
 * Direct-file fallback for the Android SharedPreferences key-value tools (`setKeyValue`,
 * `removeKeyValue`, `clearKeyValueFile`).
 *
 * `setPreference`/`getPreference` (see `AppPreferences.ts`) always reach the on-device
 * `shared_prefs/<file>.xml` directly via `adb shell run-as` and never need the SDK's
 * `SharedPreferencesInspector` capability. The key-value tools normally go through that
 * SDK ContentProvider instead (for change subscriptions and live-app cache coherence),
 * but when the app has that capability disabled, falling all the way back to failure is
 * wrong: it leaves callers able to *write* a value (via `setPreference`) but unable to
 * *delete* it (issue #6292). This module gives the key-value tools the same reachability
 * as `setPreference` for that fallback case.
 */

const KEY_VALUE_TYPE_TO_TAG: Partial<Record<KeyValueType, string>> = {
  STRING: "string",
  BOOLEAN: "boolean",
  INT: "int",
  FLOAT: "float",
  LONG: "long",
  STRING_SET: "set",
};

const ANDROID_INT_MIN = -2147483648;
const ANDROID_INT_MAX = 2147483647;
const ANDROID_LONG_MIN = -9223372036854775808n;
const ANDROID_LONG_MAX = 9223372036854775807n;

export function androidKeyValueFileName(name: string): string {
  return sanitizeAndroidPreferencesFileName(name);
}

/** Writes `key` = `value` (of `type`) into the on-device SharedPreferences XML file. */
export async function setAndroidKeyValueDirect(
  adb: AdbExecutor,
  appId: string,
  fileName: string,
  key: string,
  value: string,
  type: KeyValueType,
): Promise<void> {
  const safeFileName = androidKeyValueFileName(fileName);
  const existingXml = await readAndroidPreferencesXml(adb, appId, safeFileName);
  const document = await parseAndroidPreferencesXml(existingXml);
  document.map ??= {};
  removeNamedNodes(document, key);

  const tag = tagForType(type);
  const nodes = arrayOfNodes(document.map[tag]);
  nodes.push(androidKeyValueNode(key, value, type));
  document.map[tag] = nodes;

  await writeAndroidPreferencesXml(
    adb,
    appId,
    safeFileName,
    serializeAndroidPreferencesXml(document),
  );
}

/** Removes `key` from the on-device SharedPreferences XML file, if present. */
export async function removeAndroidKeyValueDirect(
  adb: AdbExecutor,
  appId: string,
  fileName: string,
  key: string,
): Promise<void> {
  const safeFileName = androidKeyValueFileName(fileName);
  const existingXml = await readAndroidPreferencesXml(adb, appId, safeFileName);
  const document = await parseAndroidPreferencesXml(existingXml);
  document.map ??= {};
  removeNamedNodes(document, key);
  await writeAndroidPreferencesXml(
    adb,
    appId,
    safeFileName,
    serializeAndroidPreferencesXml(document),
  );
}

/** Clears every entry from the on-device SharedPreferences XML file. */
export async function clearAndroidKeyValueFileDirect(
  adb: AdbExecutor,
  appId: string,
  fileName: string,
): Promise<void> {
  const safeFileName = androidKeyValueFileName(fileName);
  const emptyDocument: AndroidPreferencesXmlDocument = { map: {} };
  await writeAndroidPreferencesXml(
    adb,
    appId,
    safeFileName,
    serializeAndroidPreferencesXml(emptyDocument),
  );
}

/**
 * True when `error` is the SDK ContentProvider's "SharedPreferences inspection is
 * disabled" gate, as opposed to a genuine transport/argument failure that a direct-file
 * fallback would not fix.
 */
export function isSharedPreferencesInspectionDisabledError(error: unknown): boolean {
  return /SharedPreferences inspection is disabled/i.test(errorMessage(error));
}

function tagForType(type: KeyValueType): string {
  const tag = KEY_VALUE_TYPE_TO_TAG[type];
  if (!tag) {
    throw new ActionableError(
      `${type} cannot be written directly to an Android SharedPreferences XML file.`,
    );
  }
  return tag;
}

function androidKeyValueNode(
  key: string,
  value: string,
  type: KeyValueType,
): Record<string, unknown> {
  switch (type) {
    case "STRING":
      return { _: value, $: { name: key } };
    case "BOOLEAN":
      return { $: { name: key, value: parseAndroidBool(value) } };
    case "INT":
      return { $: { name: key, value: parseAndroidInt(value) } };
    case "FLOAT":
      return { $: { name: key, value: parseAndroidFloat(value) } };
    case "LONG":
      return { $: { name: key, value: parseAndroidLong(value) } };
    case "STRING_SET":
      return { $: { name: key }, string: parseAndroidStringSet(value) };
    default:
      throw new ActionableError(
        `${type} cannot be written directly to an Android SharedPreferences XML file.`,
      );
  }
}

function parseAndroidBool(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return "true";
  }
  if (["0", "false", "no"].includes(normalized)) {
    return "false";
  }
  throw new ActionableError(`Expected BOOLEAN key-value, got '${value}'.`);
}

function parseAndroidInt(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ActionableError(`Expected INT key-value, got '${value}'.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < ANDROID_INT_MIN || parsed > ANDROID_INT_MAX) {
    throw new ActionableError(
      `Android INT key-values must fit in the signed 32-bit range (${ANDROID_INT_MIN} to ${ANDROID_INT_MAX}), got '${value}'.`,
    );
  }
  return String(parsed);
}

function parseAndroidFloat(value: string): string {
  const trimmed = value.trim();
  if (!/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    throw new ActionableError(`Expected FLOAT key-value, got '${value}'.`);
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new ActionableError(`Expected FLOAT key-value, got '${value}'.`);
  }
  return String(parsed);
}

function parseAndroidLong(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ActionableError(`Expected LONG key-value, got '${value}'.`);
  }
  const parsed = BigInt(trimmed);
  if (parsed < ANDROID_LONG_MIN || parsed > ANDROID_LONG_MAX) {
    throw new ActionableError(`Expected signed 64-bit LONG key-value, got '${value}'.`);
  }
  return trimmed;
}

function parseAndroidStringSet(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ActionableError(`STRING_SET key-value must be a JSON array of strings: ${error}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ActionableError(
      `STRING_SET key-value must be a JSON array of strings, got '${value}'.`,
    );
  }
  return parsed;
}
