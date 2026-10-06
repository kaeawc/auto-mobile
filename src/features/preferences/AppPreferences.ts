import {
  IOS_SDK_REDACTED_VALUE,
  iosPreferenceType,
  type IosPreferenceType,
} from "./IosPreferenceTypes";
import { parseIosUserDefaultsPlist, plistReal } from "./IosUserDefaultsPlist";
import { join } from "node:path";
import {
  CtrlProxyServicePortChangedError,
  IOSCtrlProxyClient,
} from "../observe/ios/IOSCtrlProxyClient";
import { PlistClient, type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { toActionableError } from "../../models/ActionableError";
import { IOS_STORAGE_MUTATION_AUTHORIZATION_HINT } from "../../server/storageSdkErrors";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { shellQuoteUnlessSafe } from "../../utils/shellQuote";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { logger } from "../../utils/logger";
import { float32ToJavaString } from "../../utils/float32ToJavaString";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  arrayOfNodes,
  findNamedNode,
  parseAndroidPreferencesXml,
  readAndroidPreferencesXml,
  removeNamedNodes,
  sanitizeAndroidPreferencesFileName,
  serializeAndroidPreferencesXml,
  writeAndroidPreferencesXml,
  type AndroidPreferencesXmlDocument,
} from "./AndroidPreferencesXmlFile";
import { resolveDefaultAndroidPreferencesUser } from "./resolveAndroidPreferencesUser";
import type { KeyValueEntry, KeyValueType } from "../storage/storageTypes";
import { getAndroidSharedPreferencesMutationCoordinator } from "./AndroidSharedPreferencesMutationCoordinator";

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

interface IosSimulatorPreferenceClient {
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

type IosPreferenceStore =
  | { kind: "sdk"; store: string; client: IosPreferenceKeyValueClient }
  | {
      kind: "container-plist" | "defaults";
      store: string;
      domain: string;
      unavailableGroup?: boolean;
    };

export interface AppPreferencesDependencies {
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

const IOS_PREFERENCE_SDK_TIMEOUT_MS = 2_500;
const IOS_PLIST_READ_WARNING =
  "This value comes from the on-disk plist and may lag a running app because cfprefsd can hold newer values.";
const IOS_PLIST_WRITE_WARNING =
  "defaults write to an absolute path bypasses the preferences daemon. A running app may not see the change, and cfprefsd may later overwrite it with cached state until the app restarts. verified: true proves only file content, not the running app's state.";
const IOS_GROUP_SUITE_WARNING =
  "App-group suites live in the group container and are only reachable through the embedded SDK on this preference route.";
const IOS_DEFAULTS_COMMAND_TIMEOUT_MS = 10_000;
const IOS_DEFAULTS_OPERATION_TIMEOUT_MS = 30_000;
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

export class AppPreferences {
  private readonly adbFactory: AdbClientFactory;
  private readonly simctl: IosSimulatorPreferenceClient | null | undefined;
  private readonly timer: Timer;
  private readonly iosKeyValueClientProvider: () => IosPreferenceKeyValueClient | null;
  private readonly plistReader?: Pick<PlistReader, "readXmlFile">;

