import { errorMessage } from "../utils/describeUnknownError";
import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import {
  addDeviceTargetingToSchema,
  withAppIdAliases,
  withPostFlattenJsonSchemaOverride,
} from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { ResourceRegistry } from "./resourceRegistry";
import type { KeyValueType, PreferenceStoreResolution } from "../features/storage/storageTypes";
import { IOS_STORAGE_MUTATION_AUTHORIZATION_HINT } from "./storageSdkErrors";
import {
  clearAndroidKeyValueFileDirect,
  dataStoreInspectionDisabledReason,
  directFileFallbackRelaunchWarning,
  isSharedPreferencesInspectionDisabledError,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
  withAndroidSharedPreferencesInspectionFallback,
  type SharedPreferencesInspectionFallbackResult,
} from "../features/storage/AndroidSharedPreferencesKeyValueFile";

/** The subset of AndroidCtrlProxyClient the key-value tool handlers depend on. */
export interface AndroidKeyValueClient {
  setPreference(
    appId: string,
    fileName: string,
    key: string,
    value: string,
    type: KeyValueType,
  ): Promise<void>;
  removePreference(appId: string, fileName: string, key: string): Promise<void>;
  clearPreferenceStore(appId: string, fileName: string): Promise<void>;
  listDataStores(appId: string, adapterName: string): Promise<unknown>;
  getDataStore(appId: string, adapterName: string, name: string): Promise<unknown>;
}

/** The subset of IOSCtrlProxyClient the key-value tool handlers depend on. */
export interface IosKeyValueClient {
  setPreference(
    appId: string,
    fileName: string,
    key: string,
    value: string,
    type: KeyValueType,
  ): Promise<PreferenceStoreResolution | void>;
  removePreference(
    appId: string,
    fileName: string,
    key: string,
  ): Promise<PreferenceStoreResolution | void>;
  clearPreferenceStore(appId: string, fileName: string): Promise<PreferenceStoreResolution | void>;
}

export interface StorageToolsDependencies {
  androidClientFactory: (device: BootedDevice) => AndroidKeyValueClient;
  iosClientFactory: (device: BootedDevice) => IosKeyValueClient;
  adbClientFactory: AdbClientFactory;
}

let storageToolsDependencies: StorageToolsDependencies | null = null;

function getStorageToolsDependencies(): StorageToolsDependencies {
  if (!storageToolsDependencies) {
    storageToolsDependencies = {
      androidClientFactory: (device) =>
        AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory),
      iosClientFactory: (device) => IOSCtrlProxyClient.getInstance(device),
      adbClientFactory: defaultAdbClientFactory,
    };
  }
  return storageToolsDependencies;
}

function actionableStorageWriteError(error: unknown, context: string): ActionableError {
  if (errorMessage(error).includes("mutation_not_authorized")) {
    return new ActionableError(`${context}: ${IOS_STORAGE_MUTATION_AUTHORIZATION_HINT}`, {
      cause: error,
    });
  }
  return toActionableError(error, context);
}

/** Test-only seam: inject fakes for the Android/iOS storage clients and adb factory. */
export function setStorageToolsDependenciesForTesting(
  overrides: Partial<StorageToolsDependencies>,
): void {
  storageToolsDependencies = { ...getStorageToolsDependencies(), ...overrides };
}

export function resetStorageToolsDependencies(): void {
  storageToolsDependencies = null;
}

// Valid types for key-value storage (union of Android and iOS types)
const KEY_VALUE_TYPES = [
  "STRING",
  "INT",
  "LONG",
  "FLOAT",
  "DOUBLE",
  "BOOLEAN",
  "STRING_SET",
  "DATA",
  "DATE",
  "ARRAY",
  "DICTIONARY",
  "UNKNOWN",
] as const;

// Types only valid on Android
const ANDROID_ONLY_TYPES = new Set<string>(["LONG", "STRING_SET"]);

// Types only valid on iOS
const IOS_ONLY_TYPES = new Set<string>(["DOUBLE", "DATA", "DATE", "ARRAY", "DICTIONARY"]);

