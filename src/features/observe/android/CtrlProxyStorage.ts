/**
 * CtrlProxyStorage - Delegate for SharedPreferences operations.
 *
 * This delegate handles listing, reading, and subscribing to SharedPreferences
 * and DataStore changes on the device.
 */

import WebSocket from "ws";
import { keystoreResetSchema, type KeystoreReset } from "../../storage/keystoreReset";
import { toActionableError } from "../../../models/ActionableError";
import {
  keystoreDiscoverySchema,
  type KeystoreDiscoveryState,
} from "../../storage/keystoreDiscovery";
import {
  parseSdkCapabilitiesState,
  sdkCapabilitiesUnavailable,
  type SdkCapabilitiesResult,
} from "../../sdk/sdkCapabilities";
import { getAbortSignal } from "../../../utils/AbortContext";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { ProviderUnavailableError } from "../../storage/ProviderUnavailableError";
import type { DelegateContext } from "./types";
import { WEBSOCKET_NOT_CONNECTED_MESSAGE, sendCommand } from "../DeviceServiceUtils";
import { createTimestampedId } from "../../../utils/IdGenerator";
import { SDK_CAPABILITIES_USER_ID_CAPABILITY } from "./ctrlProxyProtocol";
import { normalizeStorageWriteOptions } from "../../storage/storageTypes";
import type {
  StorageWriteOptions,
  PreferenceFile,
  KeyValueEntry,
  KeyValueWrite,
  StorageSubscription,
  StorageChangedEvent,
  ListPreferenceFilesResult,
  GetPreferencesResult,
  GetPreferenceResult,
  SetPreferenceResult,
  RemovePreferenceResult,
  ClearPreferencesResult,
  SubscribeStorageResult,
  UnsubscribeStorageResult,
} from "../../storage/storageTypes";

/** Known transport failures raised while reading Android preferences from CtrlProxy. */
export function isCtrlProxyStorageUnavailableError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message === "Failed to connect to accessibility service" ||
    message === WEBSOCKET_NOT_CONNECTED_MESSAGE
  );
}

/**
 * Delegate class for handling SharedPreferences operations.
 */
export class CtrlProxyStorage {
  private preferenceError(message: string): Error {
    return /Unknown authority\s+\S+\.automobile\.sharedprefs\b/i.test(message)
      ? new ProviderUnavailableError(message)
      : new Error(message);
  }
  private readonly context: DelegateContext;