  constructor(
    private readonly device: BootedDevice,
    dependencies: AppPreferencesDependencies = {},
  ) {
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl;
    this.timer = dependencies.timer ?? defaultTimer;
    this.iosKeyValueClientProvider =
      dependencies.iosKeyValueClientProvider ??
      (() =>
        IOSCtrlProxyClient.getExistingInstance(
          this.device.deviceId,
        )?.getConnectedPreferenceClient() ?? null);
    this.plistReader = dependencies.plistReader;
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
        // Resolve the target user once so the write and its read-back hit the same copy.
        const target = { ...input, userId: await this.resolveAndroidPreferencesUser(input) };
        await this.setAndroidSharedPreference({ ...target, value: normalizedValue });
        return this.verifiedWriteResult(target, normalizedValue, await this.getPreference(target));
      }
    } else {
      const deadlineMs = this.iosDefaultsDeadline();
      const store = await this.setIosUserDefault({ ...input, value: normalizedValue }, deadlineMs);
      // Pin verification to the successful write route: never verify a different store.
      try {
        const readBack = await this.getIosUserDefault(input, deadlineMs, store);
        if (
          !readBack.redacted &&
          readBack.found &&
          !canParsePreferenceValue(String(readBack.value), input.type)
        ) {
          return {
            ...readBack,
            verified: false,
            warning: [
              readBack.warning,
              preferenceWriteWarning(this.device.platform, input.scope, store.kind),
              `The value was written but the effective value read back has a different type (${readBack.type} vs requested ${input.type}), so equality was not verified.`,
            ]
              .filter(Boolean)
              .join(" "),
          };
        }
        return this.verifiedWriteResult(input, normalizedValue, readBack, store);
      } catch (error) {
        throw new ActionableError(
          `iOS UserDefaults write completed but read-back verification failed: ${errorMessage(error)}. The write may have been applied. Read the value on the same route before retrying.`,
          { cause: error },
        );
      }
    }

    const readBack = await this.getPreference(input);
    return this.verifiedWriteResult(input, normalizedValue, readBack);
  }

  private verifiedWriteResult(
    input: SetPreferenceInput,
    normalizedValue: PreferenceValue,
    readBack: PreferenceResult,
    iosStore?: IosPreferenceStore,
  ): PreferenceResult {
    if (readBack.redacted) {
      return {
        ...readBack,
        verified: false,
        warning:
          "The value was written; value redacted by the SDK so not compared. Read-back equality could not be verified.",
      };
    }
    const parsedReadBackValue = readBack.found
      ? parsePreferenceValue(stringValue(readBack.value), input.type)
      : null;
    return {
      ...readBack,
      type: this.device.platform === "ios" ? readBack.type : input.type,
      value:
        this.device.platform === "ios"
          ? readBack.value
          : readBack.found
            ? parsedReadBackValue
            : readBack.value,
      verified:
        readBack.found &&
        (this.device.platform === "android" &&
        input.scope === "sharedPreferences" &&
        input.type === "float"
          ? Math.fround(parsedReadBackValue as number) === Math.fround(normalizedValue as number)
          : valuesEqual(parsedReadBackValue, normalizedValue, input.type)),
      warning: preferenceWriteWarning(this.device.platform, input.scope, iosStore?.kind),
    };
  }

  private validateScope(input: GetPreferenceInput): void {
    if (this.device.platform === "android" && input.scope === "userDefaults") {
      throw new ActionableError("userDefaults scope is only supported on iOS devices.");
    }
    if (this.device.platform === "ios" && input.scope !== "userDefaults") {
      throw new ActionableError(`${input.scope} scope is only supported on Android devices.`);
    }
    if (
      !input.appId &&
      (input.scope === "sharedPreferences" ||
        (input.scope === "userDefaults" && isStandardIosStore(input)))
    ) {
      throw new ActionableError(`appId is required for ${input.scope}.`);
    }
    if (input.userId !== undefined && input.scope !== "sharedPreferences") {
      throw new ActionableError("userId is only supported for Android sharedPreferences.");
    }
  }

  /** Explicit `userId` wins; otherwise user 0 unless the app is only on one other user. */
  private async resolveAndroidPreferencesUser(input: GetPreferenceInput): Promise<number> {
    return input.userId ?? (await resolveDefaultAndroidPreferencesUser(this.adb(), input.appId!));
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
    const userId = await this.resolveAndroidPreferencesUser(input);
    const xml = await readAndroidPreferencesXml(this.adb(), input.appId!, fileName, userId);
    const entry = await readAndroidPreferenceEntry(xml, input.key);
    return {
      ...this.result(input, entry !== null, entry?.value ?? null, entry?.type),
      userId,
    };
  }

