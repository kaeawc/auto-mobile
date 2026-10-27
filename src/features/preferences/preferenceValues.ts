import type { SimulatorContainerOwnershipOptions } from "../../utils/ios-cmdline-tools/simulatorOwnContainer";
import {
  IOS_SDK_REDACTED_VALUE,
  iosPreferenceType,
  type IosPreferenceType,
} from "./IosPreferenceTypes";
import { plistReal } from "./IosUserDefaultsPlist";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import { CtrlProxyServicePortChangedError } from "../observe/ios/CtrlProxyServicePortChangedError";
import { type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { errorMessage } from "../../utils/describeUnknownError";
import { type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
import { float32ToJavaString } from "../../utils/float32ToJavaString";
import { type Timer } from "../../utils/SystemTimer";
import {
  arrayOfNodes,
  findNamedNode,
  parseAndroidPreferencesXml,
  removeNamedNodes,
  sanitizeAndroidPreferencesFileName,
  serializeAndroidPreferencesXml,
  type AndroidPreferencesXmlDocument,
} from "./AndroidPreferencesXmlFile";
import type { KeyValueEntry, KeyValueType } from "../storage/storageTypes";

// Two attempts preserve the existing preference read retry bound.
export const PREFERENCE_READ_ATTEMPTS = 2;

export type PreferenceScope = "systemProperty" | "sharedPreferences" | "userDefaults";

export type PreferenceValueType = "string" | "bool" | "int" | "float";

export type PreferenceResultType = IosPreferenceType | "long" | "stringSet";

export type PreferenceValue = string | boolean | number;

export type PreferenceResultValue = PreferenceValue | string[];

export interface GetPreferenceInput {
  scope: PreferenceScope;
  appId?: string;
  suite?: string;
  key: string;
  /**
   * Android sharedPreferences only: the user whose copy of the app to read/write
   * (`run-as <pkg> --user <id>`). Defaults to user 0 when the app is installed for it.
   */
  userId?: number;
}

export interface SetPreferenceInput extends GetPreferenceInput {
  value: PreferenceValue;
  type: PreferenceValueType;
}

export interface PreferenceResult {
  success: boolean;
  deviceId: string;
  platform: "android" | "ios";
  scope: PreferenceScope;
  appId?: string;
  suite?: string;
  key: string;
  /** Android sharedPreferences only: the user whose app copy was read or written. */
  userId?: number;
  value: PreferenceResultValue | null;
  type?: PreferenceResultType;
  found: boolean;
  verified?: boolean;
  /** SDK sentinel: present but hidden; value is null and never compared on write. */
  redacted?: true;
  /** SDK collections only; descriptions retain raw text with type unknown. */
  valueFormat?: "canonical-json" | "sdk-description";
  warning?: string;
  /** iOS userDefaults only: standard, custom suite, or global domain name. */
  resolvedStore?: string;
  storeRoute?: "sdk" | "container-plist" | "defaults";
}

export interface IosSimulatorPreferenceClient {
  executeCommand(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  executeCommandArgs(
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

export type IosPreferenceKeyValueClient = Pick<
  IOSCtrlProxyClient,
  "getPreference" | "setPreference" | "isConnected"
>;

export type IosPreferenceStore =
  | { kind: "sdk"; store: string; client: IosPreferenceKeyValueClient }
  | {
      kind: "container-plist" | "defaults";
      store: string;
      domain: string;
      unavailableGroup?: boolean;
    };

export interface AppPreferencesDependencies {
  containerOwnership?: SimulatorContainerOwnershipOptions;
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorPreferenceClient | null;
  timer?: Timer;
  iosKeyValueClientProvider?: () => IosPreferenceKeyValueClient | null;
  plistReader?: Pick<PlistReader, "readXmlFile">;
}

type AndroidPreferenceTag = "string" | "boolean" | "int" | "float";

interface AndroidPreferenceEntry {
  value: PreferenceResultValue;
  type: PreferenceResultType;
}

export const IOS_PREFERENCE_SDK_TIMEOUT_MS = 2_500;

export const IOS_PROCESS_PROBE_TIMEOUT_MS = 5_000;

// CtrlProxy's complete pre-dispatch foreground gate, with the optional wire prefix.
export const IOS_RUNNER_FOREGROUND_GATE_PATTERN =
  /^(?:Command execution failed: )?iOS key-value storage requires \S+ to be the foreground app$/;

export const IOS_PLIST_READ_WARNING =
  "This value comes from the on-disk plist and may lag a running app because cfprefsd can hold newer values.";

const IOS_PLIST_WRITE_WARNING =
  "defaults write to an absolute path bypasses the preferences daemon. A running app may not see the change, and cfprefsd may later overwrite it with cached state until the app restarts. verified: true proves only file content, not the running app's state.";

export const IOS_GROUP_SUITE_WARNING =
  "App-group suites live in the group container and are only reachable through the embedded SDK on this preference route.";

export const IOS_DEFAULTS_COMMAND_TIMEOUT_MS = 10_000;

export const IOS_DEFAULTS_OPERATION_TIMEOUT_MS = 30_000;

const ANDROID_INT_MIN = -2147483648;

const ANDROID_INT_MAX = 2147483647;

const ANDROID_TYPE_TO_TAG: Record<PreferenceValueType, AndroidPreferenceTag> = {
  string: "string",
  bool: "boolean",
  int: "int",
  float: "float",
};

const ANDROID_STORAGE_TAGS = [
  ["string", "STRING"],
  ["boolean", "BOOLEAN"],
  ["int", "INT"],
  ["long", "LONG"],
  ["float", "FLOAT"],
  ["set", "STRING_SET"],
  ["null", "UNKNOWN"],
] as const satisfies readonly (readonly [string, KeyValueType])[];

/** Convert SharedPreferences XML into the string values emitted by the Android inspector. */
export async function readAndroidStorageEntries(xml: string): Promise<KeyValueEntry[]> {
  const document = await parseAndroidPreferencesXml(xml);
  const entries: KeyValueEntry[] = [];

  for (const [tag, type] of ANDROID_STORAGE_TAGS) {
    for (const node of arrayOfNodes(document.map[tag])) {
      const key = node.$?.name;
      if (typeof key !== "string") {
        continue;
      }
      const value = storageEntryValue(tag, node);
      entries.push({ key, type, value });
    }
  }
  return entries;
}

function storageEntryValue(tag: string, node: any): string | null {
  if (tag === "null") {
    return null;
  }
  if (tag === "string") {
    return node._ ?? "";
  }
  if (tag === "set") {
    return JSON.stringify(readAndroidStringSetValues(node));
  }
  if (tag === "float") {
    const value = node.$?.value;
    return value === undefined ? null : float32ToJavaString(Number(value));
  }
  const value = node.$?.value;
  return value === undefined ? null : String(value);
}

export function androidSharedPreferencesFileName(input: GetPreferenceInput): string {
  const name = input.suite ?? `${input.appId}_preferences`;
  try {
    return sanitizeAndroidPreferencesFileName(name);
  } catch {
    // Re-thrown with "suite" terminology since this is reached from the setPreference/
    // getPreference tools, where the caller-facing argument is named `suite`.
    throw new ActionableError(
      "Android SharedPreferences suite must be a safe file name using letters, numbers, underscore, dash, or dot.",
    );
  }
}

export async function readAndroidPreferenceEntry(
  xml: string,
  key: string,
): Promise<AndroidPreferenceEntry | null> {
  const document = await parseAndroidPreferencesXml(xml);
  const map = document.map ?? {};

  const stringNode = findNamedNode(map.string, key);
  if (stringNode) {
    return { type: "string", value: stringNode._ ?? "" };
  }

  const scalarEntry = readAndroidScalarPreferenceEntry(map, key);
  if (scalarEntry) {
    return scalarEntry;
  }

  const longNode = findNamedNode(map.long, key);
  if (longNode) {
    return { type: "long", value: parseLongValue(longNode.$?.value ?? "") };
  }

  const stringSetNode = findNamedNode(map.set, key);
  if (stringSetNode) {
    return { type: "stringSet", value: readAndroidStringSetValues(stringSetNode) };
  }

  return null;
}

function readAndroidScalarPreferenceEntry(
  map: NonNullable<AndroidPreferencesXmlDocument["map"]>,
  key: string,
): AndroidPreferenceEntry | null {
  const booleanNode = findNamedNode(map.boolean, key);
  if (booleanNode) {
    return { type: "bool", value: parsePreferenceValue(booleanNode.$?.value ?? "", "bool") };
  }

  const intNode = findNamedNode(map.int, key);
  if (intNode) {
    return { type: "int", value: parsePreferenceValue(intNode.$?.value ?? "", "int") };
  }

  const floatNode = findNamedNode(map.float, key);
  if (floatNode) {
    return { type: "float", value: parsePreferenceValue(floatNode.$?.value ?? "", "float") };
  }

  return null;
}

export async function writeAndroidPreferenceEntry(
  xml: string,
  key: string,
  value: PreferenceValue,
  type: PreferenceValueType,
): Promise<string> {
  const document: AndroidPreferencesXmlDocument = await parseAndroidPreferencesXml(xml);
  document.map ??= {};
  removeNamedNodes(document, key);

  const tag = ANDROID_TYPE_TO_TAG[type];
  const nodes = arrayOfNodes(document.map[tag]);
  nodes.push(androidNodeFor(key, value, type));
  document.map[tag] = nodes;

  return serializeAndroidPreferencesXml(document);
}

function readAndroidStringSetValues(node: any): string[] {
  return arrayOfNodes(node.string).map((stringNode) => {
    if (typeof stringNode === "string") {
      return stringNode;
    }
    return stringNode?._ ?? "";
  });
}

function androidNodeFor(
  key: string,
  value: PreferenceValue,
  type: PreferenceValueType,
): Record<string, unknown> {
  if (type === "string") {
    return { _: stringValue(value), $: { name: key } };
  }
  if (type === "int") {
    assertAndroidSharedPreferencesInt(value);
  }
  return {
    $: {
      name: key,
      value: type === "float" ? float32ToJavaString(value as number) : stringValue(value),
    },
  };
}

function assertAndroidSharedPreferencesInt(value: PreferenceValue): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < ANDROID_INT_MIN ||
    value > ANDROID_INT_MAX
  ) {
    throw new ActionableError(
      `Android SharedPreferences int values must fit in the signed 32-bit range (${ANDROID_INT_MIN} to ${ANDROID_INT_MAX}).`,
    );
  }
}

export const IOS_PREFERENCE_WRITE_TYPES: Record<PreferenceValueType, KeyValueType> = {
  string: "STRING",
  int: "INT",
  bool: "BOOLEAN",
  float: "FLOAT",
};

export function iosSdkStoreName(store: string): string {
  return store === "standard" ? "Standard" : store;
}

/** A dispatched or ambiguous SDK write must never be retried through the container. */
export function assertIosPreferenceSdkWriteNotDispatched(error: unknown): void {
  if (!isIosPreferenceSdkNotDispatched(error)) {
    throw new ActionableError(
      `iOS UserDefaults SDK write failed: ${errorMessage(error)}. The write may or may not have been applied. Read the value through the SDK before retrying; no container write was attempted.`,
      { cause: error },
    );
  }
}

/** Runner capability guards that refused before any SDK preference operation was sent. */
export function isIosPreferenceSdkNotDispatched(error: unknown): boolean {
  const message = errorMessage(error);
  if (/(?:^|: )sdk_unavailable_not_dispatched$/.test(message)) {
    return true;
  }
  // Older runners lack the token. Match only their complete capability refusals,
  // including the optional CommandError wire prefix, never network/foreground faults.
  return /^(?:Command execution failed: )?iOS key-value storage requires (?:[A-Za-z0-9_.-]+ to embed and initialize the AutoMobile SDK and call UserDefaultsInspector\.shared\.setEnabled\(true\)|the target app to embed the AutoMobile SDK)$/.test(
    message,
  );
}

export function isIosPreferenceSdkUnavailable(error: unknown): boolean {
  const message = errorMessage(error);
  // Reads may retry known transport/deadline/capability signals. Only the separate
  // not-dispatched predicate permits writes to retry; mismatch and mutation faults do not.
  return (
    isIosPreferenceSdkNotDispatched(error) ||
    error instanceof CtrlProxyServicePortChangedError ||
    // Compatibility with pending requests from clients emitting the original Error.
    message === "CtrlProxy service port changed" ||
    message === "Failed to connect to CtrlProxy" ||
    /^(?:Get preference timeout after \d+ms|iOS UserDefaults request timed out after \d+ms\.)$/.test(
      message,
    ) ||
    /^(?:WebSocket (?:is not open|closed|connection closed)|Connection (?:closed|lost)|connection_lost)$/.test(
      message,
    ) ||
    (/^iOS key-value storage requires the target app to embed the AutoMobile SDK, initialize it, and call UserDefaultsInspector\.shared\.setEnabled\(true\): /.test(
      message,
    ) &&
      /(?:Could not connect to the server|couldn[’']t connect to the server|connection refused|network connection was lost|not connected to the Internet|request timed out)\.?$/i.test(
        message,
      )) ||
    /^iOS key-value storage requires the target app to embed or upgrade the AutoMobile SDK: (?:not_found|HTTP 404)$/.test(
      message,
    ) ||
    /(?:^|: )user_defaults_inspection_disabled$/.test(message)
  );
}

export function isIosSdkEntryRedacted(entry: KeyValueEntry): boolean {
  return entry.redacted === true || entry.value === IOS_SDK_REDACTED_VALUE;
}

export function iosSdkPreferenceValue(
  entry: KeyValueEntry,
): Pick<PreferenceResult, "value" | "type" | "redacted" | "valueFormat" | "warning"> {
  const value = entry.value;
  // Honor explicit SDK redaction before scalar conversion, regardless of value.
  if (isIosSdkEntryRedacted(entry)) {
    return { type: iosPreferenceType(entry.type), value: null, redacted: true };
  }
  const type = iosPreferenceType(entry.type);
  if (value !== null && (type === "array" || type === "dictionary")) {
    if (isCanonicalSdkCollection(value, type)) {
      return { type, value, valueFormat: "canonical-json" };
    }
    return {
      type: "unknown",
      value,
      valueFormat: "sdk-description",
      warning:
        "The SDK could not encode this collection as canonical JSON (older SDKs can fall back for nested Date/Data; unsafe integers are also non-canonical). The raw SDK description may be lossy; the container-plist route, used when the SDK is not connected, returns recursive JSON with ISO/base64 leaves and exact integer strings.",
    };
  }
  return {
    type,
    value:
      value === null
        ? null
        : type === "int"
          ? parseIosInteger(value)
          : type === "bool"
            ? parseBool(value)
            : type === "float"
              ? plistReal(value)
              : value,
  };
}

// Current SDKs recursively encode Date/Data and non-finite leaves as JSON strings.
// Older SDKs can fall back to Swift interpolation instead.
// Interpolated Optional(...), [key: value], and NSDictionary { key = value; }
// descriptions fail JSON parsing/shape checks. Do not reject those words inside
// valid JSON strings: they can be legitimate collection contents.
function isCanonicalSdkCollection(value: string, type: "array" | "dictionary"): boolean {
  try {
    let hasUnsafeInteger = false;
    const parsed: unknown = JSON.parse(value, (_key, leaf: unknown) => {
      // Revivers visit nested numeric leaves without confusing them with strings.
      // Rounded Int64 values still lie outside the safe integer range.
      if (typeof leaf === "number" && Number.isInteger(leaf) && !Number.isSafeInteger(leaf)) {
        hasUnsafeInteger = true;
      }
      return leaf;
    });
    return (
      !hasUnsafeInteger &&
      (type === "array"
        ? Array.isArray(parsed)
        : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
    );
  } catch (error) {
    // Swift interpolation is an expected fallback; callers expose the raw description.
    logger.debug("iOS SDK collection is not canonical JSON", error);
    return false;
  }
}

export function isStandardIosStore(input: GetPreferenceInput): boolean {
  const suite = input.suite?.trim().toLowerCase();
  return !suite || suite === "standard" || (!!input.appId && suite === input.appId.toLowerCase());
}

export function iosDefaultsDomain(input: GetPreferenceInput): string {
  return isStandardIosStore(input) ? input.appId! : sanitizeIosDefaultsDomain(input.suite!);
}

export function sanitizeIosDefaultsDomain(suite: string): string {
  // A defaults domain must be an identifier, never a plist path.
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(suite)) {
    throw new ActionableError(
      "iOS UserDefaults suite must be an identifier using letters, numbers, underscore, dash, or dot, without path separators or empty path segments.",
    );
  }
  return suite;
}

export function iosDefaultsTypeFlag(type: PreferenceValueType): string {
  switch (type) {
    case "bool":
      return "-bool";
    case "int":
      return "-int";
    case "float":
      return "-float";
    case "string":
      return "-string";
  }
}

export function normalizeValueForType(
  value: PreferenceValue,
  type: PreferenceValueType,
): PreferenceValue {
  return parsePreferenceValue(stringValue(value), type);
}

export function parsePreferenceValue(value: string, type: PreferenceValueType): PreferenceValue {
  switch (type) {
    case "bool":
      return parseBool(value);
    case "int":
      return parseInteger(value);
    case "float":
      return parseFloatValue(value);
    case "string":
      return value;
  }
}

export function canParsePreferenceValue(value: string, type: PreferenceValueType): boolean {
  try {
    parsePreferenceValue(value, type);
    return true;
  } catch (error) {
    // An effective-value override may be incompatible with the requested write type.
    logger.debug("Preference read-back cannot be parsed as the requested type", error);
    return false;
  }
}

export function parseIosDefaultsValue(
  value: string,
  type: IosPreferenceType | undefined,
): PreferenceValue {
  if (type === undefined || type === "string") {
    return removeOneTrailingLineEnding(value);
  }
  if (type === "int") {
    return parseIosInteger(value);
  }
  if (type === "bool" || type === "float") {
    return parsePreferenceValue(value, type);
  }
  return removeOneTrailingLineEnding(value);
}

export function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n") || value.endsWith("\r")) {
    return value.slice(0, -1);
  }
  return value;
}

export function parseIosDefaultsType(value: string): IosPreferenceType | undefined {
  const type = iosPreferenceType(value);
  return type === "unknown" ? undefined : type;
}

function parseBool(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new ActionableError(`Expected bool preference value, got '${value}'.`);
}

function parseInteger(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ActionableError(`Expected int preference value, got '${value}'.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new ActionableError(
      `Expected int preference value within JavaScript's safe integer range, got '${value}'.`,
    );
  }
  return parsed;
}

function parseIosInteger(value: string): number | string {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ActionableError(`Expected int preference value, got '${value}'.`);
  }
  const parsed = BigInt(trimmed);
  if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return trimmed;
  }
  return Number(parsed);
}

