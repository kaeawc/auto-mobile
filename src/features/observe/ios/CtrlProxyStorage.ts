/**
 * CtrlProxy iOS Storage - Delegate for UserDefaults inspection operations.
 *
 * This delegate handles listing, reading, and writing UserDefaults
 * suites on iOS devices via the CtrlProxy WebSocket API.
 * Uses the same wire protocol message types as the Android delegate.
 */

import { WEBSOCKET_NOT_CONNECTED_MESSAGE, sendCommand } from "../DeviceServiceUtils";
import { getAbortSignal } from "../../../utils/AbortContext";
import { logger } from "../../../utils/logger";
import { mapStorageSdkError } from "../../../utils/storageSdkErrors";
import { ActionableError } from "../../../models/ActionableError";
import type { DelegateContext } from "./types";
import { normalizeStorageWriteOptions } from "../../storage/storageTypes";
import type {
  StorageWriteOptions,
  PreferenceStoreResolution,
  PreferenceFile,
  KeyValueEntry,
  KeyValueWrite,
  ListPreferenceFilesResult,
  GetPreferencesResult,
  GetPreferenceResult,
  SetPreferenceResult,
  RemovePreferenceResult,
  ClearPreferencesResult,
} from "../../storage/storageTypes";

export interface KeychainItemSelector {
  itemClass: string;
  service: string;
  account: string;
  accessGroup: string;
}

export interface KeychainDeleteOutcome {
  outcome: string;
  deletedScope: KeychainItemSelector | null;
}

interface KeychainDeleteResult extends KeychainDeleteOutcome {
  success: boolean;
  totalTimeMs: number;
}

/**
 * Delegate class for handling iOS UserDefaults storage operations.
 */
export class CtrlProxyStorage {
  private readonly context: DelegateContext;

  constructor(
    context: DelegateContext,
    private readonly sessionId?: () => string | null,
    private readonly mutationToken?: (appId: string) => string | undefined,
  ) {
    this.context = context;
  }

  private sdkError(
    error: string | undefined,
    fallback: string,
    action?: "set" | "remove" | "clear",
  ): ActionableError {
    const mapped = error ? mapStorageSdkError(error, { operation: "storage", action }) : null;
    return new ActionableError(mapped ?? (error || fallback));
  }

  private mutationResult(result: PreferenceStoreResolution): PreferenceStoreResolution | undefined {
    return result.resolvedStore !== undefined || result.effectiveValueDiffers !== undefined
      ? {
          ...(result.resolvedStore !== undefined ? { resolvedStore: result.resolvedStore } : {}),
          ...(result.effectiveValueDiffers !== undefined
            ? { effectiveValueDiffers: result.effectiveValueDiffers }
            : {}),
        }
      : undefined;
  }

  async deleteKeychainItemForIos(
    appId: string,
    selector: KeychainItemSelector,
    confirm: boolean,
    timeoutMs: number = 5000,
  ): Promise<KeychainDeleteOutcome> {
    if (!(await this.context.ensureConnected())) {
      return { outcome: "sdk_unavailable", deletedScope: null };
    }
    getAbortSignal()?.throwIfAborted();
    const requestId = this.context.requestManager.generateId("delete_keychain_item");
    const sessionId = this.sessionId?.();
    const mutationToken = this.mutationToken?.(appId);
    const unavailable = (): KeychainDeleteResult => ({
      success: false,
      totalTimeMs: 0,
      outcome: "sdk_unavailable",
      deletedScope: null,
    });
    const result = await this.sendStorageCommand<KeychainDeleteResult>(
      "delete_keychain_item",
      requestId,
      {
        appId,
        selector,
        confirm,
        ...(sessionId ? { sessionId } : {}),
        ...(mutationToken ? { mutationToken } : {}),
      },
      { timeoutMs, timeoutError: unavailable, responseError: unavailable },
    );
    return { outcome: result.outcome, deletedScope: result.deletedScope ?? null };
  }