// Guidance messages for cross-platform type errors
const TYPE_GUIDANCE: Record<string, string> = {
  // Android-only types on iOS
  "ios:LONG": "LONG is Android-only. On iOS, use INT for integer values.",
  "ios:STRING_SET": "STRING_SET is Android-only. On iOS, use ARRAY for collections of strings.",
  // iOS-only types on Android
  "android:DOUBLE": "DOUBLE is iOS-only. On Android, use FLOAT for decimal values.",
  "android:DATA":
    "DATA is iOS-only and stores raw binary data (base64 encoded). Not available on Android.",
  "android:DATE":
    "DATE is iOS-only and stores ISO 8601 date strings. On Android, store dates as STRING or LONG (epoch millis).",
  "android:ARRAY":
    "ARRAY is iOS-only. On Android, use STRING_SET for string collections, or store JSON as STRING.",
  "android:DICTIONARY": "DICTIONARY is iOS-only. On Android, store JSON objects as STRING.",
};

const STORAGE_NAME_DESCRIPTION =
  'Storage name. iOS: empty string, "standard" (any case) or the app bundle id select the app\'s standard UserDefaults; any other value is a UserDefaults suite name (e.g. an app group) and must be a valid suite with no leading or trailing whitespace. Android: SharedPreferences file name without the .xml extension (letters, digits, underscore, dash, dot).';

const ADAPTER_NAME_DESCRIPTION =
  "Name the host app registered its DataStore adapter under (AutoMobile SDK)";

// listDataStores: enumerate the DataStore instances exposed by a host-registered adapter (Android).
const listDataStoresSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        adapterName: z.string().describe(ADAPTER_NAME_DESCRIPTION),
      })
      .strict(),
  ),
);

interface ListDataStoresArgs {
  appId: string;
  adapterName: string;
}

// getDataStore: read all entries from a named DataStore instance (Android).
const getDataStoreSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        adapterName: z.string().describe(ADAPTER_NAME_DESCRIPTION),
        name: z.string().describe("DataStore instance name"),
      })
      .strict(),
  ),
);

interface GetDataStoreArgs {
  appId: string;
  adapterName: string;
  name: string;
}

const legacyFileNameDescription = "Deprecated alias for name";
const storageNameRequiredMessage =
  "Provide either `name` (iOS UserDefaults suite / Android SharedPreferences name) or `fileName`";

function requireStorageName<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((args, ctx) => {
    const hasName =
      typeof args === "object" && args !== null && "name" in args && args.name !== undefined;
    const hasFileName =
      typeof args === "object" &&
      args !== null &&
      "fileName" in args &&
      args.fileName !== undefined;
    if (!hasName && !hasFileName) {
      ctx.addIssue({ code: "custom", message: storageNameRequiredMessage });
    }
  });
}

function advertiseStorageNameRequirement<T extends z.ZodTypeAny>(schema: T): T {
  return withPostFlattenJsonSchemaOverride(schema, (jsonSchema) => {
    jsonSchema.description = storageNameRequiredMessage;
  });
}

const userIdSchema = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "Android only: user whose copy of the app the direct-file (run-as) fallback edits (e.g. a work profile). Defaults to user 0 when the app is installed for it; otherwise to the one other running user that has it (an error asks for userId if several do). The SDK route is not user-scoped.",
  );

/** Android-only input: a `userId` on an iOS device would be silently ignored, so reject it. */
function assertUserIdSupported(device: BootedDevice, userId: number | undefined): void {
  if (userId !== undefined && device.platform !== "android") {
    throw new ActionableError("userId is only supported for Android devices.");
  }
}

function resolveStorageName(args: { name?: string; fileName?: string }): string {
  return args.name ?? args.fileName!;
}

// Schema for setKeyValue tool
const setKeyValueSchema = advertiseStorageNameRequirement(
  withAppIdAliases(
    requireStorageName(
      addDeviceTargetingToSchema(
        z
          .object({
            appId: z.string(),
            name: z.string().optional().describe(STORAGE_NAME_DESCRIPTION),
            fileName: z.string().optional().describe(legacyFileNameDescription),
            key: z.string().describe("Key"),
            value: z
              .union([z.string(), z.number(), z.boolean()])
              .nullable()
              .describe("Value; null clears"),
            type: z.enum(KEY_VALUE_TYPES).describe("Value type"),
            userId: userIdSchema,
          })
          .strict(),
      ),
    ),
  ),
);

