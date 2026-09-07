import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ActionableError } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  arrayOfNodes,
  parseAndroidPreferencesXml,
  readAndroidPreferencesXml,
  readAndroidPreferencesXmlIfExists,
  removeNamedNodes,
  sanitizeAndroidPreferencesFileName,
  serializeAndroidPreferencesXml,
  writeAndroidPreferencesXml,
  type AndroidPreferencesXmlDocument,
} from "../preferences/AndroidPreferencesXmlFile";
import { getAndroidSharedPreferencesMutationCoordinator } from "../preferences/AndroidSharedPreferencesMutationCoordinator";
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

/**
 * Per-device/app/file serialization for the direct-XML mutations (issue #6292).
 *
 * Every direct mutation is a read-modify-write of the WHOLE `shared_prefs/<file>.xml`
 * (read the snapshot, edit a private copy, overwrite the entire file). Two concurrent
 * mutations to the same file would each read the same snapshot and the later write would
 * clobber the earlier one — a lost-update TOCTOU. Chaining every mutation for a given
 * `(deviceId, appId, safeFileName)` behind the previous one (regardless of its success or failure)
 * makes each read observe the prior write, so concurrent edits compose instead of
 * clobbering. The tail is tracked with its errors swallowed so a failed mutation does not
 * wedge the queue, and the map entry is dropped once the chain drains to keep it bounded.
 */
function serializeDirectMutationPerFile<T>(
  deviceId: string,
  appId: string,
  safeFileName: string,
  task: () => Promise<T>,
): Promise<T> {
  return getAndroidSharedPreferencesMutationCoordinator().run(deviceId, appId, safeFileName, task);
}

/** Writes `key` = `value` (of `type`) into the on-device SharedPreferences XML file. */
export async function setAndroidKeyValueDirect(
  adb: AdbExecutor,
  deviceId: string,
  appId: string,
  fileName: string,
  key: string,
  value: string,
  type: KeyValueType,
): Promise<void> {
  const safeFileName = androidKeyValueFileName(fileName);
  return serializeDirectMutationPerFile(deviceId, appId, safeFileName, async () => {
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
  });
}

/** Removes `key` from the on-device SharedPreferences XML file, if present. */
export async function removeAndroidKeyValueDirect(
  adb: AdbExecutor,
  deviceId: string,
  appId: string,
  fileName: string,
  key: string,
): Promise<void> {
  const safeFileName = androidKeyValueFileName(fileName);
  return serializeDirectMutationPerFile(deviceId, appId, safeFileName, async () => {
    const { xml: existingXml, exists } = await readAndroidPreferencesXmlIfExists(
      adb,
      appId,
      safeFileName,
    );
    if (!exists) {
      return;
    }
    const document = await parseAndroidPreferencesXml(existingXml);
    document.map ??= {};
    removeNamedNodes(document, key);
    await writeAndroidPreferencesXml(
      adb,
      appId,
      safeFileName,
      serializeAndroidPreferencesXml(document),
    );
  });
}

/** Clears every entry from the on-device SharedPreferences XML file. */
export async function clearAndroidKeyValueFileDirect(
  adb: AdbExecutor,
  deviceId: string,
  appId: string,
  fileName: string,
): Promise<void> {
  const safeFileName = androidKeyValueFileName(fileName);
  return serializeDirectMutationPerFile(deviceId, appId, safeFileName, async () => {
    const emptyDocument: AndroidPreferencesXmlDocument = { map: {} };
    await writeAndroidPreferencesXml(
      adb,
      appId,
      safeFileName,
      serializeAndroidPreferencesXml(emptyDocument),
    );
  });
}

/**
 * True when `error` is the SDK ContentProvider's "SharedPreferences inspection is
 * disabled" gate, as opposed to a genuine transport/argument failure that a direct-file
 * fallback would not fix.
 */
export function isSharedPreferencesInspectionDisabledError(error: unknown): boolean {
  return /SharedPreferences inspection is disabled/i.test(errorMessage(error));
}

/** Outcome of {@link withAndroidSharedPreferencesInspectionFallback}. */
export interface SharedPreferencesInspectionFallbackResult {
  /**
   * True when the SDK ContentProvider path was gated by disabled inspection and the
   * direct-file (`adb shell run-as` XML edit) fallback ran instead. Callers surface a
   * relaunch warning in this case (see {@link directFileFallbackRelaunchWarning}).
   */
  usedDirectFileFallback: boolean;
}