  /** `input.userId` must already be resolved by the caller. */
  private async setAndroidSharedPreference(input: SetPreferenceInput): Promise<void> {
    const fileName = androidSharedPreferencesFileName(input);
    await getAndroidSharedPreferencesMutationCoordinator().run(
      this.device.deviceId,
      input.appId!,
      fileName,
      async () => {
        const existingXml = await readAndroidPreferencesXml(
          this.adb(),
          input.appId!,
          fileName,
          input.userId,
        );
        const updatedXml = await writeAndroidPreferenceEntry(
          existingXml,
          input.key,
          input.value,
          input.type,
        );
        await writeAndroidPreferencesXml(
          this.adb(),
          input.appId!,
          fileName,
          updatedXml,
          input.userId,
        );
      },
      input.userId,
    );
  }

  private async getIosUserDefault(
    input: GetPreferenceInput,
    deadlineMs?: number,
    store?: IosPreferenceStore,
  ): Promise<PreferenceResult> {
    if (store) {
      return this.readIosPreferenceStore(input, store, deadlineMs);
    }
    return this.withIosPreferenceStore(
      input,
      (resolved) => this.readIosPreferenceStore(input, resolved, deadlineMs),
      deadlineMs,
    );
  }

  /** Reads may retry a capability/transport miss on disk; dispatched writes never do. */
  private async withIosPreferenceStore<T>(
    input: GetPreferenceInput,
    operation: (store: IosPreferenceStore) => Promise<T>,
    deadlineMs?: number,
    write = false,
  ): Promise<T> {
    if (!isIosSimulatorDevice(this.device)) {
      throw unsupportedPhysicalIosUserDefaultsError();
    }
    const domain = sanitizeIosDefaultsDomain(iosDefaultsDomain(input));
    if (!input.appId) {
      if (domain.startsWith("-")) {
        throw new ActionableError("iOS defaults domain must not start with '-' (a command flag).");
      }
      return operation({ kind: "defaults", store: domain, domain });
    }
    sanitizeIosDefaultsDomain(input.appId);
    const standard = isStandardIosStore(input);
    const store = standard ? "standard" : domain;
    const client = this.iosKeyValueClientProvider();
    if (client?.isConnected()) {
      try {
        return await operation({ kind: "sdk", store, client });
      } catch (error) {
        const detail = errorMessage(error);
        if (detail.includes("mutation_not_authorized")) {
          throw new ActionableError(
            `iOS key-value storage mutation is not authorized: ${IOS_STORAGE_MUTATION_AUTHORIZATION_HINT}`,
          );
        }
        if (write) {
          assertIosPreferenceSdkWriteNotDispatched(error);
        }
        if (!isIosPreferenceSdkUnavailable(error)) {
          throw toActionableError(error, "Failed to access iOS app UserDefaults");
        }
        // A pre-dispatch refusal cannot have written; reads may also retry transport misses.
        logger.debug(`iOS preference SDK unavailable: ${detail}`, error);
      }
    }
    return operation(
      await this.resolveIosContainerPreferenceStore(input, store, domain, deadlineMs, write),
    );
  }

  private async resolveIosContainerPreferenceStore(
    input: GetPreferenceInput,
    store: string,
    domain: string,
    deadlineMs: number | undefined,
    write: boolean,
  ): Promise<IosPreferenceStore> {
    if (store !== "standard" && domain.startsWith("group.")) {
      if (write) {
        throw new ActionableError(
          `${IOS_GROUP_SUITE_WARNING} Connect the app's runner before writing.`,
        );
      }
      return { kind: "container-plist", store, domain, unavailableGroup: true };
    }
    let container: string;
    try {
      const result = await this.iosPreferenceCommand(
        (timeoutMs) =>
          this.getSimctl().executeCommandArgs(
            ["get_app_container", this.device.deviceId, input.appId!, "data"],
            timeoutMs,
          ),
        deadlineMs,
      );
      container = result.stdout.trim();
      if (!container) {
        throw new ActionableError("simctl returned an empty data container path.");
      }
    } catch (error) {
      const detail = errorMessage(error);
      if (
        /Application not found|No such file or directory|NSPOSIXErrorDomain, code=2/i.test(detail)
      ) {
        throw new ActionableError(
          `App '${input.appId}' is not installed on this simulator: ${detail}. Install the app and retry.`,
        );
      }
      throw new ActionableError(
        `Failed to resolve the data container for '${input.appId}': ${detail}. Check simulator availability and retry.`,
        { cause: error },
      );
    }
    return {
      kind: "container-plist",
      store,
      domain: join(container, "Library", "Preferences", domain),
    };
  }