// Schema for removeKeyValue tool
const removeKeyValueSchema = advertiseStorageNameRequirement(
  withAppIdAliases(
    requireStorageName(
      addDeviceTargetingToSchema(
        z
          .object({
            appId: z.string(),
            name: z.string().optional().describe(STORAGE_NAME_DESCRIPTION),
            fileName: z.string().optional().describe(legacyFileNameDescription),
            key: z.string().describe("Key"),
            userId: userIdSchema,
          })
          .strict(),
      ),
    ),
  ),
);

// Schema for clearKeyValueFile tool
const clearKeyValueFileSchema = advertiseStorageNameRequirement(
  withAppIdAliases(
    requireStorageName(
      addDeviceTargetingToSchema(
        z
          .object({
            appId: z.string(),
            name: z.string().optional().describe(STORAGE_NAME_DESCRIPTION),
            fileName: z.string().optional().describe(legacyFileNameDescription),
            userId: userIdSchema,
          })
          .strict(),
      ),
    ),
  ),
);

interface SetKeyValueArgs {
  appId: string;
  name?: string;
  fileName?: string;
  key: string;
  value: string | number | boolean | null;
  type: KeyValueType;
  userId?: number;
}

interface RemoveKeyValueArgs {
  appId: string;
  name?: string;
  fileName?: string;
  key: string;
  userId?: number;
}

interface ClearKeyValueFileArgs {
  appId: string;
  name?: string;
  fileName?: string;
  userId?: number;
}

/**
 * Build resource URI for storage entries (mirrors storageResources.ts)
 */
function buildEntriesUri(deviceId: string, packageName: string, fileName: string): string {
  return `automobile:devices/${deviceId}/storage/${encodeURIComponent(packageName)}/${encodeURIComponent(fileName)}/entries`;
}

/**
 * DataStore (unlike SharedPreferences) has no on-device XML file to fall back to — it is
 * only reachable through the host app's registered adapter — so a disabled inspection
 * capability is a genuine dead end here. Say what enables it (issue #6292 requirement 3)
 * instead of surfacing the SDK's bare "SharedPreferences inspection is disabled".
 */
function dataStoreInspectionDisabledError(appId: string): ActionableError {
  return new ActionableError(dataStoreInspectionDisabledReason(appId));
}

/**
 * Wraps {@link withAndroidSharedPreferencesInspectionFallback} for the MCP-tool handlers,
 * binding the lazily-created adb client to the injected `adbClientFactory` seam so the
 * direct-file fallback stays test-injectable and no adb client is created on the happy path.
 * The desktop `ide/*` daemon-socket routes call the shared helper directly with their own
 * adb factory (`socketServer.ts`), so both mutation entry points share one fallback path.
 */
function withSharedPreferencesInspectionFallback(
  device: BootedDevice,
  appId: string,
  fileName: string,
  viaSdk: () => Promise<void>,
  viaDirectFile: (adb: ReturnType<AdbClientFactory["create"]>) => Promise<void>,
): Promise<SharedPreferencesInspectionFallbackResult> {
  return withAndroidSharedPreferencesInspectionFallback(
    appId,
    fileName,
    () => getStorageToolsDependencies().adbClientFactory.create(device),
    viaSdk,
    viaDirectFile,
  );
}

/**
 * Validate that the type is supported on the given platform. Throws ActionableError with guidance if not.
 *
 * Exported so the daemon `ide/*` socket key-value handlers can enforce the same
 * cross-platform type guidance as the MCP-tool path, without duplicating the
 * platform-specific type sets (issue #5022).
 */
export function validateTypeForPlatform(platform: string, type: KeyValueType): void {
  if (type === "UNKNOWN") {
    throw new ActionableError(
      "UNKNOWN type is read-only and cannot be used for write operations. " +
        "Specify an explicit type (STRING, INT, BOOLEAN, etc.).",
    );
  }

  if (platform === "ios" && ANDROID_ONLY_TYPES.has(type)) {
    const guidance = TYPE_GUIDANCE[`ios:${type}`] || `${type} is not supported on iOS.`;
    throw new ActionableError(guidance);
  }

  if (platform === "android" && IOS_ONLY_TYPES.has(type)) {
    const guidance = TYPE_GUIDANCE[`android:${type}`] || `${type} is not supported on Android.`;
    throw new ActionableError(guidance);
  }
}

