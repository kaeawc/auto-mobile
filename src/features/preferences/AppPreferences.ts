import { Builder, parseStringPromise } from "xml2js";
import { defaultAdbClientFactory, type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models";
import { IOSCtrlProxyClient } from "../observe/ios";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import type { KeyValueEntry, KeyValueType } from "../storage/storageTypes";

export type PreferenceScope = "systemProperty" | "sharedPreferences" | "userDefaults";
export type PreferenceValueType = "string" | "bool" | "int" | "float";
export type PreferenceValue = string | boolean | number;

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
  value: PreferenceValue | null;
  type?: PreferenceValueType;
  found: boolean;
  verified?: boolean;
  warning?: string;
}

interface IosSimulatorPreferenceClient {
  executeCommand(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
}

interface CtrlProxyPreferenceClient {
  getPreference(packageName: string, fileName: string, key: string, timeoutMs?: number): Promise<KeyValueEntry | null>;
  setPreference(packageName: string, fileName: string, key: string, value: string | null, type: KeyValueType, timeoutMs?: number): Promise<void>;
}

export interface AppPreferencesDependencies {
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorPreferenceClient | null;
  ctrlProxyClientFactory?: (device: BootedDevice) => CtrlProxyPreferenceClient;
}

type AndroidPreferenceTag = "string" | "boolean" | "int" | "float";

interface AndroidPreferenceEntry {
  value: PreferenceValue;
  type: PreferenceValueType;
}

const IOS_DEFAULTS_TIMEOUT_MS = 5000;

const ANDROID_TYPE_TO_TAG: Record<PreferenceValueType, AndroidPreferenceTag> = {
  string: "string",
  bool: "boolean",
  int: "int",
  float: "float",
};

const STORAGE_TYPE_BY_PREFERENCE_TYPE: Record<PreferenceValueType, KeyValueType> = {
  string: "STRING",
  bool: "BOOLEAN",
  int: "INT",
  float: "FLOAT",
};

export class AppPreferences {
  private readonly adbFactory: AdbClientFactory;
  private readonly simctl: IosSimulatorPreferenceClient | null | undefined;
  private readonly ctrlProxyClientFactory: (device: BootedDevice) => CtrlProxyPreferenceClient;

  constructor(
    private readonly device: BootedDevice,
    dependencies: AppPreferencesDependencies = {}
  ) {
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl;
    this.ctrlProxyClientFactory = dependencies.ctrlProxyClientFactory
      ?? (targetDevice => IOSCtrlProxyClient.getInstance(targetDevice));
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
          `shell setprop ${shellQuote(input.key)} ${shellQuote(stringValue(normalizedValue))}`
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
      value: readBack.found ? parsePreferenceValue(stringValue(readBack.value), input.type) : readBack.value,
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
    const result = await this.adb().executeCommand(`shell getprop ${shellQuote(input.key)}`);
    const value = result.stdout.trim();
    return this.result(input, value.length > 0, value.length > 0 ? value : null, "string");
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
    const updatedXml = await writeAndroidPreferenceEntry(existingXml, input.key, input.value, input.type);
    const encodedXml = Buffer.from(updatedXml, "utf8").toString("base64");
    const innerCommand = `mkdir -p shared_prefs && printf '%s' '${encodedXml}' | base64 -d > shared_prefs/${fileName}.xml`;
    await this.adb().executeCommand(
      `shell run-as ${shellQuote(input.appId!)} sh -c ${shellQuote(innerCommand)}`
    );
  }

  private async readAndroidSharedPreferencesXml(appId: string, fileName: string): Promise<string> {
    try {
      const result = await this.adb().executeCommand(
        `shell run-as ${shellQuote(appId)} cat shared_prefs/${fileName}.xml`
      );
      return result.stdout;
    } catch (error) {
      if (looksLikeMissingAndroidPrefsFile(error)) {
        return "<map/>";
      }
      throw new ActionableError(
        `Failed to read Android SharedPreferences via run-as. This requires a debuggable/test build for ${appId}. ${error}`
      );
    }
  }