function parseLongValue(value: string): string | number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ActionableError(`Expected long preference value, got '${value}'.`);
  }

  const parsed = BigInt(trimmed);
  const minLong = -9223372036854775808n;
  const maxLong = 9223372036854775807n;
  if (parsed < minLong || parsed > maxLong) {
    throw new ActionableError(`Expected signed 64-bit long preference value, got '${value}'.`);
  }
  if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return trimmed;
  }
  return Number(parsed);
}

function parseFloatValue(value: string): number {
  const trimmed = value.trim();
  if (!/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    throw new ActionableError(`Expected float preference value, got '${value}'.`);
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new ActionableError(`Expected float preference value, got '${value}'.`);
  }
  return parsed;
}

export function stringValue(value: PreferenceResultValue | null): string {
  if (value === null) {
    return "";
  }
  return String(value);
}

export function valuesEqual(
  actual: PreferenceValue | null,
  expected: PreferenceValue,
  type: PreferenceValueType,
): boolean {
  if (actual === null) {
    return false;
  }
  return parsePreferenceValue(stringValue(actual), type) === expected;
}

export function looksLikeMissingIosDefault(error: unknown): boolean {
  const message = errorMessage(error).trim();
  const stderr =
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  return [
    /The domain\/default pair of \([^)]+\) does not exist\.?$/i,
    /Domain [^\n]+ does not exist\.?$/i,
    /Domain [^\n]+ not found\.?$/i,
    /Domain [^\n]+ does not contain (?:a value for )?[^\n]+\.?$/i,
    /Could not find key '[^'\n]+' in domain '[^'\n]+'\.?(?:\s+Defaults have not been changed\.?)?$/i,
  ].some((pattern) => pattern.test(message) || pattern.test(stderr));
}