/**
 * Runs an Android SharedPreferences key-value mutation through the SDK ContentProvider
 * (`viaSdk`) and, if that fails specifically because SharedPreferences inspection is
 * disabled on the app, falls back to the same direct-file `adb shell run-as` XML edit
 * that `setPreference`/`getPreference` always use (`viaDirectFile`).
 *
 * This keeps write/delete/clear reachability consistent for the same app + SharedPreferences
 * file (issue #6292) across BOTH mutation entry points — the MCP `setKeyValue`/`removeKeyValue`/
 * `clearKeyValueFile` tools and the desktop Storage pane's `ide/*` daemon-socket routes — so a
 * caller who can write a preference through `setPreference` can also delete or clear it, instead
 * of the delete/clear paths being wrongly gated behind a capability the write path never needed.
 *
 * A failure that is NOT the "inspection disabled" gate (e.g. a genuine transport error, or the
 * direct-file fallback itself failing because the app is not debuggable) is surfaced as-is so the
 * caller sees the real, actionable cause rather than a misleading fallback error. `createAdb` is
 * only invoked when the fallback actually runs, so no adb client is created on the happy path.
 */
export async function withAndroidSharedPreferencesInspectionFallback(
  appId: string,
  fileName: string,
  createAdb: () => AdbExecutor,
  viaSdk: () => Promise<void>,
  viaDirectFile: (adb: AdbExecutor) => Promise<void>,
): Promise<SharedPreferencesInspectionFallbackResult> {
  try {
    await viaSdk();
    return { usedDirectFileFallback: false };
  } catch (error) {
    if (!isSharedPreferencesInspectionDisabledError(error)) {
      throw error;
    }
    logger.info(
      `[storage] SharedPreferences inspection is disabled for ${appId}; falling back to direct-file access for ${fileName} (issue #6292)`,
    );
    const adb = createAdb();
    await viaDirectFile(adb);
    return { usedDirectFileFallback: true };
  }
}

/**
 * The warning a mutation returns after it took the direct-XML fallback (issue #6292).
 *
 * The fallback edits the on-disk `shared_prefs/<file>.xml` directly. A running app that already
 * has that SharedPreferences file loaded keeps its old value in its in-memory cache and can
 * OVERWRITE this edit on its next `commit()`/`apply()`. Callers include this in the result so the
 * operator knows the change may not take effect until the app is relaunched (or otherwise drops
 * its in-memory cache).
 */
export function directFileFallbackRelaunchWarning(appId: string, fileName: string): string {
  return (
    `Edited ${appId}'s "${fileName}" SharedPreferences file on disk directly because ` +
    "inspection is disabled. If the app is running it may keep the old value in memory and " +
    "overwrite this change on its next commit — relaunch the app (or let it clear its " +
    "in-memory cache) for the change to take effect reliably."
  );
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
  if (value === "true" || value === "false") {
    return value;
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
  // Kotlin's String.toFloatOrNull delegates to JVM Float.parseFloat. Retain its
  // decimal and hexadecimal grammar rather than narrowing fallback requests to
  // JavaScript's Number grammar.
  const decimal = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?[fFdD]?";
  const hexadecimal =
    "0[xX](?:[0-9a-fA-F]+(?:\\.[0-9a-fA-F]*)?|\\.[0-9a-fA-F]+)[pP][+-]?\\d+[fFdD]?";
  const special = "(?:NaN|Infinity)";
  if (!new RegExp(`^[+-]?(?:${decimal}|${hexadecimal}|${special})$`).test(trimmed)) {
    throw new ActionableError(`Expected FLOAT key-value, got '${value}'.`);
  }
  return trimmed;
}

/** Shared actionable guidance for DataStore paths, which have no XML fallback. */
export function dataStoreInspectionDisabledReason(appId: string): string {
  return (
    `SharedPreferences inspection is disabled for ${appId}, so its DataStore adapter is unreachable. ` +
    "Enable it in the app's debug build by calling SharedPreferencesInspector.setEnabled(true) " +
    "(dev.jasonpearson.automobile.sdk.storage) during initialization, typically in Application.onCreate()."
  );
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