  private async getIosUserDefault(input: GetPreferenceInput): Promise<PreferenceResult> {
    if (!isIosSimulatorDevice(this.device)) {
      const entry = await this.ctrlProxyClientFactory(this.device)
        .getPreference(input.appId!, iosSuiteName(input), input.key);
      if (!entry) {
        return this.result(input, false, null);
      }
      return this.result(
        input,
        true,
        parseCtrlProxyValue(entry),
        preferenceTypeFromStorageType(entry.type)
      );
    }

    const domain = iosDefaultsDomain(input);
    try {
      const result = await this.getSimctl().executeCommand(
        `spawn ${shellQuote(this.device.deviceId)} defaults read ${shellQuote(domain)} ${shellQuote(input.key)}`,
        IOS_DEFAULTS_TIMEOUT_MS
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
      await this.ctrlProxyClientFactory(this.device).setPreference(
        input.appId!,
        iosSuiteName(input),
        input.key,
        stringValue(input.value),
        STORAGE_TYPE_BY_PREFERENCE_TYPE[input.type]
      );
      return;
    }

    const domain = iosDefaultsDomain(input);
    const typeFlag = iosDefaultsTypeFlag(input.type);
    await this.getSimctl().executeCommand(
      `spawn ${shellQuote(this.device.deviceId)} defaults write ${shellQuote(domain)} ${shellQuote(input.key)} ${typeFlag} ${shellQuote(stringValue(input.value))}`,
      IOS_DEFAULTS_TIMEOUT_MS
    );
  }

  private async readIosDefaultsType(input: GetPreferenceInput): Promise<PreferenceValueType | undefined> {
    const domain = iosDefaultsDomain(input);
    try {
      const result = await this.getSimctl().executeCommand(
        `spawn ${shellQuote(this.device.deviceId)} defaults read-type ${shellQuote(domain)} ${shellQuote(input.key)}`,
        IOS_DEFAULTS_TIMEOUT_MS
      );
      return parseIosDefaultsType(result.stdout);
    } catch {
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
    value: PreferenceValue | null,
    type?: PreferenceValueType
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
  if (name.includes("/") || name.includes("\0") || name === "." || name === "..") {
    throw new ActionableError("Android SharedPreferences suite must be a file name, not a path.");
  }
  return name.endsWith(".xml") ? name.slice(0, -4) : name;
}

async function readAndroidPreferenceEntry(xml: string, key: string): Promise<AndroidPreferenceEntry | null> {
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

  return null;
}

async function writeAndroidPreferenceEntry(
  xml: string,
  key: string,
  value: PreferenceValue,
  type: PreferenceValueType
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
    parsed.map ??= {};
    return parsed;
  } catch (error) {
    throw new ActionableError(`Failed to parse Android SharedPreferences XML: ${error}`);
  }
}

function findNamedNode(nodes: unknown, key: string): any | null {
  return arrayOfNodes(nodes).find(node => node?.$?.name === key) ?? null;
}

function removeNamedNodes(map: Record<string, unknown>, key: string): void {
  for (const [tag, nodes] of Object.entries(map)) {
    if (Array.isArray(nodes)) {
      map[tag] = nodes.filter(node => node?.$?.name !== key);
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

function androidNodeFor(key: string, value: PreferenceValue, type: PreferenceValueType): Record<string, unknown> {
  if (type === "string") {
    return { _: stringValue(value), $: { name: key } };
  }
  return {
    $: {
      name: key,
      value: stringValue(value),
    },
  };
}

function iosDefaultsDomain(input: GetPreferenceInput): string {
  return input.suite ?? input.appId!;
}

function iosSuiteName(input: GetPreferenceInput): string {
  return input.suite ?? "Standard";
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

function parseIosDefaultsValue(value: string, type: PreferenceValueType | undefined): PreferenceValue {
  const trimmed = value.trim();
  if (type) {
    return parsePreferenceValue(trimmed, type);
  }
  return trimmed;
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
  if (!Number.isInteger(parsed)) {
    throw new ActionableError(`Expected int preference value, got '${value}'.`);
  }
  return parsed;
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

function valuesEqual(actual: PreferenceValue | null, expected: PreferenceValue, type: PreferenceValueType): boolean {
  if (actual === null) {
    return false;
  }
  return parsePreferenceValue(stringValue(actual), type) === expected;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function looksLikeMissingAndroidPrefsFile(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No such file|not found|does not exist/i.test(message);
}

function looksLikeMissingIosDefault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|Domain .* does not exist|does not contain/i.test(message);
}

function parseCtrlProxyValue(entry: KeyValueEntry): PreferenceValue | null {
  if (entry.value === null) {
    return null;
  }
  const preferenceType = preferenceTypeFromStorageType(entry.type);
  if (!preferenceType) {
    return entry.value;
  }
  try {
    const decoded = JSON.parse(entry.value);
    return parsePreferenceValue(String(decoded), preferenceType);
  } catch {
    return parsePreferenceValue(entry.value, preferenceType);
  }
}

function preferenceTypeFromStorageType(type: KeyValueType): PreferenceValueType | undefined {
  switch (type) {
    case "BOOLEAN":
      return "bool";
    case "INT":
    case "LONG":
      return "int";
    case "FLOAT":
    case "DOUBLE":
      return "float";
    case "STRING":
      return "string";
    default:
      return undefined;
  }
}

function preferenceWriteWarning(platform: "android" | "ios", scope: PreferenceScope): string | undefined {
  if (platform === "ios" && scope === "userDefaults") {
    return "UserDefaults writes go through the preferences daemon; a running app that cached the value may need a cold relaunch to observe the change.";
  }
  if (platform === "android" && scope === "systemProperty") {
    return "Android system properties are global and generally reset on reboot.";
  }
  return undefined;
}