/** `get_app_container` output that means the app is not installed, so a retry cannot help. */
export function isMissingIosAppError(detail: string): boolean {
  return /Application not found|No such file or directory|NSPOSIXErrorDomain, code=2/i.test(detail);
}

export function isRetryableIosDefaultsError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /timed out/i.test(message) ||
    /Failed to connect to (?:the )?CoreSimulator service/i.test(message) ||
    /CoreSimulatorService connection (?:refused|reset|interrupted|invalidated)/i.test(message) ||
    /connection (?:refused|reset|interrupted|invalidated)/i.test(message) ||
    /Unable to lookup in current state: Booting/i.test(message)
  );
}

export function iosDefaultsOperationTimeoutError(): ActionableError {
  return new ActionableError(
    `iOS UserDefaults preference operation timed out after ${IOS_DEFAULTS_OPERATION_TIMEOUT_MS}ms.`,
  );
}

/**
 * The timeout for the bound that expires first (#14683): with no operation deadline, or for an SDK
 * call, the command's own bound; otherwise the command's bound while the operation budget still has
 * time beyond it, else the exhausted operation budget.
 */
export function iosPreferenceCommandTimeoutError(
  command: string,
  commandTimeoutMs: number,
  budgetMs: number | undefined,
): () => ActionableError {
  if (budgetMs === undefined || commandTimeoutMs === IOS_PREFERENCE_SDK_TIMEOUT_MS) {
    return () => new ActionableError(`iOS ${command} timed out after ${commandTimeoutMs}ms.`);
  }
  if (budgetMs <= commandTimeoutMs) {
    return iosDefaultsOperationTimeoutError;
  }
  return () =>
    new ActionableError(
      `iOS ${command} timed out after ${commandTimeoutMs}ms (operation budget ${IOS_DEFAULTS_OPERATION_TIMEOUT_MS}ms).`,
    );
}

