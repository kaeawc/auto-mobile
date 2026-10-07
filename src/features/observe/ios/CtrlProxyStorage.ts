/**
 * CtrlProxy iOS Storage - Delegate for UserDefaults inspection operations.
 *
 * This delegate handles listing, reading, and writing UserDefaults
 * suites on iOS devices via the CtrlProxy WebSocket API.
 * Uses the same wire protocol message types as the Android delegate.
 */

import { logger } from "../../../utils/logger";
import { mapStorageSdkError } from "../../../server/storageSdkErrors";
import { ActionableError } from "../../../models/ActionableError";
import type { DelegateContext } from "./types";
import type {
  PreferenceStoreResolution,
  PreferenceFile,
  KeyValueEntry,
  KeyValueType,
  ListPreferenceFilesResult,
  GetPreferencesResult,
  GetPreferenceResult,
  SetPreferenceResult,
  RemovePreferenceResult,
  ClearPreferencesResult,
} from "../../storage/storageTypes";

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
    const promise = this.context.requestManager.register<ListPreferenceFilesResult>(
      requestId,
      "list_preference_files",
      timeoutMs,
      (_id, _type, _timeout) => ({
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `List preference files timeout after ${timeoutMs}ms`,
      }),
    );

    const message = JSON.stringify({
      type: "list_preference_files",
      requestId,
      appId: packageName,
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
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
    const promise = this.context.requestManager.register<GetPreferencesResult>(
      requestId,
      "get_preferences",
      timeoutMs,
      (_id, _type, _timeout) => ({
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `Get preferences timeout after ${timeoutMs}ms`,
      }),
    );

    const message = JSON.stringify({
      type: "get_preferences",
      requestId,
      appId: packageName,
      fileName,
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
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
    const promise = this.context.requestManager.register<GetPreferenceResult>(
      requestId,
      "get_preference",
      timeoutMs,
      (_id, _type, _timeout) => ({
        success: false,
        found: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `Get preference timeout after ${timeoutMs}ms`,
      }),
    );

    const message = JSON.stringify({
      type: "get_preference",
      requestId,
      appId: packageName,
      fileName,
      key,
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
    logger.debug(
      `[CTRL_PROXY_IOS] Sent get_preference request (requestId: ${requestId}, fileName: ${fileName}, key: ${key})`,
    );

    const result = await promise;
    if (!result.success) {
      throw this.sdkError(result.error, "Failed to get preference");
    }

    return result.found && result.entry ? result.entry : null;
  }

  /**
   * Set a preference value.
   *
   * @param packageName - Target app bundle identifier
   * @param fileName - Suite name
   * @param key - The key to set
   * @param value - The value to set (serialized as string, or null)
   * @param type - The type of the value
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   */
  async setPreference(
    packageName: string,
    fileName: string,
    key: string,
    value: string | null,
    type: KeyValueType,
    timeoutMs: number = 5000,
  ): Promise<PreferenceStoreResolution | undefined> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    const sessionId = this.sessionId?.();
    const mutationToken = this.mutationToken?.(packageName);
    const requestId = this.context.requestManager.generateId("set_preference");
    const promise = this.context.requestManager.register<SetPreferenceResult>(
      requestId,
      "set_preference",
      timeoutMs,
      (_id, _type, _timeout) => ({
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `Set preference timeout after ${timeoutMs}ms`,
      }),
    );

    const message = JSON.stringify({
      type: "set_preference",
      requestId,
      ...this.context.wireDeadlineParams?.("set_preference", timeoutMs),
      appId: packageName,
      fileName,
      key,
      value,
      valueType: type,
      ...(sessionId ? { sessionId } : {}),
      ...(mutationToken ? { mutationToken } : {}),
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
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
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   */
  async removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMs: number = 5000,
  ): Promise<PreferenceStoreResolution | undefined> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    const sessionId = this.sessionId?.();
    const mutationToken = this.mutationToken?.(packageName);
    const requestId = this.context.requestManager.generateId("remove_preference");
    const promise = this.context.requestManager.register<RemovePreferenceResult>(
      requestId,
      "remove_preference",
      timeoutMs,
      (_id, _type, _timeout) => ({
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `Remove preference timeout after ${timeoutMs}ms`,
      }),
    );

    const message = JSON.stringify({
      type: "remove_preference",
      requestId,
      ...this.context.wireDeadlineParams?.("remove_preference", timeoutMs),
      appId: packageName,
      fileName,
      key,
      ...(sessionId ? { sessionId } : {}),
      ...(mutationToken ? { mutationToken } : {}),
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
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
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   */
  async clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMs: number = 5000,
  ): Promise<PreferenceStoreResolution | undefined> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    const sessionId = this.sessionId?.();
    const mutationToken = this.mutationToken?.(packageName);
    const requestId = this.context.requestManager.generateId("clear_preferences");
    const promise = this.context.requestManager.register<ClearPreferencesResult>(
      requestId,
      "clear_preferences",
      timeoutMs,
      (_id, _type, _timeout) => ({
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `Clear preferences timeout after ${timeoutMs}ms`,
      }),
    );

    const message = JSON.stringify({
      type: "clear_preferences",
      requestId,
      ...this.context.wireDeadlineParams?.("clear_preferences", timeoutMs),
      appId: packageName,
      fileName,
      ...(sessionId ? { sessionId } : {}),
      ...(mutationToken ? { mutationToken } : {}),
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
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