  private async readIosPreferenceStore(
    input: GetPreferenceInput,
    store: IosPreferenceStore,
    deadlineMs?: number,
  ): Promise<PreferenceResult> {
    let result: PreferenceResult;
    if (store.kind === "sdk") {
      const entry = await this.iosPreferenceCommand(
        (timeoutMs) =>
          store.client.getPreference(
            input.appId!,
            iosSdkStoreName(store.store),
            input.key,
            timeoutMs,
          ),
        deadlineMs,
        IOS_PREFERENCE_SDK_TIMEOUT_MS,
      );
      const mapped = entry ? iosSdkPreferenceValue(entry) : null;
      result = {
        ...this.result(input, entry !== null, mapped?.value ?? null, mapped?.type),
        ...mapped,
      };
    } else if (store.kind === "container-plist") {
      result = store.unavailableGroup
        ? { ...this.result(input, false, null), warning: IOS_GROUP_SUITE_WARNING }
        : {
            ...(await this.readIosPreferencePlist(input, store.domain, deadlineMs)),
            warning: IOS_PLIST_READ_WARNING,
          };
    } else {
      result = await this.readIosGlobalDefault(input, deadlineMs);
    }
    return { ...result, resolvedStore: store.store, storeRoute: store.kind };
  }

  private async readIosPreferencePlist(
    input: GetPreferenceInput,
    domain: string,
    deadlineMs?: number,
  ): Promise<PreferenceResult> {
    let xml: string;
    try {
      const reader = this.plistReader ?? new PlistClient(undefined, { timer: this.timer });
      xml = await this.iosPreferenceCommand(
        (timeoutMs) => reader.readXmlFile(`${domain}.plist`, { timeoutMs }),
        deadlineMs,
      );
    } catch (error) {
      if (/No such file|file doesn[’']t exist|file does not exist/i.test(errorMessage(error))) {
        // An app need not have persisted its defaults yet; missing files are normal misses.
        logger.debug(`iOS preference plist not present: ${errorMessage(error)}`, error);
        return this.result(input, false, null);
      }
      throw toActionableError(error, "Failed to read iOS app UserDefaults plist");
    }
    const entry = (await parseIosUserDefaultsPlist(xml)).get(input.key);
    return entry
      ? this.result(input, true, entry.value, entry.type)
      : this.result(input, false, null);
  }

  private async readIosGlobalDefault(
    input: GetPreferenceInput,
    deadlineMs?: number,
  ): Promise<PreferenceResult> {
    const domain = iosDefaultsDomain(input);
    try {
      const result = await this.executeIosDefaultsCommand(
        ["spawn", this.device.deviceId, "defaults", "read", domain, input.key],
        deadlineMs,
      );
      const type = await this.readIosDefaultsType(input, deadlineMs);
      return this.result(input, true, parseIosDefaultsValue(result.stdout, type), type ?? "string");
    } catch (error) {
      if (looksLikeMissingIosDefault(error)) {
        // Missing global keys/domains are expected; give app-suite callers the correct route.
        logger.debug(`iOS global defaults not found: ${errorMessage(error)}`, error);
        return {
          ...this.result(input, false, null),
          warning:
            "UserDefaults suites written by an app live in that app's data container and require appId. The embedded SDK route also requires the AutoMobile SDK with storage inspection enabled.",
        };
      }
      throw toActionableError(error, "Failed to read iOS UserDefaults with defaults");
    }
  }

  private async setIosUserDefault(
    input: SetPreferenceInput,
    deadlineMs: number,
  ): Promise<IosPreferenceStore> {
    return this.withIosPreferenceStore(
      input,
      async (store) => {
        if (store.kind === "sdk") {
          await this.iosPreferenceCommand(
            (timeoutMs) =>
              store.client.setPreference(
                input.appId!,
                iosSdkStoreName(store.store),
                input.key,
                stringValue(input.value),
                IOS_PREFERENCE_WRITE_TYPES[input.type],
                timeoutMs,
              ),
            deadlineMs,
            IOS_PREFERENCE_SDK_TIMEOUT_MS,
          );
        } else {
          await this.executeIosDefaultsCommand(
            [
              "spawn",
              this.device.deviceId,
              "defaults",
              "write",
              store.domain,
              input.key,
              iosDefaultsTypeFlag(input.type),
              stringValue(input.value),
            ],
            deadlineMs,
          );
        }
        return store;
      },
      deadlineMs,
      true,
    );
  }

  private async iosPreferenceCommand<T>(
    operation: (timeoutMs: number) => Promise<T>,
    deadlineMs?: number,
    commandTimeoutMs = IOS_DEFAULTS_COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    const remainingMs = Math.min(
      commandTimeoutMs,
      deadlineMs === undefined ? commandTimeoutMs : deadlineMs - this.timer.now(),
    );
    if (remainingMs <= 0) {
      throw iosDefaultsOperationTimeoutError();
    }
    const operationDeadlineMs = this.timer.now() + remainingMs;
    const timeoutError =
      deadlineMs === undefined || commandTimeoutMs === IOS_PREFERENCE_SDK_TIMEOUT_MS
        ? () =>
            new ActionableError(`iOS UserDefaults request timed out after ${commandTimeoutMs}ms.`)
        : iosDefaultsOperationTimeoutError;
    const value = await raceWithDeadline(
      () => operation(Math.min(IOS_DEFAULTS_COMMAND_TIMEOUT_MS, remainingMs)),
      { timer: this.timer, timeoutMs: remainingMs, label: "iOS UserDefaults", timeoutError },
    );
    if (this.timer.now() >= operationDeadlineMs) {
      throw timeoutError();
    }
    return value;
  }

  private async readIosDefaultsType(
    input: GetPreferenceInput,
    deadlineMs?: number,
  ): Promise<IosPreferenceType | undefined> {
    const domain = iosDefaultsDomain(input);
    try {
      const result = await this.executeIosDefaultsCommand(
        ["spawn", this.device.deviceId, "defaults", "read-type", domain, input.key],
        deadlineMs,
      );
      return parseIosDefaultsType(result.stdout);
    } catch (error) {
      // This auxiliary type probe must not discard a successfully-read value.
      // Returning undefined lets callers fall back to the string representation.
      if (looksLikeMissingIosDefault(error)) {
        logger.debug(
          `src/features/preferences/AppPreferences.ts defaults type read found no value: ${error}`,
          error,
        );
        return undefined;
      }
      if (deadlineMs !== undefined && this.timer.now() >= deadlineMs) {
        throw toActionableError(error, "iOS defaults type read exceeded the operation deadline");
      }
      if (!isRetryableIosDefaultsError(error)) {
        throw toActionableError(error, "Failed to read iOS UserDefaults type with defaults");
      }
      logger.warn(
        `src/features/preferences/AppPreferences.ts defaults type read failed; falling back to string: ${error}`,
        error,
      );
      return undefined;
    }
  }

  private iosDefaultsDeadline(): number {
    return this.timer.now() + IOS_DEFAULTS_OPERATION_TIMEOUT_MS;
  }

  private async executeIosDefaultsCommand(
    args: string[],
    deadlineMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    let finalError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs =
        deadlineMs === undefined ? IOS_DEFAULTS_COMMAND_TIMEOUT_MS : deadlineMs - this.timer.now();
      if (remainingMs <= 0) {
        if (finalError) {
          throw finalError;
        }
        throw iosDefaultsOperationTimeoutError();
      }

      try {
        return await this.getSimctl().executeCommandArgs(
          args,
          Math.min(IOS_DEFAULTS_COMMAND_TIMEOUT_MS, remainingMs),
        );
      } catch (error) {
        finalError = error;
        if (attempt === 1 || !isRetryableIosDefaultsError(error)) {
          throw toActionableError(
            error,
            "Failed to execute iOS defaults command; check simulator availability and retry",
          );
        }
        logger.warn(
          `Retrying iOS defaults command after transient failure: ${errorMessage(error)}`,
          error,
        );
      }
    }

    throw toActionableError(finalError, "Failed to execute iOS defaults command");
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

async function writeAndroidPreferenceEntry(
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

const IOS_PREFERENCE_WRITE_TYPES: Record<PreferenceValueType, KeyValueType> = {
  string: "STRING",
  int: "INT",
  bool: "BOOLEAN",
  float: "FLOAT",
};

function iosSdkStoreName(store: string): string {
  return store === "standard" ? "Standard" : store;
}

/** A dispatched or ambiguous SDK write must never be retried through the container. */
function assertIosPreferenceSdkWriteNotDispatched(error: unknown): void {
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

function iosSdkPreferenceValue(
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

function isStandardIosStore(input: GetPreferenceInput): boolean {
  const suite = input.suite?.trim().toLowerCase();
  return !suite || suite === "standard" || (!!input.appId && suite === input.appId.toLowerCase());
}

function iosDefaultsDomain(input: GetPreferenceInput): string {
  return isStandardIosStore(input) ? input.appId! : sanitizeIosDefaultsDomain(input.suite!);
}

function sanitizeIosDefaultsDomain(suite: string): string {
  // A defaults domain must be an identifier, never a plist path.
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(suite)) {
    throw new ActionableError(
      "iOS UserDefaults suite must be an identifier using letters, numbers, underscore, dash, or dot, without path separators or empty path segments.",
    );
  }
  return suite;
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

function canParsePreferenceValue(value: string, type: PreferenceValueType): boolean {
  try {
    parsePreferenceValue(value, type);
    return true;
  } catch (error) {
    // An effective-value override may be incompatible with the requested write type.
    logger.debug("Preference read-back cannot be parsed as the requested type", error);
    return false;
  }
}

function parseIosDefaultsValue(
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

function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n") || value.endsWith("\r")) {
    return value.slice(0, -1);
  }
  return value;
}

function parseIosDefaultsType(value: string): IosPreferenceType | undefined {
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

function stringValue(value: PreferenceResultValue | null): string {
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

function looksLikeMissingIosDefault(error: unknown): boolean {
  const message = errorMessage(error).trim();
  return [
    /The domain\/default pair of \([^)]+\) does not exist\.?$/i,
    /Domain [^\n]+ does not exist\.?$/i,
    /Domain [^\n]+ not found\.?$/i,
    /Domain [^\n]+ does not contain (?:a value for )?[^\n]+\.?$/i,
  ].some((pattern) => pattern.test(message));
}

function isRetryableIosDefaultsError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /timed out/i.test(message) ||
    /Failed to connect to (?:the )?CoreSimulator service/i.test(message) ||
    /CoreSimulatorService connection (?:refused|reset|interrupted|invalidated)/i.test(message) ||
    /connection (?:refused|reset|interrupted|invalidated)/i.test(message) ||
    /Unable to lookup in current state: Booting/i.test(message)
  );
}

function iosDefaultsOperationTimeoutError(): ActionableError {
  return new ActionableError(
    `iOS UserDefaults preference operation timed out after ${IOS_DEFAULTS_OPERATION_TIMEOUT_MS}ms.`,
  );
}

function preferenceWriteWarning(
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

function unsupportedPhysicalIosUserDefaultsError(): ActionableError {
  return new ActionableError(
    "iOS physical devices are not supported for UserDefaults preferences yet. " +
      "The available CtrlProxy storage APIs run in the runner process and cannot safely read or write another app's UserDefaults sandbox. " +
      "Use an iOS Simulator for UserDefaults automation.",
  );
}
