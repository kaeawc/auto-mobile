import type {
  KeychainDeleteOutcome,
  KeychainItemSelector,
} from "../features/observe/ios/CtrlProxyStorage";
import { errorMessage } from "../utils/describeUnknownError";
import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import {
  addDeviceTargetingToSchema,
  withAppIdAliases,
  withPostFlattenJsonSchemaOverride,
} from "../utils/schemaHelpers";
import { createStructuredToolResponse } from "../utils/toolUtils";
import {
  clearKeyValueFileResultSchema,
  getDataStoreResultSchema,
  listDataStoresResultSchema,
  deleteKeychainItemResultSchema,
  removeKeyValueResultSchema,
  setKeyValueResultSchema,
} from "./storageToolOutputSchemas";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { ResourceRegistry } from "./resourceRegistry";
import type { KeyValueWrite, PreferenceStoreResolution } from "../features/storage/storageTypes";
import { preferenceSetWarning, validateTypeForPlatform } from "../features/storage/storageChecks";
import { IOS_STORAGE_MUTATION_AUTHORIZATION_HINT } from "../utils/storageSdkErrors";
import {
  clearAndroidKeyValueFileDirect,
  dataStoreInspectionDisabledReason,
  directFileFallbackRelaunchWarning,
  isSharedPreferencesInspectionDisabledError,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
  withAndroidSharedPreferencesInspectionFallback,
  type AndroidKeyValueFileTarget,
  type SharedPreferencesInspectionFallbackResult,
} from "../features/storage/AndroidSharedPreferencesKeyValueFile";
import { encodeUriSegment } from "../utils/encodeUriSegment";

/** The subset of AndroidCtrlProxyClient the key-value tool handlers depend on. */
export interface AndroidKeyValueClient {
  setPreference(appId: string, fileName: string, entry: KeyValueWrite): Promise<void>;
  removePreference(appId: string, fileName: string, key: string): Promise<void>;
  clearPreferenceStore(appId: string, fileName: string): Promise<void>;
  listDataStores(appId: string, adapterName: string): Promise<unknown>;
  getDataStore(appId: string, adapterName: string, name: string): Promise<unknown>;
}

/** The subset of IOSCtrlProxyClient the key-value tool handlers depend on. */
export interface IosKeyValueClient {
  deleteKeychainItemForIos(
    appId: string,
    selector: KeychainItemSelector,
    confirm: boolean,
  ): Promise<KeychainDeleteOutcome>;
  setPreference(
    appId: string,
    fileName: string,
    entry: KeyValueWrite,
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

const defaultStorageToolsDependencies: StorageToolsDependencies = {
  androidClientFactory: (device) =>
    AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory),
  iosClientFactory: (device) => IOSCtrlProxyClient.getInstance(device),
  adbClientFactory: defaultAdbClientFactory,
};

function actionableStorageWriteError(error: unknown, context: string): ActionableError {
  if (errorMessage(error).includes("mutation_not_authorized")) {
    return new ActionableError(`${context}: ${IOS_STORAGE_MUTATION_AUTHORIZATION_HINT}`, {
      cause: error,
    });
  }
  return toActionableError(error, context);
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

const STORAGE_NAME_DESCRIPTION =
  'Storage name. iOS: empty string, "standard" (any case) or the app bundle id select the app\'s standard UserDefaults; any other value is a UserDefaults suite name (e.g. an app group) and must be a valid suite with no leading or trailing whitespace. Android: SharedPreferences file name without the .xml extension (letters, digits, underscore, dash, dot).';

export const deleteKeychainItemSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string().min(1),
        selector: z
          .object({
            itemClass: z.string().min(1),
            service: z.string().min(1),
            account: z.string().min(1),
            accessGroup: z.string().min(1),
          })
          .strict(),
        confirm: z
          .literal(true)
          .describe("Explicit confirmation to delete this exact Keychain item"),
      })
      .strict(),
  ),
);

async function deleteKeychainItemHandler(
  device: BootedDevice,
  args: z.output<typeof deleteKeychainItemSchema>,
  deps: StorageToolsDependencies,
) {
  if (device.platform !== "ios") {
    throw new ActionableError("deleteKeychainItem requires iOS with the in-app AutoMobile SDK");
  }
  if (args.confirm !== true) {
    throw new ActionableError("deleteKeychainItem requires confirm:true");
  }
  try {
    const result = await deps
      .iosClientFactory(device)
      .deleteKeychainItemForIos(args.appId, args.selector, args.confirm);
    if (result.outcome !== "deleted") {
      return {
        ...createStructuredToolResponse({ success: false, appId: args.appId, ...result }),
        isError: true as const,
      };
    }
    return createStructuredToolResponse({ appId: args.appId, ...result });
  } catch (error) {
    throw toActionableError(error, "Failed to delete scoped iOS Keychain item");
  }
}

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

/**
 * `userId` only steers the direct-file (run-as) fallback. When the SDK route handled the call
 * it edited the connected app process's copy, so say that instead of reporting a plain success
 * that looks like it honoured the requested user.
 */