  // Storage change listeners
  private storageChangeListeners: Set<(event: StorageChangedEvent) => void> = new Set();

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * List all preference files for a package.
   * Returns SharedPreferences and DataStore files accessible to the app.
   *
   * @param packageName - The package name of the app to inspect
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of preference files
   */
  async listPreferenceFiles(
    packageName: string,
    timeoutMs: number = 5000,
  ): Promise<PreferenceFile[]> {
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<ListPreferenceFilesResult>(
        "list_preference_files",
        { packageName },
        {
          timeoutMs,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `List preference files timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw this.preferenceError(result.error || "Failed to list preference files");
      }

      return result.files || [];
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] listPreferenceFiles failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /**
   * Get all key-value entries from a preference file.
   *
   * @param packageName - The package name of the app
   * @param fileName - Name of the preference file
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of key-value entries
   */
  async getPreferenceEntries(
    packageName: string,
    fileName: string,
    timeoutMs: number = 5000,
  ): Promise<KeyValueEntry[]> {
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<GetPreferencesResult>(
        "get_preferences",
        { packageName, fileName },
        {
          timeoutMs,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Get preferences timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw this.preferenceError(result.error || "Failed to get preference entries");
      }

      return result.entries || [];
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] getPreferenceEntries failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /** Deletes only app-declared aliases through the optional debug bridge. */
  async resetKeystore(
    packageName: string,
    scope?: string,
    alias?: string,
    timeoutMs = 5000,
  ): Promise<KeystoreReset> {
    const refusal = (
      outcome: "unsupported" | "unavailable",
      reason: "DECLARED_UNSUPPORTED" | "BRIDGE_UNAVAILABLE",
    ): KeystoreReset => ({
      schemaVersion: 1,
      capability: "storage.keystore",
      outcome,
      reason,
      bridgeAvailable: false,
      requestedScope: scope,
      requestedAlias: alias,
      deletedCount: 0,
    });
    try {
      if (!(await this.context.ensureConnected())) {
        return refusal("unavailable", "BRIDGE_UNAVAILABLE");
      }
      const commands = await this.context.getSupportedCommands?.();
      if (commands?.includes("reset_keystore") !== true) {
        return refusal("unsupported", "DECLARED_UNSUPPORTED");
      }
      const result = await this.sendStorageCommand<{ state: unknown }>(
        "reset_keystore",
        { packageName, scope, alias },
        {
          timeoutMs,
          connected: true,
          managerId: true,
          unsupportedCommandError: () => ({
            state: refusal("unsupported", "DECLARED_UNSUPPORTED"),
          }),
          timeoutError: () => ({ state: refusal("unavailable", "BRIDGE_UNAVAILABLE") }),
        },
      );
      return keystoreResetSchema.parse(result.state);
    } catch (error) {
      logger.warn("[CTRL_PROXY] Keystore reset unavailable", error);
      return refusal("unavailable", "BRIDGE_UNAVAILABLE");
    }
  }

  /** Discovers the app-owned read-only Keystore metadata bridge. */
  async discoverKeystore(packageName: string, timeoutMs = 5000): Promise<KeystoreDiscoveryState> {
    try {
      if (!(await this.context.ensureConnected())) {
        throw new Error("Failed to connect to accessibility service");
      }
      const ws = this.context.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error(WEBSOCKET_NOT_CONNECTED_MESSAGE);
      }
      // Optional commands require an advertised capability, including on the first read.
      const commands = await this.context.getSupportedCommands?.();
      if (commands?.includes("discover_keystore") !== true) {
        return {
          schemaVersion: 1,
          capability: "storage.keystore",
          outcome: "unsupported",
          reason: "DECLARED_UNSUPPORTED",
          bridgeAvailable: false,
          metadata: "supported",
          mutation: "declared_unsupported",
          deviceLocked: "unknown",
          scopes: [],
        };
      }
      const pending = this.sendStorageCommand<{ state: unknown }>(
        "discover_keystore",
        { packageName },
        {
          timeoutMs,
          connected: true,
          managerId: true,
          unsupportedCommandError: () => ({ state: undefined }),
          timeoutError: () => ({
            state: {
              schemaVersion: 1,
              capability: "storage.keystore",
              outcome: "unavailable",
              reason: "BRIDGE_UNAVAILABLE",
              bridgeAvailable: false,
              metadata: "supported",
              mutation: "declared_unsupported",
              deviceLocked: "unknown",
              scopes: [],
            },
          }),
        },
      );
      return keystoreDiscoverySchema.parse((await pending).state);
    } catch (error) {
      throw toActionableError(error, "Failed to discover Android Keystore capabilities");
    }
  }

  /**
   * Reads the app SDK's capability and capture-policy snapshot (issue #5191). Resolves to a typed
   * `unavailable` result, never an empty capability set, when CtrlProxy, the SDK, or the response
   * cannot supply a snapshot. `userId` (the app's Android user, e.g. a work profile) is forwarded
   * only to a CtrlProxy advertising {@link SDK_CAPABILITIES_USER_ID_CAPABILITY}.
   */
  async getSdkCapabilities(
    packageName: string,
    userId?: number,
    timeoutMs = 5000,
  ): Promise<SdkCapabilitiesResult> {
    try {
      if (!(await this.context.ensureConnected())) {
        return sdkCapabilitiesUnavailable("CTRLPROXY_UNREACHABLE");
      }
      const ws = this.context.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return sdkCapabilitiesUnavailable("CTRLPROXY_UNREACHABLE");
      }
      // Optional commands require an advertised capability, including on the first read.
      const commands = await this.context.getSupportedCommands?.();
      if (commands?.includes("get_sdk_capabilities") !== true) {
        return sdkCapabilitiesUnavailable("CTRLPROXY_UNSUPPORTED");
      }
      const forwardUser =
        userId !== undefined && commands?.includes(SDK_CAPABILITIES_USER_ID_CAPABILITY) === true;
      const pending = this.sendStorageCommand<{ state: unknown }>(
        "get_sdk_capabilities",
        { packageName, ...(forwardUser ? { userId } : {}) },
        {
          timeoutMs,
          connected: true,
          managerId: true,
          timeoutError: () => ({ state: { outcome: "unavailable", reason: "REQUEST_TIMEOUT" } }),
          unsupportedCommandError: () => ({ state: undefined }),
        },
      );
      return parseSdkCapabilitiesState((await pending).state);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] getSdkCapabilities failed: ${errorMessage(error)}`, error);
      return sdkCapabilitiesUnavailable("CTRLPROXY_UNREACHABLE");
    }
  }

