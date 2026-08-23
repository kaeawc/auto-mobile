import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { ResourceRegistry } from "./resourceRegistry";
import type { KeyValueType } from "../features/storage/storageTypes";

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

const STORAGE_NAME_DESCRIPTION = "Storage name";

const legacyFileNameDescription = "Deprecated alias for name";

function resolveStorageName(args: { name?: string; fileName?: string }): string {
  return args.name ?? args.fileName!;
}

// Schema for setKeyValue tool
const setKeyValueSchema = withAppIdAliases(
  z.union([
    addDeviceTargetingToSchema(
      z.object({
        appId: z.string(),
        name: z.string().describe(STORAGE_NAME_DESCRIPTION),
        fileName: z.string().optional().describe(legacyFileNameDescription),
        key: z.string().describe("Key"),
        value: z.string().nullable().describe("Value string; null clears"),
        type: z.enum(KEY_VALUE_TYPES).describe("Value type"),
      }),
    ),
    addDeviceTargetingToSchema(
      z.object({
        appId: z.string(),
        name: z.string().optional().describe(STORAGE_NAME_DESCRIPTION),
        fileName: z.string().describe(legacyFileNameDescription),
        key: z.string().describe("Key"),
        value: z.string().nullable().describe("Value string; null clears"),
        type: z.enum(KEY_VALUE_TYPES).describe("Value type"),
      }),
    ),
  ]),
);

// Schema for removeKeyValue tool
const removeKeyValueSchema = withAppIdAliases(
  z.union([
    addDeviceTargetingToSchema(
      z.object({
        appId: z.string(),
        name: z.string().describe(STORAGE_NAME_DESCRIPTION),
        fileName: z.string().optional().describe(legacyFileNameDescription),
        key: z.string().describe("Key"),
      }),
    ),
    addDeviceTargetingToSchema(
      z.object({
        appId: z.string(),
        name: z.string().optional().describe(STORAGE_NAME_DESCRIPTION),
        fileName: z.string().describe(legacyFileNameDescription),
        key: z.string().describe("Key"),
      }),
    ),
  ]),
);

// Schema for clearKeyValueFile tool
const clearKeyValueFileSchema = withAppIdAliases(
  z.union([
    addDeviceTargetingToSchema(
      z.object({
        appId: z.string(),
        name: z.string().describe(STORAGE_NAME_DESCRIPTION),
        fileName: z.string().optional().describe(legacyFileNameDescription),
      }),
    ),
    addDeviceTargetingToSchema(
      z.object({
        appId: z.string(),
        name: z.string().optional().describe(STORAGE_NAME_DESCRIPTION),
        fileName: z.string().describe(legacyFileNameDescription),
      }),
    ),
  ]),
);

interface SetKeyValueArgs {
  appId: string;
  name?: string;
  fileName?: string;
  key: string;
  value: string | null;
  type: KeyValueType;
}

interface RemoveKeyValueArgs {
  appId: string;
  name?: string;
  fileName?: string;
  key: string;
}

interface ClearKeyValueFileArgs {
  appId: string;
  name?: string;
  fileName?: string;
}

/**
 * Build resource URI for storage entries (mirrors storageResources.ts)
 */
function buildEntriesUri(deviceId: string, packageName: string, fileName: string): string {
  return `automobile:devices/${deviceId}/storage/${encodeURIComponent(packageName)}/${encodeURIComponent(fileName)}/entries`;
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

/**
 * Register storage write tools.
 *
 * Read-only storage operations (listing files, reading entries) are exposed as
 * MCP resources in storageResources.ts. Only write operations are tools.
 */
export function registerStorageTools(): void {
  // setKeyValue handler
  const setKeyValueHandler = async (device: BootedDevice, args: SetKeyValueArgs) => {
    try {
      const storageName = resolveStorageName(args);
      if (args.value !== null) {
        validateTypeForPlatform(device.platform, args.type);
      }

      if (device.platform === "android") {
        const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
        if (args.value === null) {
          await client.removePreference(args.appId, storageName, args.key);
        } else {
          await client.setPreference(args.appId, storageName, args.key, args.value, args.type);
        }
      } else if (device.platform === "ios") {
        const client = IOSCtrlProxyClient.getInstance(device);
        if (args.value === null) {
          await client.removePreference(args.appId, storageName, args.key);
        } else {
          await client.setPreference(args.appId, storageName, args.key, args.value, args.type);
        }
      } else {
        throw new ActionableError(`Unsupported platform: ${device.platform}`);
      }

      // Notify subscribers that entries changed so they re-read fresh data
      void ResourceRegistry.notifyResourceUpdated(
        buildEntriesUri(device.deviceId, args.appId, storageName),
      );

      return createJSONToolResponse({
        success: true,
        appId: args.appId,
        name: storageName,
        key: args.key,
        type: args.type,
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to set key-value entry: ${error}`);
    }
  };

  // removeKeyValue handler
  const removeKeyValueHandler = async (device: BootedDevice, args: RemoveKeyValueArgs) => {
    try {
      const storageName = resolveStorageName(args);
      if (device.platform === "android") {
        const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
        await client.removePreference(args.appId, storageName, args.key);
      } else if (device.platform === "ios") {
        const client = IOSCtrlProxyClient.getInstance(device);
        await client.removePreference(args.appId, storageName, args.key);
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
        key: args.key,
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to remove key-value entry: ${error}`);
    }
  };

  // clearKeyValueFile handler
  const clearKeyValueFileHandler = async (device: BootedDevice, args: ClearKeyValueFileArgs) => {
    try {
      const storageName = resolveStorageName(args);
      if (device.platform === "android") {
        const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
        await client.clearPreferenceStore(args.appId, storageName);
      } else if (device.platform === "ios") {
        const client = IOSCtrlProxyClient.getInstance(device);
        await client.clearPreferenceStore(args.appId, storageName);
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
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to clear key-value file: ${error}`);
    }
  };

  ToolRegistry.registerDeviceAware(
    "setKeyValue",
    "Set app key-value storage entry.",
    setKeyValueSchema,
    setKeyValueHandler,
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