  /**
   * List all UserDefaults suites.
   *
   * @param packageName - Target app bundle identifier
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of preference files (suites)
   */
  async listPreferenceFiles(
    packageName: string,
    timeoutMs: number = 5000,
  ): Promise<PreferenceFile[]> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    const requestId = this.context.requestManager.generateId("list_preference_files");
    const promise = this.sendStorageCommand<ListPreferenceFilesResult>(
      "list_preference_files",
      requestId,
      {
        appId: packageName,
      },
      {
        timeoutMs,
        timeoutError: () => ({
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `List preference files timeout after ${timeoutMs}ms`,
        }),
        responseError: (error) => ({ success: false, totalTimeMs: 0, error }),
      },
    );
    logger.debug(`[CTRL_PROXY_IOS] Sent list_preference_files request (requestId: ${requestId})`);

    const result = await promise;
    if (!result.success) {
      throw this.sdkError(result.error, "Failed to list preference files");
    }

    return result.files || [];
  }

  /**
   * Get all key-value entries from a UserDefaults suite.
   *
   * @param packageName - Target app bundle identifier
   * @param fileName - Suite name ("Standard" for default suite, or custom suite name)
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of key-value entries
   */
  async getPreferenceEntries(
    packageName: string,
    fileName: string,
    timeoutMs: number = 5000,
  ): Promise<KeyValueEntry[]> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    const requestId = this.context.requestManager.generateId("get_preferences");
    const promise = this.sendStorageCommand<GetPreferencesResult>(
      "get_preferences",
      requestId,
      {
        appId: packageName,
        fileName,
      },
      {
        timeoutMs,
        timeoutError: () => ({
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Get preferences timeout after ${timeoutMs}ms`,
        }),
        responseError: (error) => ({ success: false, totalTimeMs: 0, error }),
      },
    );
    logger.debug(
      `[CTRL_PROXY_IOS] Sent get_preferences request (requestId: ${requestId}, fileName: ${fileName})`,
    );

    const result = await promise;
    if (!result.success) {
      throw this.sdkError(result.error, "Failed to get preference entries");
    }

    return result.entries || [];
  }

  /**
   * Get a single preference entry by key.
   *
   * @param packageName - Target app bundle identifier
   * @param fileName - Suite name
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

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    const requestId = this.context.requestManager.generateId("get_preference");
    const promise = this.sendStorageCommand<GetPreferenceResult>(
      "get_preference",
      requestId,
      {
        appId: packageName,
        fileName,
        key,
      },
      {
        timeoutMs,
        timeoutError: () => ({
          success: false,
          found: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Get preference timeout after ${timeoutMs}ms`,
        }),
        responseError: (error) => ({ success: false, found: false, totalTimeMs: 0, error }),
      },
    );
    logger.debug(
      `[CTRL_PROXY_IOS] Sent get_preference request (requestId: ${requestId}, fileName: ${fileName}, key: ${key})`,
    );

    const result = await promise;
    if (!result.success) {
      throw this.sdkError(result.error, "Failed to get preference");
    }

    return result.found && result.entry ? result.entry : null;
  }

  /** Already connected above; keep iOS serialization/deadlines without ambient in-flight abort. */
  private sendStorageCommand<T>(
    operation: string,
    requestId: string,
    params: Record<string, unknown>,
    options: {
      timeoutMs: number;
      timeoutError: () => T;
      responseError: (error: string) => T;
      onDispatch?: () => void;
    },
  ): Promise<T> {
    const { timeoutMs, timeoutError, responseError, onDispatch } = options;
    return sendCommand<T>(this.context, {
      idPrefix: operation,
      createRequestId: () => requestId,
      responseType: operation,
      messageType: operation,
      params,
      timeoutMs,
      timeoutError,
      notConnectedError: () => responseError(WEBSOCKET_NOT_CONNECTED_MESSAGE),
      unsupportedCommandError: (_type, error) => responseError(error),
      requireExistingConnection: true,
      cancelScreenshotBackoff: false,
      onDispatch,
    });
  }

  /**
   * Set a preference value.
   *
   * @param packageName - Target app bundle identifier
   * @param fileName - Suite name
   * @param entry - The key to set, its value (serialized as string, or null) and its type
   * @param timeoutMsOrOptions - Response timeout or timeout and successful-send hook
   */
  async setPreference(
    packageName: string,
    fileName: string,
    entry: KeyValueWrite,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | undefined> {
    const { key, value, type } = entry;
    const { timeoutMs, onDispatch } = normalizeStorageWriteOptions(timeoutMsOrOptions);
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    getAbortSignal()?.throwIfAborted();
    const sessionId = this.sessionId?.();
    const mutationToken = this.mutationToken?.(packageName);
    const requestId = this.context.requestManager.generateId("set_preference");
    const promise = this.sendStorageCommand<SetPreferenceResult>(
      "set_preference",
      requestId,
      {
        appId: packageName,
        fileName,
        key,
        value,
        valueType: type,
        ...(sessionId ? { sessionId } : {}),
        ...(mutationToken ? { mutationToken } : {}),
      },
      {
        timeoutMs,
        timeoutError: () => ({
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Set preference timeout after ${timeoutMs}ms`,
        }),
        responseError: (error) => ({ success: false, totalTimeMs: 0, error }),
        onDispatch,
      },
    );
    logger.debug(
      `[CTRL_PROXY_IOS] Sent set_preference request (requestId: ${requestId}, fileName: ${fileName}, key: ${key})`,
    );

    const result = await promise;
    if (!result.success) {
      throw this.sdkError(
        result.error,
        "Failed to set preference",
        value === null ? "remove" : "set",
      );
    }
    return this.mutationResult(result);
  }

  /**
   * Remove a preference entry.
   *
   * @param packageName - Target app bundle identifier
   * @param fileName - Suite name
   * @param key - The key to remove
   * @param timeoutMsOrOptions - Response timeout or timeout and successful-send hook
   */
  async removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | undefined> {
    const { timeoutMs, onDispatch } = normalizeStorageWriteOptions(timeoutMsOrOptions);
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    getAbortSignal()?.throwIfAborted();
    const sessionId = this.sessionId?.();
    const mutationToken = this.mutationToken?.(packageName);
    const requestId = this.context.requestManager.generateId("remove_preference");
    const promise = this.sendStorageCommand<RemovePreferenceResult>(
      "remove_preference",
      requestId,
      {
        appId: packageName,
        fileName,
        key,
        ...(sessionId ? { sessionId } : {}),
        ...(mutationToken ? { mutationToken } : {}),
      },
      {
        timeoutMs,
        timeoutError: () => ({
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Remove preference timeout after ${timeoutMs}ms`,
        }),
        responseError: (error) => ({ success: false, totalTimeMs: 0, error }),
        onDispatch,
      },
    );
    logger.debug(
      `[CTRL_PROXY_IOS] Sent remove_preference request (requestId: ${requestId}, fileName: ${fileName}, key: ${key})`,
    );

    const result = await promise;
    if (!result.success) {
      throw this.sdkError(result.error, "Failed to remove preference", "remove");
    }
    return this.mutationResult(result);
  }

  /**
   * Clear all preferences in a suite.
   *
   * @param packageName - Target app bundle identifier
   * @param fileName - Suite name to clear
   * @param timeoutMsOrOptions - Response timeout or timeout and successful-send hook
   */
  async clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | undefined> {
    const { timeoutMs, onDispatch } = normalizeStorageWriteOptions(timeoutMsOrOptions);
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    getAbortSignal()?.throwIfAborted();
    const sessionId = this.sessionId?.();
    const mutationToken = this.mutationToken?.(packageName);
    const requestId = this.context.requestManager.generateId("clear_preferences");
    const promise = this.sendStorageCommand<ClearPreferencesResult>(
      "clear_preferences",
      requestId,
      {
        appId: packageName,
        fileName,
        ...(sessionId ? { sessionId } : {}),
        ...(mutationToken ? { mutationToken } : {}),
      },
      {
        timeoutMs,
        timeoutError: () => ({
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Clear preferences timeout after ${timeoutMs}ms`,
        }),
        responseError: (error) => ({ success: false, totalTimeMs: 0, error }),
        onDispatch,
      },
    );
    logger.debug(
      `[CTRL_PROXY_IOS] Sent clear_preferences request (requestId: ${requestId}, fileName: ${fileName})`,
    );

    const result = await promise;
    if (!result.success) {
      throw this.sdkError(result.error, "Failed to clear preferences", "clear");
    }
    return this.mutationResult(result);
  }
}