/** @internal Preserve any existing warning before adding the set-only override guidance. */
export function preferenceSetWarning(
  existingWarning: string | undefined,
  effectiveValueDiffers?: boolean,
): string | undefined {
  return (
    [
      existingWarning,
      effectiveValueDiffers === true
        ? "The value was written to the app's persistent store but the effective value read by the app differs (for example a launch argument, managed configuration or other override). The write persisted."
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

// setKeyValue handler
async function setKeyValueHandler(device: BootedDevice, args: SetKeyValueArgs) {
  try {
    const storageName = resolveStorageName(args);
    assertUserIdSupported(device, args.userId);
    const value = args.value === null ? null : String(args.value);
    if (value !== null) {
      validateTypeForPlatform(device.platform, args.type);
    }

    let usedDirectFileFallback = false;
    let resolvedStore: string | undefined;
    let effectiveValueDiffers: boolean | undefined;
    if (device.platform === "android") {
      const client = getStorageToolsDependencies().androidClientFactory(device);
      ({ usedDirectFileFallback } = await withSharedPreferencesInspectionFallback(
        device,
        args.appId,
        storageName,
        () =>
          value === null
            ? client.removePreference(args.appId, storageName, args.key)
            : client.setPreference(args.appId, storageName, args.key, value, args.type),
        (adb) =>
          value === null
            ? removeAndroidKeyValueDirect(
                adb,
                device.deviceId,
                args.appId,
                storageName,
                args.key,
                args.userId,
              )
            : setAndroidKeyValueDirect(
                adb,
                device.deviceId,
                args.appId,
                storageName,
                args.key,
                value,
                args.type,
                args.userId,
              ),
      ));
    } else if (device.platform === "ios") {
      const client = getStorageToolsDependencies().iosClientFactory(device);
      if (value === null) {
        resolvedStore = (await client.removePreference(args.appId, storageName, args.key))
          ?.resolvedStore;
      } else {
        const result = await client.setPreference(
          args.appId,
          storageName,
          args.key,
          value,
          args.type,
        );
        resolvedStore = result?.resolvedStore;
        effectiveValueDiffers = result?.effectiveValueDiffers;
      }
    } else {
      throw new ActionableError(`Unsupported platform: ${device.platform}`);
    }

    // Notify subscribers that entries changed so they re-read fresh data
    void ResourceRegistry.notifyResourceUpdated(
      buildEntriesUri(device.deviceId, args.appId, storageName),
    );

    const warning = preferenceSetWarning(
      usedDirectFileFallback
        ? directFileFallbackRelaunchWarning(args.appId, storageName)
        : undefined,
      effectiveValueDiffers,
    );
    return createJSONToolResponse({
      success: true,
      appId: args.appId,
      name: storageName,
      resolvedStore,
      key: args.key,
      type: args.type,
      effectiveValueDiffers,
      warning,
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw actionableStorageWriteError(error, `Failed to set key-value entry`);
  }
}

// removeKeyValue handler
async function removeKeyValueHandler(device: BootedDevice, args: RemoveKeyValueArgs) {
  try {
    const storageName = resolveStorageName(args);
    assertUserIdSupported(device, args.userId);
    let usedDirectFileFallback = false;
    let resolvedStore: string | undefined;
    if (device.platform === "android") {
      const client = getStorageToolsDependencies().androidClientFactory(device);
      ({ usedDirectFileFallback } = await withSharedPreferencesInspectionFallback(
        device,
        args.appId,
        storageName,
        () => client.removePreference(args.appId, storageName, args.key),
        (adb) =>
          removeAndroidKeyValueDirect(
            adb,
            device.deviceId,
            args.appId,
            storageName,
            args.key,
            args.userId,
          ),
      ));
    } else if (device.platform === "ios") {
      const client = getStorageToolsDependencies().iosClientFactory(device);
      resolvedStore = (await client.removePreference(args.appId, storageName, args.key))
        ?.resolvedStore;
    } else {
      throw new ActionableError(`Unsupported platform: ${device.platform}`);
    }

    void ResourceRegistry.notifyResourceUpdated(
      buildEntriesUri(device.deviceId, args.appId, storageName),
    );

    return createJSONToolResponse({
      success: true,
      appId: args.appId,
      name: storageName,
      ...(resolvedStore ? { resolvedStore } : {}),
      key: args.key,
      ...(usedDirectFileFallback
        ? { warning: directFileFallbackRelaunchWarning(args.appId, storageName) }
        : {}),
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw actionableStorageWriteError(error, `Failed to remove key-value entry`);
  }
}

// clearKeyValueFile handler
async function clearKeyValueFileHandler(device: BootedDevice, args: ClearKeyValueFileArgs) {
  try {
    const storageName = resolveStorageName(args);
    assertUserIdSupported(device, args.userId);
    let usedDirectFileFallback = false;
    let resolvedStore: string | undefined;
    if (device.platform === "android") {
      const client = getStorageToolsDependencies().androidClientFactory(device);
      ({ usedDirectFileFallback } = await withSharedPreferencesInspectionFallback(
        device,
        args.appId,
        storageName,
        () => client.clearPreferenceStore(args.appId, storageName),
        (adb) =>
          clearAndroidKeyValueFileDirect(
            adb,
            device.deviceId,
            args.appId,
            storageName,
            args.userId,
          ),
      ));
    } else if (device.platform === "ios") {
      const client = getStorageToolsDependencies().iosClientFactory(device);
      resolvedStore = (await client.clearPreferenceStore(args.appId, storageName))?.resolvedStore;
    } else {
      throw new ActionableError(`Unsupported platform: ${device.platform}`);
    }

    void ResourceRegistry.notifyResourceUpdated(
      buildEntriesUri(device.deviceId, args.appId, storageName),
    );

    return createJSONToolResponse({
      success: true,
      appId: args.appId,
      name: storageName,
      ...(resolvedStore ? { resolvedStore } : {}),
      ...(usedDirectFileFallback
        ? { warning: directFileFallbackRelaunchWarning(args.appId, storageName) }
        : {}),
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw toActionableError(error, `Failed to clear key-value file`);
  }
}

// listDataStores handler — Android-only (Jetpack DataStore has no iOS analog).
async function listDataStoresHandler(device: BootedDevice, args: ListDataStoresArgs) {
  if (device.platform !== "android") {
    throw new ActionableError(
      `listDataStores is Android-only; DataStore is not available on ${device.platform}.`,
    );
  }
  try {
    const client = getStorageToolsDependencies().androidClientFactory(device);
    const stores = await client.listDataStores(args.appId, args.adapterName);
    return createJSONToolResponse({
      success: true,
      appId: args.appId,
      adapterName: args.adapterName,
      stores,
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    if (isSharedPreferencesInspectionDisabledError(error)) {
      throw dataStoreInspectionDisabledError(args.appId);
    }
    throw toActionableError(error, `Failed to list data stores`);
  }
}

// getDataStore handler — Android-only.
async function getDataStoreHandler(device: BootedDevice, args: GetDataStoreArgs) {
  if (device.platform !== "android") {
    throw new ActionableError(
      `getDataStore is Android-only; DataStore is not available on ${device.platform}.`,
    );
  }
  try {
    const client = getStorageToolsDependencies().androidClientFactory(device);
    const entries = await client.getDataStore(args.appId, args.adapterName, args.name);
    return createJSONToolResponse({
      success: true,
      appId: args.appId,
      adapterName: args.adapterName,
      name: args.name,
      entries,
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    if (isSharedPreferencesInspectionDisabledError(error)) {
      throw dataStoreInspectionDisabledError(args.appId);
    }
    throw toActionableError(error, `Failed to get data store`);
  }
}

/**
 * Register storage write tools.
 *
 * Read-only storage operations (listing files, reading entries) are exposed as
 * MCP resources in storageResources.ts. Only write operations are tools.
 */
export function registerStorageTools(): void {
  ToolRegistry.registerDeviceAware(
    "setKeyValue",
    "Set app key-value storage entry.",
    setKeyValueSchema,
    setKeyValueHandler,
    { defaultEnabled: false, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "listDataStores",
    "List app Jetpack DataStore instances (Android, requires AutoMobile SDK adapter).",
    listDataStoresSchema,
    listDataStoresHandler,
    { defaultEnabled: false, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "getDataStore",
    "Read entries from an app Jetpack DataStore instance (Android, requires AutoMobile SDK adapter).",
    getDataStoreSchema,
    getDataStoreHandler,
    { defaultEnabled: false, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "removeKeyValue",
    "Remove app key-value storage entry.",
    removeKeyValueSchema,
    removeKeyValueHandler,
    { defaultEnabled: false, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "clearKeyValueFile",
    "Clear app key-value storage file.",
    clearKeyValueFileSchema,
    clearKeyValueFileHandler,
    { defaultEnabled: false, embeddedSdkOnly: true },
  );
}