  /**
   * List the Jetpack DataStore instances exposed by a host-registered adapter (issue #5573).
   *
   * DataStore descriptors reuse the SharedPreferences `preference_files` result envelope on the
   * wire (`StorageResponse.FileList`, path emitted empty), so the device sends the same
   * `preference_files` message type — disambiguated by `requestId`.
   *
   * @param packageName - The package name of the app to inspect
   * @param adapterName - The stable name the host registered its DataStore adapter under
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of DataStore descriptors
   */
  async listDataStores(
    packageName: string,
    adapterName: string,
    timeoutMs: number = 5000,
  ): Promise<PreferenceFile[]> {
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<ListPreferenceFilesResult>(
        "list_data_stores",
        { packageName, adapterName },
        {
          timeoutMs,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `List data stores timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to list data stores");
      }

      return result.files || [];
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] listDataStores failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /**
   * Read all key-value entries from a named DataStore instance (issue #5573).
   *
   * Reuses the SharedPreferences `preferences` result envelope on the wire
   * (`StorageResponse.Preferences`), disambiguated by `requestId`.
   *
   * @param packageName - The package name of the app
   * @param adapterName - The stable name the host registered its DataStore adapter under
   * @param storeName - Name of the DataStore instance
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of key-value entries
   */
  async getDataStore(
    packageName: string,
    adapterName: string,
    storeName: string,
    timeoutMs: number = 5000,
  ): Promise<KeyValueEntry[]> {
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<GetPreferencesResult>(
        "get_data_store",
        { packageName, adapterName, storeName },
        {
          timeoutMs,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Get data store timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to get data store entries");
      }

      return result.entries || [];
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] getDataStore failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /**
   * Subscribe to storage changes for a preference file.
   * Returns a subscription that can be used to unsubscribe later.
   *
   * @param packageName - The package name of the app
   * @param fileName - Name of the preference file to observe
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to the subscription details
   */
  async subscribeStorage(
    packageName: string,
    fileName: string,
    timeoutMs: number = 5000,
  ): Promise<StorageSubscription> {
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<SubscribeStorageResult>(
        "subscribe_storage",
        { packageName, fileName },
        {
          timeoutMs,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Subscribe storage timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success || !result.subscription) {
        throw new Error(result.error || "Failed to subscribe to storage");
      }

      logger.info(
        `[CTRL_PROXY] Subscribed to storage changes: ${packageName}/${fileName} (subscriptionId: ${result.subscription.subscriptionId})`,
      );
      return result.subscription;
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] subscribeStorage failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /**
   * Unsubscribe from storage changes.
   *
   * @param subscriptionId - The "<packageName>:<fileName>" ID returned from subscribeStorage
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   */
  async unsubscribeStorage(subscriptionId: string, timeoutMs: number = 5000): Promise<void> {
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<UnsubscribeStorageResult>(
        "unsubscribe_storage",
        { subscriptionId },
        {
          timeoutMs,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Unsubscribe storage timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to unsubscribe from storage");
      }

      logger.info(
        `[CTRL_PROXY] Unsubscribed from storage changes (subscriptionId: ${subscriptionId})`,
      );
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] unsubscribeStorage failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  private sendStorageCommand<T>(
    operation: string,
    params: Record<string, unknown>,
    options: {
      timeoutMs: number;
      timeoutError: (timeoutMs: number) => T;
      unsupportedCommandError: (messageType: string, error: string) => T;
      onDispatch?: () => void;
      /** Optional capability reads have already connected before querying the handshake. */
      connected?: true;
      managerId?: boolean;
      checkAmbientAbort?: boolean;
    },
  ): Promise<T> {
    const ensureConnected = options.connected
      ? async () => true
      : () => this.context.ensureConnected();
    // The old writes checked ambient cancellation immediately after connecting, even
    // when connecting returned false. Keep that fence without adding in-flight abort.
    const checkAbort = options.checkAmbientAbort
      ? () => getAbortSignal()?.throwIfAborted()
      : undefined;
    return sendCommand<T>(
      {
        ...this.context,
        ensureConnected,
        // Storage historically bypassed the generic command gate. Optional reads retain
        // their advertised-command prechecks above; no new wire deadline fields are added.
        isCommandSupported: undefined,
        wireDeadlineParams: undefined,
      },
      {
        ...options,
        idPrefix: operation,
        responseType: operation,
        messageType: operation,
        createRequestId: options.managerId
          ? undefined
          : () => {
              checkAbort?.();
              return createTimestampedId(operation, this.context.timer, this.context.idGenerator);
            },
        // These storage types are not normalized by the Android serializer. createMessage
        // preserves their builders' type, requestId, params ordering and undefined omission.
        params,
        cancelScreenshotBackoff: false,
        notConnectedError: () => {
          checkAbort?.();
          throw new Error("Failed to connect to accessibility service");
        },
        timeoutError: options.timeoutError,
        onDispatch: (requestId) => {
          options.onDispatch?.();
          logger.debug(`[CTRL_PROXY] Sent ${operation} request (requestId: ${requestId})`);
        },
        unsupportedCommandError: options.unsupportedCommandError,
      },
    );
  }

  /**
   * Add a listener for storage change events.
   * The listener will be called for all subscribed storage changes.
   *
   * @param callback - Function to call when storage changes occur
   * @returns Function to remove the listener
   */
  addStorageChangeListener(callback: (event: StorageChangedEvent) => void): () => void {
    this.storageChangeListeners.add(callback);
    return () => {
      this.storageChangeListeners.delete(callback);
    };
  }

  /**
   * Notify all storage change listeners of an event.
   * This is called by the main client when a storage_changed message is received.
   */
  notifyStorageChangeListeners(event: StorageChangedEvent): void {
    for (const listener of this.storageChangeListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(`[CTRL_PROXY] Storage change listener error: ${error}`);
      }
    }
  }

  /**
   * Get a single preference entry by key.
   *
   * @param packageName - The package name of the app
   * @param fileName - Name of the preference file
   * @param key - The key to retrieve
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to the entry if found, null if not found
   */
  async getPreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMs: number = 5000,
  ): Promise<KeyValueEntry | null> {
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<GetPreferenceResult>(
        "get_preference",
        { packageName, fileName, key },
        {
          timeoutMs,
          unsupportedCommandError: (_type, error) => ({
            success: false,
            found: false,
            totalTimeMs: 0,
            error,
          }),
          timeoutError: () => ({
            success: false,
            found: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Get preference timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to get preference");
      }

      return result.found && result.entry ? result.entry : null;
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] getPreference failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /**
   * Set a preference value.
   *
   * @param packageName - The package name of the app
   * @param fileName - Name of the preference file
   * @param entry - The key to set, its value (serialized as string, or null) and its type
   *   (STRING, INT, LONG, FLOAT, BOOLEAN, STRING_SET)
   * @param timeoutMsOrOptions - Response timeout or timeout and successful-send hook
   */
  async setPreference(
    packageName: string,
    fileName: string,
    entry: KeyValueWrite,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<void> {
    const { key, value, type } = entry;
    const { timeoutMs, onDispatch } = normalizeStorageWriteOptions(timeoutMsOrOptions);
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<SetPreferenceResult>(
        "set_preference",
        { packageName, fileName, key, value, valueType: type },
        {
          timeoutMs,
          checkAmbientAbort: true,
          onDispatch,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Set preference timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to set preference");
      }

      logger.info(`[CTRL_PROXY] Set preference: ${packageName}/${fileName}/${key}`);
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] setPreference failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /**
   * Remove a preference entry.
   *
   * @param packageName - The package name of the app
   * @param fileName - Name of the preference file
   * @param key - The key to remove
   * @param timeoutMsOrOptions - Response timeout or timeout and successful-send hook
   */
  async removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<void> {
    const { timeoutMs, onDispatch } = normalizeStorageWriteOptions(timeoutMsOrOptions);
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<RemovePreferenceResult>(
        "remove_preference",
        { packageName, fileName, key },
        {
          timeoutMs,
          checkAmbientAbort: true,
          onDispatch,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Remove preference timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to remove preference");
      }

      logger.info(`[CTRL_PROXY] Removed preference: ${packageName}/${fileName}/${key}`);
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] removePreference failed after ${duration}ms: ${error}`);
      throw error;
    }
  }

  /**
   * Clear all preferences in a file.
   *
   * @param packageName - The package name of the app
   * @param fileName - Name of the preference file to clear
   * @param timeoutMsOrOptions - Response timeout or timeout and successful-send hook
   */
  async clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<void> {
    const { timeoutMs, onDispatch } = normalizeStorageWriteOptions(timeoutMsOrOptions);
    const startTime = this.context.timer.now();

    try {
      const result = await this.sendStorageCommand<ClearPreferencesResult>(
        "clear_preferences",
        { packageName, fileName },
        {
          timeoutMs,
          checkAmbientAbort: true,
          onDispatch,
          unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
          timeoutError: () => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Clear preferences timeout after ${timeoutMs}ms`,
          }),
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to clear preferences");
      }

      logger.info(`[CTRL_PROXY] Cleared preferences: ${packageName}/${fileName}`);
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] clearPreferenceStore failed after ${duration}ms: ${error}`);
      throw error;
    }
  }
}
