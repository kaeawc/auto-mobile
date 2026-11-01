import {
  resolveOwnAppDataContainer,
  SimulatorContainerOwnershipError,
  SimulatorContainerUnresolvedError,
  type SimulatorContainerOwnershipOptions,
} from "../../utils/ios-cmdline-tools/simulatorOwnContainer";
import { type IosPreferenceType } from "./IosPreferenceTypes";
import { parseIosUserDefaultsPlist } from "./IosUserDefaultsPlist";
import { join } from "node:path";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import { PlistClient, type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { toActionableError } from "../../models/ActionableError";
import { IOS_STORAGE_MUTATION_AUTHORIZATION_HINT } from "../../utils/storageSdkErrors";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { shellQuoteUnlessSafe } from "../../utils/shellQuote";
import type { AndroidOrIosPlatform, BootedDevice } from "../../models";
import { ActionableError, requireAndroidOrIosPlatform } from "../../models";
import { findIosSimulatorAppProcess } from "../action/CrashApp";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { readAndroidPreferencesXml, writeAndroidPreferencesXml } from "./AndroidPreferencesXmlFile";
import { resolveDefaultAndroidPreferencesUser } from "./resolveAndroidPreferencesUser";
import { getAndroidSharedPreferencesMutationCoordinator } from "./AndroidSharedPreferencesMutationCoordinator";
import {
  PREFERENCE_READ_ATTEMPTS,
  PreferenceResultType,
  PreferenceValue,
  PreferenceResultValue,
  GetPreferenceInput,
  SetPreferenceInput,
  PreferenceResult,
  IosSimulatorPreferenceClient,
  IosPreferenceKeyValueClient,
  IosPreferenceStore,
  AppPreferencesDependencies,
  IOS_PREFERENCE_SDK_TIMEOUT_MS,
  IOS_PROCESS_PROBE_TIMEOUT_MS,
  IOS_RUNNER_FOREGROUND_GATE_PATTERN,
  IOS_PLIST_READ_WARNING,
  IOS_GROUP_SUITE_WARNING,
  IOS_DEFAULTS_COMMAND_TIMEOUT_MS,
  IOS_DEFAULTS_OPERATION_TIMEOUT_MS,
  androidSharedPreferencesFileName,
  readAndroidPreferenceEntry,
  writeAndroidPreferenceEntry,
  IOS_PREFERENCE_WRITE_TYPES,
  iosSdkStoreName,
  assertIosPreferenceSdkWriteNotDispatched,
  isIosPreferenceSdkUnavailable,
  iosSdkPreferenceValue,
  isStandardIosStore,
  iosDefaultsDomain,
  sanitizeIosDefaultsDomain,
  iosDefaultsTypeFlag,
  normalizeValueForType,
  parsePreferenceValue,
  canParsePreferenceValue,
  parseIosDefaultsValue,
  removeOneTrailingLineEnding,
  parseIosDefaultsType,
  stringValue,
  valuesEqual,
  looksLikeMissingIosDefault,
  isRetryableIosDefaultsError,
  iosDefaultsOperationTimeoutError,
  iosPreferenceCommandTimeoutError,
  isMissingIosAppError,
  preferenceWriteWarning,
  physicalIosUserDefaultsRequireSdkError,
} from "./preferenceValues";
export {
  type PreferenceValueType,
  type PreferenceResultType,
  type PreferenceValue,
  type PreferenceResultValue,
  type GetPreferenceInput,
  type SetPreferenceInput,
  type PreferenceResult,
  type IosPreferenceKeyValueClient,
  type AppPreferencesDependencies,
  readAndroidStorageEntries,
  isIosPreferenceSdkNotDispatched,
  isIosPreferenceSdkUnavailable,
  isIosSdkEntryRedacted,
} from "./preferenceValues";

export class AppPreferences {
  private readonly containerOwnership: SimulatorContainerOwnershipOptions;
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
    this.containerOwnership = dependencies.containerOwnership ?? {};
    this.timer = dependencies.timer ?? defaultTimer;
    this.iosKeyValueClientProvider =
      dependencies.iosKeyValueClientProvider ??
      (() =>
        IOSCtrlProxyClient.getExistingInstance(
          this.device.deviceId,
        )?.getConnectedPreferenceClient() ?? null);
    this.plistReader = dependencies.plistReader;
  }

  /** Every preference route is Android or iOS; a watch fails before any branch picks one. */
  private get platform(): AndroidOrIosPlatform {
    return requireAndroidOrIosPlatform(this.device.platform, "Preference access");
  }

  async getPreference(input: GetPreferenceInput): Promise<PreferenceResult> {
    this.validateScope(input);

    if (this.platform === "android") {
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

    if (this.platform === "android") {
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
              preferenceWriteWarning(this.platform, input.scope, store.kind),
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
      type: this.platform === "ios" ? readBack.type : input.type,
      value:
        this.platform === "ios"
          ? readBack.value
          : readBack.found
            ? parsedReadBackValue
            : readBack.value,
      verified:
        readBack.found &&
        (this.platform === "android" &&
        input.scope === "sharedPreferences" &&
        input.type === "float"
          ? Math.fround(parsedReadBackValue as number) === Math.fround(normalizedValue as number)
          : valuesEqual(parsedReadBackValue, normalizedValue, input.type)),
      warning: preferenceWriteWarning(this.platform, input.scope, iosStore?.kind),
    };
  }

  private validateScope(input: GetPreferenceInput): void {
    if (this.platform === "android" && input.scope === "userDefaults") {
      throw new ActionableError("userDefaults scope is only supported on iOS devices.");
    }
    if (this.platform === "ios" && input.scope !== "userDefaults") {
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
      {
        mutation: async () => {
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
          await writeAndroidPreferencesXml(this.adb(), input.appId!, fileName, {
            xml: updatedXml,
            userId: input.userId,
          });
        },
        userId: input.userId,
      },
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
      return this.withPhysicalIosSdkPreferenceStore(input, operation);
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
        await this.assertIosSdkFailureAllowsContainerFallback(error, input.appId, write);
      }
    }
    return operation(
      await this.resolveIosContainerPreferenceStore(input, store, domain, { deadlineMs, write }),
    );
  }

  /**
   * Physical iOS (#14093): the app's own embedded SDK is the only route to its UserDefaults. There
   * is no container plist or `defaults` fallback on hardware, so an SDK failure is final and a write
   * is attempted at most once.
   */
  private async withPhysicalIosSdkPreferenceStore<T>(
    input: GetPreferenceInput,
    operation: (store: IosPreferenceStore) => Promise<T>,
  ): Promise<T> {
    if (!input.appId) {
      throw physicalIosUserDefaultsRequireSdkError("appId is required on physical devices.");
    }
    const domain = sanitizeIosDefaultsDomain(iosDefaultsDomain(input));
    sanitizeIosDefaultsDomain(input.appId);
    const client = this.iosKeyValueClientProvider();
    if (!client?.isConnected()) {
      throw physicalIosUserDefaultsRequireSdkError(
        `No embedded AutoMobile SDK connection is open for '${input.appId}'.`,
      );
    }
    try {
      return await operation({
        kind: "sdk",
        store: isStandardIosStore(input) ? "standard" : domain,
        client,
      });
    } catch (error) {
      if (errorMessage(error).includes("mutation_not_authorized")) {
        throw new ActionableError(
          `iOS key-value storage mutation is not authorized: ${IOS_STORAGE_MUTATION_AUTHORIZATION_HINT}`,
        );
      }
      throw toActionableError(error, "Failed to access iOS app UserDefaults through the SDK");
    }
  }

  /** Throws unless the SDK failure may be retried through the container plist. */
  private async assertIosSdkFailureAllowsContainerFallback(
    error: unknown,
    appId: string,
    write: boolean,
  ): Promise<void> {
    const detail = errorMessage(error);
    if (detail.includes("mutation_not_authorized")) {
      throw new ActionableError(
        `iOS key-value storage mutation is not authorized: ${IOS_STORAGE_MUTATION_AUTHORIZATION_HINT}`,
      );
    }
    if (write && (await this.isIosForegroundRefusalForStoppedApp(error, appId))) {
      // The runner refused before dispatch and the app has no process, so there is
      // no in-memory copy to clobber: seeding the container plist is safe (#10794).
      logger.debug(`iOS preference write seeding container for stopped app: ${detail}`);
      return;
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

  /**
   * True only for the runner's pre-dispatch foreground gate when the app has no
   * simulator process at all. A backgrounded (running) app keeps its refusal, and
   * an unanswerable process probe fails closed.
   */
  private async isIosForegroundRefusalForStoppedApp(
    error: unknown,
    appId: string,
  ): Promise<boolean> {
    if (!IOS_RUNNER_FOREGROUND_GATE_PATTERN.test(errorMessage(error))) {
      return false;
    }
    try {
      const processList = await this.getSimctl().executeCommandArgs(
        ["spawn", this.device.deviceId, "launchctl", "list"],
        IOS_PROCESS_PROBE_TIMEOUT_MS,
      );
      return findIosSimulatorAppProcess(processList.stdout, appId) === null;
    } catch (probeError) {
      logger.warn(`iOS app process probe failed: ${errorMessage(probeError)}`, probeError);
      return false;
    }
  }

  private async resolveIosContainerPreferenceStore(
    input: GetPreferenceInput,
    store: string,
    domain: string,
    { deadlineMs, write }: { deadlineMs?: number; write: boolean },
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
      container = await this.lookupIosDataContainer(input.appId!, deadlineMs);
    } catch (error) {
      if (error instanceof SimulatorContainerOwnershipError) {
        throw error;
      }
      const detail =
        error instanceof SimulatorContainerUnresolvedError
          ? "simctl returned an empty data container path"
          : errorMessage(error);
      if (isMissingIosAppError(detail)) {
        throw new ActionableError(
          `App '${input.appId}' is not installed on this simulator: ${detail}. Install the app and retry.`,
        );
      }
      // The container is resolved before `defaults write` runs, so a failed write here wrote nothing.
      const unwritten = write ? " Nothing was written, so the write can be retried safely." : "";
      throw new ActionableError(
        `Failed to resolve the data container for '${input.appId}': ${detail}.${unwritten} Check simulator availability and retry.`,
        { cause: error },
      );
    }
    return {
      kind: "container-plist",
      store,
      domain: join(container, "Library", "Preferences", domain),
    };
  }

  /**
   * `get_app_container` is a read-only, idempotent lookup, so it gets the `defaults` commands' bounded
   * retry (#14683): one more attempt on a timeout or a transient CoreSimulator error while the
   * operation budget lasts. A missing app is never retried.
   */
  private async lookupIosDataContainer(
    appId: string,
    deadlineMs: number | undefined,
  ): Promise<string> {
    return resolveOwnAppDataContainer({
      ...this.containerOwnership,
      deviceId: this.device.deviceId,
      bundleId: appId,
      run: (args) => this.lookupIosDataContainerCommand(args, deadlineMs),
    });
  }

  private async lookupIosDataContainerCommand(args: string[], deadlineMs: number | undefined) {
    const lookup = () =>
      this.iosPreferenceCommand(
        (timeoutMs) => this.getSimctl().executeCommandArgs(args, timeoutMs),
        deadlineMs,
        IOS_DEFAULTS_COMMAND_TIMEOUT_MS,
        args[0]!,
      );
    for (let attempt = 1; attempt < PREFERENCE_READ_ATTEMPTS; attempt += 1) {
      try {
        return await lookup();
      } catch (error) {
        const budgetLeft = deadlineMs === undefined || this.timer.now() < deadlineMs;
        const retryable = isRetryableIosDefaultsError(error);
        if (!budgetLeft || !retryable || isMissingIosAppError(errorMessage(error))) {
          throw error;
        }
        logger.warn(
          `Retrying app container lookup after transient failure: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return lookup();
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
        IOS_DEFAULTS_COMMAND_TIMEOUT_MS,
        "UserDefaults plist read",
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
                {
                  key: input.key,
                  value: stringValue(input.value),
                  type: IOS_PREFERENCE_WRITE_TYPES[input.type],
                },
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
    command = "UserDefaults request",
  ): Promise<T> {
    const budgetMs = deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    const remainingMs = Math.min(commandTimeoutMs, budgetMs ?? commandTimeoutMs);
    if (remainingMs <= 0) {
      throw iosDefaultsOperationTimeoutError();
    }
    const operationDeadlineMs = this.timer.now() + remainingMs;
    const timeoutError = iosPreferenceCommandTimeoutError(command, commandTimeoutMs, budgetMs);
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

    for (let attempt = 0; attempt < PREFERENCE_READ_ATTEMPTS; attempt += 1) {
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
        if (attempt === PREFERENCE_READ_ATTEMPTS - 1 || !isRetryableIosDefaultsError(error)) {
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
      platform: this.platform,
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