function sdkRouteIgnoredUserIdWarning(
  device: BootedDevice,
  userId: number | undefined,
): string | undefined {
  return device.platform === "android" && userId !== undefined
    ? `userId ${userId} was not applied: the SDK route is not user-scoped and edited the connected app process's copy. Only the direct-file fallback (SDK route disabled) targets a specific user.`
    : undefined;
}

function optionalWarning(warning: string | undefined): { warning?: string } {
  return warning === undefined ? {} : { warning };
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

type ListDataStoresArgs = z.output<typeof listDataStoresSchema>;
type GetDataStoreArgs = z.output<typeof getDataStoreSchema>;
type SetKeyValueArgs = z.output<typeof setKeyValueSchema>;
type RemoveKeyValueArgs = z.output<typeof removeKeyValueSchema>;
type ClearKeyValueFileArgs = z.output<typeof clearKeyValueFileSchema>;

/**
 * Build resource URI for storage entries (mirrors storageResources.ts)
 */
function buildEntriesUri(deviceId: string, packageName: string, fileName: string): string {
  return `automobile:devices/${deviceId}/storage/${encodeUriSegment(packageName)}/${encodeUriSegment(fileName)}/entries`;
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
  { appId, fileName }: AndroidKeyValueFileTarget,
  viaSdk: () => Promise<void>,
  {
    viaDirectFile,
    deps,
  }: {
    viaDirectFile: (adb: ReturnType<AdbClientFactory["create"]>) => Promise<void>;
    deps: StorageToolsDependencies;
  },
): Promise<SharedPreferencesInspectionFallbackResult> {
  return withAndroidSharedPreferencesInspectionFallback(
    appId,
    fileName,
    () => deps.adbClientFactory.create(device),
    { viaSdk, viaDirectFile },
  );
}

// setKeyValue handler
async function setKeyValueHandler(
  device: BootedDevice,
  args: SetKeyValueArgs,
  deps: StorageToolsDependencies,
) {
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
      const client = deps.androidClientFactory(device);
      const target = { appId: args.appId, fileName: storageName, userId: args.userId };
      ({ usedDirectFileFallback } = await withSharedPreferencesInspectionFallback(
        device,
        target,
        () =>
          value === null
            ? client.removePreference(args.appId, storageName, args.key)
            : client.setPreference(args.appId, storageName, {
                key: args.key,
                value,
                type: args.type,
              }),
        {
          viaDirectFile: (adb) =>
            value === null
              ? removeAndroidKeyValueDirect(adb, device.deviceId, target, args.key)
              : setAndroidKeyValueDirect(adb, device.deviceId, target, {
                  key: args.key,
                  value,
                  type: args.type,
                }),
          deps,
        },
      ));
    } else if (device.platform === "ios") {
      const client = deps.iosClientFactory(device);
      if (value === null) {
        resolvedStore = (await client.removePreference(args.appId, storageName, args.key))
          ?.resolvedStore;
      } else {
        const result = await client.setPreference(args.appId, storageName, {
          key: args.key,
          value,
          type: args.type,
        });
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
        : sdkRouteIgnoredUserIdWarning(device, args.userId),
      effectiveValueDiffers,
    );
    return createStructuredToolResponse({
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
async function removeKeyValueHandler(
  device: BootedDevice,
  args: RemoveKeyValueArgs,
  deps: StorageToolsDependencies,
) {
  try {
    const storageName = resolveStorageName(args);
    assertUserIdSupported(device, args.userId);
    let usedDirectFileFallback = false;
    let resolvedStore: string | undefined;
    if (device.platform === "android") {
      const client = deps.androidClientFactory(device);
      const target = { appId: args.appId, fileName: storageName, userId: args.userId };
      ({ usedDirectFileFallback } = await withSharedPreferencesInspectionFallback(
        device,
        target,
        () => client.removePreference(args.appId, storageName, args.key),
        {
          viaDirectFile: (adb) =>
            removeAndroidKeyValueDirect(adb, device.deviceId, target, args.key),
          deps,
        },
      ));
    } else if (device.platform === "ios") {
      const client = deps.iosClientFactory(device);
      resolvedStore = (await client.removePreference(args.appId, storageName, args.key))
        ?.resolvedStore;
    } else {
      throw new ActionableError(`Unsupported platform: ${device.platform}`);
    }

    void ResourceRegistry.notifyResourceUpdated(
      buildEntriesUri(device.deviceId, args.appId, storageName),
    );

    return createStructuredToolResponse({
      success: true,
      appId: args.appId,
      name: storageName,
      ...(resolvedStore ? { resolvedStore } : {}),
      key: args.key,
      ...optionalWarning(
        usedDirectFileFallback
          ? directFileFallbackRelaunchWarning(args.appId, storageName)
          : sdkRouteIgnoredUserIdWarning(device, args.userId),
      ),
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw actionableStorageWriteError(error, `Failed to remove key-value entry`);
  }
}

// clearKeyValueFile handler
async function clearKeyValueFileHandler(
  device: BootedDevice,
  args: ClearKeyValueFileArgs,
  deps: StorageToolsDependencies,
) {
  try {
    const storageName = resolveStorageName(args);
    assertUserIdSupported(device, args.userId);
    let usedDirectFileFallback = false;
    let resolvedStore: string | undefined;
    if (device.platform === "android") {
      const client = deps.androidClientFactory(device);
      ({ usedDirectFileFallback } = await withSharedPreferencesInspectionFallback(
        device,
        { appId: args.appId, fileName: storageName },
        () => client.clearPreferenceStore(args.appId, storageName),
        {
          viaDirectFile: (adb) =>
            clearAndroidKeyValueFileDirect(adb, device.deviceId, args.appId, {
              fileName: storageName,
              userId: args.userId,
            }),
          deps,
        },
      ));
    } else if (device.platform === "ios") {
      const client = deps.iosClientFactory(device);
      resolvedStore = (await client.clearPreferenceStore(args.appId, storageName))?.resolvedStore;
    } else {
      throw new ActionableError(`Unsupported platform: ${device.platform}`);
    }

    void ResourceRegistry.notifyResourceUpdated(
      buildEntriesUri(device.deviceId, args.appId, storageName),
    );

    return createStructuredToolResponse({
      success: true,
      appId: args.appId,
      name: storageName,
      ...(resolvedStore ? { resolvedStore } : {}),
      ...optionalWarning(
        usedDirectFileFallback
          ? directFileFallbackRelaunchWarning(args.appId, storageName)
          : sdkRouteIgnoredUserIdWarning(device, args.userId),
      ),
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw toActionableError(error, `Failed to clear key-value file`);
  }
}

// listDataStores handler — Android-only (Jetpack DataStore has no iOS analog).
async function listDataStoresHandler(
  device: BootedDevice,
  args: ListDataStoresArgs,
  deps: StorageToolsDependencies,
) {
  if (device.platform !== "android") {
    throw new ActionableError(
      `listDataStores is Android-only; DataStore is not available on ${device.platform}.`,
    );
  }
  try {
    const client = deps.androidClientFactory(device);
    const stores = await client.listDataStores(args.appId, args.adapterName);
    return createStructuredToolResponse({
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
async function getDataStoreHandler(
  device: BootedDevice,
  args: GetDataStoreArgs,
  deps: StorageToolsDependencies,
) {
  if (device.platform !== "android") {
    throw new ActionableError(
      `getDataStore is Android-only; DataStore is not available on ${device.platform}.`,
    );
  }
  try {
    const client = deps.androidClientFactory(device);
    const entries = await client.getDataStore(args.appId, args.adapterName, args.name);
    return createStructuredToolResponse({
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
export function registerStorageTools(overrides: Partial<StorageToolsDependencies> = {}): void {
  const deps = { ...defaultStorageToolsDependencies, ...overrides };
  ToolRegistry.registerDeviceAware(
    "deleteKeychainItem",
    "Delete one exact, host-allowlisted, app-owned iOS generic-password Keychain item. Requires SDK opt-in, mutation authorization and explicit confirmation; never exports values.",
    deleteKeychainItemSchema,
    (device, args) => deleteKeychainItemHandler(device, args, deps),
    { defaultEnabled: false, outputSchema: deleteKeychainItemResultSchema, embeddedSdkOnly: true },
  );
  ToolRegistry.registerDeviceAware(
    "setKeyValue",
    "Set app key-value storage entry.",
    setKeyValueSchema,
    (device, args) => setKeyValueHandler(device, args, deps),
    { defaultEnabled: false, outputSchema: setKeyValueResultSchema, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "listDataStores",
    "List app Jetpack DataStore instances (Android, requires AutoMobile SDK adapter).",
    listDataStoresSchema,
    (device, args) => listDataStoresHandler(device, args, deps),
    {
      defaultEnabled: false,
      outputSchema: listDataStoresResultSchema,
      embeddedSdkOnly: true,
      // Reads only; a non-holder watches a held device through the read-only path (#10830).
      deviceReadOnly: true,
    },
  );

  ToolRegistry.registerDeviceAware(
    "getDataStore",
    "Read entries from an app Jetpack DataStore instance (Android, requires AutoMobile SDK adapter).",
    getDataStoreSchema,
    (device, args) => getDataStoreHandler(device, args, deps),
    {
      defaultEnabled: false,
      outputSchema: getDataStoreResultSchema,
      embeddedSdkOnly: true,
      // Reads only; a non-holder watches a held device through the read-only path (#10830).
      deviceReadOnly: true,
    },
  );

  ToolRegistry.registerDeviceAware(
    "removeKeyValue",
    "Remove app key-value storage entry.",
    removeKeyValueSchema,
    (device, args) => removeKeyValueHandler(device, args, deps),
    { defaultEnabled: false, outputSchema: removeKeyValueResultSchema, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "clearKeyValueFile",
    "Clear app key-value storage file.",
    clearKeyValueFileSchema,
    (device, args) => clearKeyValueFileHandler(device, args, deps),
    { defaultEnabled: false, outputSchema: clearKeyValueFileResultSchema, embeddedSdkOnly: true },
  );
}