export function preferenceWriteWarning(
  platform: "android" | "ios",
  scope: PreferenceScope,
  iosRoute?: IosPreferenceStore["kind"],
): string | undefined {
  if (platform === "ios" && scope === "userDefaults") {
    if (iosRoute === "sdk") {
      return undefined;
    }
    if (iosRoute === "container-plist") {
      return IOS_PLIST_WRITE_WARNING;
    }
    return "UserDefaults writes go through the preferences daemon; a running app that cached the value may need a cold relaunch to observe the change.";
  }
  if (platform === "android" && scope === "systemProperty") {
    return "Android system properties are global and generally reset on reboot.";
  }
  if (platform === "android" && scope === "sharedPreferences") {
    return "SharedPreferences writes edit the XML file on disk; a running app that cached the value may need a cold relaunch to observe the change.";
  }
  return undefined;
}

/**
 * Physical iOS UserDefaults need the app's embedded SDK (#14093): the runner process cannot reach
 * another app's sandbox, and devices expose no container plist to fall back to.
 */
export function physicalIosUserDefaultsRequireSdkError(detail: string): ActionableError {
  return new ActionableError(
    `${detail} On physical iOS devices, getPreference and setPreference require the app to embed the AutoMobile SDK with storage inspection enabled and to be connected. ` +
      "Launch the app's DEBUG build with the SDK, or use an iOS Simulator.",
  );
}
