import { errorMessage } from "../../utils/describeUnknownError";
import { Builder, parseStringPromise } from "xml2js";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { shellQuote } from "../../utils/shellQuote";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { logger } from "../../utils/logger";

export type PreferenceScope = "systemProperty" | "sharedPreferences" | "userDefaults";
export type PreferenceValueType = "string" | "bool" | "int" | "float";
export type PreferenceResultType = PreferenceValueType | "long" | "stringSet";
export type PreferenceValue = string | boolean | number;
export type PreferenceResultValue = PreferenceValue | string[];

export interface GetPreferenceInput {
  scope: PreferenceScope;
  appId?: string;
  suite?: string;
  key: string;
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
  value: PreferenceResultValue | null;
  type?: PreferenceResultType;
  found: boolean;
  verified?: boolean;
  warning?: string;
}

interface IosSimulatorPreferenceClient {
  executeCommand(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  executeCommandArgs(
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface AppPreferencesDependencies {
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorPreferenceClient | null;
}

type AndroidPreferenceTag = "string" | "boolean" | "int" | "float";

interface AndroidPreferenceEntry {
  value: PreferenceResultValue;
  type: PreferenceResultType;
}

const IOS_DEFAULTS_TIMEOUT_MS = 5000;
const ANDROID_INT_MIN = -2147483648;
const ANDROID_INT_MAX = 2147483647;

const ANDROID_TYPE_TO_TAG: Record<PreferenceValueType, AndroidPreferenceTag> = {
  string: "string",
  bool: "boolean",
  int: "int",
  float: "float",
};

export class AppPreferences {
  private readonly adbFactory: AdbClientFactory;
  private readonly simctl: IosSimulatorPreferenceClient | null | undefined;

  constructor(
    private readonly device: BootedDevice,
    dependencies: AppPreferencesDependencies = {},
  ) {
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl;
  }

  async getPreference(input: GetPreferenceInput): Promise<PreferenceResult> {
    this.validateScope(input);

    if (this.device.platform === "android") {
      if (input.scope === "systemProperty") {
        return this.getAndroidSystemProperty(input);
      }
      return this.getAndroidSharedPreference(input);
    }

    return this.getIosUserDefault(input);
  }

  async setPreference(input: SetPreferenceInput): Promise<PreferenceResult> {
    this.validateScope(input);
    const normalizedValue = normalizeValueForType(input.value, input.type);

    if (this.device.platform === "android") {
      if (input.scope === "systemProperty") {
        await this.adb().executeCommand(
          `shell setprop ${shellQuoteUnlessSafe(input.key)} ${shellQuoteUnlessSafe(stringValue(normalizedValue))}`,
        );
      } else {
        await this.setAndroidSharedPreference({ ...input, value: normalizedValue });
      }
    } else {
      await this.setIosUserDefault({ ...input, value: normalizedValue });
    }

    const readBack = await this.getPreference(input);
    return {
      ...readBack,
      type: input.type,
      value: readBack.found
        ? parsePreferenceValue(stringValue(readBack.value), input.type)
        : readBack.value,
      verified: readBack.found && valuesEqual(readBack.value, normalizedValue, input.type),
      warning: preferenceWriteWarning(this.device.platform, input.scope),
    };
  }

  private validateScope(input: GetPreferenceInput): void {
    if (this.device.platform === "android" && input.scope === "userDefaults") {
      throw new ActionableError("userDefaults scope is only supported on iOS devices.");
    }
    if (this.device.platform === "ios" && input.scope !== "userDefaults") {
      throw new ActionableError(`${input.scope} scope is only supported on Android devices.`);
    }
    if ((input.scope === "sharedPreferences" || input.scope === "userDefaults") && !input.appId) {
      throw new ActionableError(`appId is required for ${input.scope}.`);
    }
  }

  private adb(): AdbExecutor {
    return this.adbFactory.create(this.device);
  }

  private async getAndroidSystemProperty(input: GetPreferenceInput): Promise<PreferenceResult> {
    const result = await this.adb().executeCommand(
      `shell getprop ${shellQuoteUnlessSafe(input.key)}`,
    );
    const value = removeOneTrailingLineEnding(result.stdout);
    if (value.length > 0) {
      return this.result(input, true, value, "string");
    }

    const existingEmptyValue = await this.readEmptyAndroidSystemProperty(input.key);
    return this.result(input, existingEmptyValue, existingEmptyValue ? "" : null, "string");
  }

  private async readEmptyAndroidSystemProperty(key: string): Promise<boolean> {
    const result = await this.adb().executeCommand("shell getprop");
    const prefix = `[${key}]: [`;
    return result.stdout
      .split(/\r?\n/)
      .some((line) => line.startsWith(prefix) && line.endsWith("]"));
  }

  private async getAndroidSharedPreference(input: GetPreferenceInput): Promise<PreferenceResult> {
    const fileName = androidSharedPreferencesFileName(input);
    const xml = await this.readAndroidSharedPreferencesXml(input.appId!, fileName);
    const entry = await readAndroidPreferenceEntry(xml, input.key);
    return this.result(input, entry !== null, entry?.value ?? null, entry?.type);
  }

  private async setAndroidSharedPreference(input: SetPreferenceInput): Promise<void> {
    const fileName = androidSharedPreferencesFileName(input);
    const existingXml = await this.readAndroidSharedPreferencesXml(input.appId!, fileName);
    const updatedXml = await writeAndroidPreferenceEntry(
      existingXml,
      input.key,
      input.value,
      input.type,
    );
    const encodedXml = Buffer.from(updatedXml, "utf8").toString("base64");
    const innerCommand = `mkdir -p shared_prefs && printf '%s' '${encodedXml}' | base64 -d > shared_prefs/${fileName}.xml`;
    await this.adb().executeCommand(
      `shell run-as ${shellQuoteUnlessSafe(input.appId!)} sh -c ${shellQuoteUnlessSafe(innerCommand)}`,
    );
  }

  private async readAndroidSharedPreferencesXml(appId: string, fileName: string): Promise<string> {
    try {
      const result = await this.adb().executeCommand(
        `shell run-as ${shellQuoteUnlessSafe(appId)} cat shared_prefs/${fileName}.xml`,
      );
      return result.stdout;
    } catch (error) {
      if (looksLikeMissingAndroidPrefsFile(error)) {
        return "<map/>";
      }
      throw new ActionableError(
        `Failed to read Android SharedPreferences via run-as. This requires a debuggable/test build for ${appId}. ${error}`,
      );
    }
  }

  private async getIosUserDefault(input: GetPreferenceInput): Promise<PreferenceResult> {
    if (!isIosSimulatorDevice(this.device)) {
      throw unsupportedPhysicalIosUserDefaultsError();
    }

    const domain = iosDefaultsDomain(input);
    try {
      const result = await this.getSimctl().executeCommandArgs(
        ["spawn", this.device.deviceId, "defaults", "read", domain, input.key],
        IOS_DEFAULTS_TIMEOUT_MS,
      );
      const type = await this.readIosDefaultsType(input);
      return this.result(input, true, parseIosDefaultsValue(result.stdout, type), type ?? "string");
    } catch (error) {
      if (looksLikeMissingIosDefault(error)) {
        return this.result(input, false, null);
      }
      throw new ActionableError(`Failed to read iOS UserDefaults with defaults: ${error}`);
    }
  }

  private async setIosUserDefault(input: SetPreferenceInput): Promise<void> {
    if (!isIosSimulatorDevice(this.device)) {
      throw unsupportedPhysicalIosUserDefaultsError();
    }

    const domain = iosDefaultsDomain(input);
    const typeFlag = iosDefaultsTypeFlag(input.type);
    await this.getSimctl().executeCommandArgs(
      [
        "spawn",
        this.device.deviceId,
        "defaults",
        "write",
        domain,
        input.key,
        typeFlag,
        stringValue(input.value),
      ],
      IOS_DEFAULTS_TIMEOUT_MS,
    );
  }

  private async readIosDefaultsType(
    input: GetPreferenceInput,
  ): Promise<PreferenceValueType | undefined> {
    const domain = iosDefaultsDomain(input);
    try {
      const result = await this.getSimctl().executeCommandArgs(
        ["spawn", this.device.deviceId, "defaults", "read-type", domain, input.key],
        IOS_DEFAULTS_TIMEOUT_MS,
      );
      return parseIosDefaultsType(result.stdout);
    } catch (error) {
      // `defaults read-type` fails when the key doesn't exist yet, which is a
      // normal "no preference set" state; undefined lets callers fall back.
      logger.debug(
        `src/features/preferences/AppPreferences.ts defaults type parse failed: ${error}`,
        error,
      );
      return undefined;
    }
  }

  private getSimctl(): IosSimulatorPreferenceClient {
    if (this.simctl) {
      return this.simctl;
    }
    const simctl: SimCtl = new SimCtlClient();
    simctl.setDevice(this.device);
    return simctl;
  }

  private result(
    input: GetPreferenceInput,
    found: boolean,
    value: PreferenceResultValue | null,
    type?: PreferenceResultType,
  ): PreferenceResult {
    return {
      success: true,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      scope: input.scope,
      appId: input.appId,
      suite: input.suite,
      key: input.key,
      value,
      type,
      found,
    };
  }
}

function androidSharedPreferencesFileName(input: GetPreferenceInput): string {
  const name = input.suite ?? `${input.appId}_preferences`;
  const fileName = name.endsWith(".xml") ? name.slice(0, -4) : name;
  if (!/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName === "." || fileName === "..") {
    throw new ActionableError(
      "Android SharedPreferences suite must be a safe file name using letters, numbers, underscore, dash, or dot.",
    );
  }
  return fileName;
}

async function readAndroidPreferenceEntry(
  xml: string,
  key: string,
): Promise<AndroidPreferenceEntry | null> {
  const document = await parseAndroidPreferencesXml(xml);
  const map = document.map ?? {};

  const stringNode = findNamedNode(map.string, key);
  if (stringNode) {
    return { type: "string", value: stringNode._ ?? "" };
  }

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

async function writeAndroidPreferenceEntry(
  xml: string,
  key: string,
  value: PreferenceValue,
  type: PreferenceValueType,
): Promise<string> {
  const document = await parseAndroidPreferencesXml(xml);
  document.map ??= {};
  removeNamedNodes(document.map, key);

  const tag = ANDROID_TYPE_TO_TAG[type];
  const nodes = arrayOfNodes(document.map[tag]);
  nodes.push(androidNodeFor(key, value, type));
  document.map[tag] = nodes;

  return new Builder({
    xmldec: { version: "1.0", encoding: "utf-8", standalone: true },
    renderOpts: { pretty: false },
  }).buildObject(document);
}

async function parseAndroidPreferencesXml(xml: string): Promise<any> {
  const trimmed = xml.trim();
  if (!trimmed) {
    return { map: {} };
  }
  try {
    const parsed = await parseStringPromise(trimmed, {
      explicitArray: true,
      explicitRoot: true,
      trim: false,
    });
    return normalizeAndroidPreferencesDocument(parsed);
  } catch (error) {
    throw new ActionableError(`Failed to parse Android SharedPreferences XML: ${error}`);
  }
}

function normalizeAndroidPreferencesDocument(parsed: unknown): { map: Record<string, unknown> } {
  if (!isRecord(parsed)) {
    return { map: {} };
  }
  if (!isRecord(parsed.map)) {
    return { ...parsed, map: {} };
  }
  return parsed as { map: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findNamedNode(nodes: unknown, key: string): any | null {
  return arrayOfNodes(nodes).find((node) => node?.$?.name === key) ?? null;
}

function removeNamedNodes(map: Record<string, unknown>, key: string): void {
  for (const [tag, nodes] of Object.entries(map)) {
    if (Array.isArray(nodes)) {
      map[tag] = nodes.filter((node) => node?.$?.name !== key);
    }
  }
}

function arrayOfNodes(nodes: unknown): any[] {
  if (Array.isArray(nodes)) {
    return nodes;
  }
  if (nodes === undefined || nodes === null) {
    return [];
  }
  return [nodes];
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
      value: stringValue(value),
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

function iosDefaultsDomain(input: GetPreferenceInput): string {
  if (!input.suite || input.suite.trim() === "" || input.suite === "Standard") {
    return input.appId!;
  }
  return input.suite ?? input.appId!;
}

function iosDefaultsTypeFlag(type: PreferenceValueType): string {
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

function normalizeValueForType(value: PreferenceValue, type: PreferenceValueType): PreferenceValue {
  return parsePreferenceValue(stringValue(value), type);
}

function parsePreferenceValue(value: string, type: PreferenceValueType): PreferenceValue {
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

function parseIosDefaultsValue(
  value: string,
  type: PreferenceValueType | undefined,
): PreferenceValue {
  if (type === undefined || type === "string") {
    return removeOneTrailingLineEnding(value);
  }
  if (type === "int") {
    return parseIosInteger(value);
  }
  return parsePreferenceValue(value, type);
}

function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n") || value.endsWith("\r")) {
    return value.slice(0, -1);
  }
  return value;
}

function parseIosDefaultsType(value: string): PreferenceValueType | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("boolean") || normalized.includes("bool")) {
    return "bool";
  }
  if (normalized.includes("integer") || normalized.includes("int")) {
    return "int";
  }
  if (normalized.includes("float") || normalized.includes("double")) {
    return "float";
  }
  if (normalized.includes("string")) {
    return "string";
  }
  return undefined;
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

function stringValue(value: PreferenceValue | null): string {
  if (value === null) {
    return "";
  }
  return String(value);
}

function valuesEqual(
  actual: PreferenceValue | null,
  expected: PreferenceValue,
  type: PreferenceValueType,
): boolean {
  if (actual === null) {
    return false;
  }
  return parsePreferenceValue(stringValue(actual), type) === expected;
}

function shellQuoteUnlessSafe(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return shellQuote(value);
}

function looksLikeMissingAndroidPrefsFile(error: unknown): boolean {
  const message = errorMessage(error);
  if (!/No such file|not found|does not exist/i.test(message)) {
    return false;
  }
  return /shared_prefs\/[^/\s]+\.xml/i.test(message);
}

function looksLikeMissingIosDefault(error: unknown): boolean {
  const message = errorMessage(error);
  return /does not exist|Domain .* does not exist|does not contain/i.test(message);
}

function preferenceWriteWarning(
  platform: "android" | "ios",
  scope: PreferenceScope,
): string | undefined {
  if (platform === "ios" && scope === "userDefaults") {
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

function unsupportedPhysicalIosUserDefaultsError(): ActionableError {
  return new ActionableError(
    "iOS physical devices are not supported for UserDefaults preferences yet. " +
      "The available CtrlProxy storage APIs run in the runner process and cannot safely read or write another app's UserDefaults sandbox. " +
      "Use an iOS Simulator for UserDefaults automation.",
  );
}
