/**
 * CtrlProxy iOS Storage - Delegate for UserDefaults inspection operations.
 *
 * This delegate handles listing, reading, and writing UserDefaults
 * suites on iOS devices via the CtrlProxy WebSocket API.
 * Uses the same wire protocol message types as the Android delegate.
 */

import { logger } from "../../../utils/logger";
import type { DelegateContext } from "./types";
import type {
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

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * List all UserDefaults suites.
   *
   * @param _packageName - Unused on iOS (UserDefaults are per-process), kept for API parity with Android
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of preference files (suites)
   */
  async listPreferenceFiles(
    _packageName: string,
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
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
    logger.debug(`[CTRL_PROXY_IOS] Sent list_preference_files request (requestId: ${requestId})`);

    const result = await promise;
    if (!result.success) {
      throw new Error(result.error || "Failed to list preference files");
    }

    return result.files || [];
  }

  /**
   * Get all key-value entries from a UserDefaults suite.
   *
   * @param _packageName - Unused on iOS, kept for API parity
   * @param fileName - Suite name ("Standard" for default suite, or custom suite name)
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to array of key-value entries
   */
  async getPreferenceEntries(
    _packageName: string,
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
      fileName,
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
    logger.debug(
      `[CTRL_PROXY_IOS] Sent get_preferences request (requestId: ${requestId}, fileName: ${fileName})`,
    );

    const result = await promise;
    if (!result.success) {
      throw new Error(result.error || "Failed to get preference entries");
    }

    return result.entries || [];
  }

  /**
   * Get a single preference entry by key.
   *
   * @param _packageName - Unused on iOS, kept for API parity
   * @param fileName - Suite name
   * @param key - The key to retrieve
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   * @returns Promise resolving to the entry if found, null if not found
   */
  async getPreference(
    _packageName: string,
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
      throw new Error(result.error || "Failed to get preference");
    }

    return result.found && result.entry ? result.entry : null;
  }

  /**
   * Set a preference value.
   *
   * @param _packageName - Unused on iOS, kept for API parity
   * @param fileName - Suite name
   * @param key - The key to set
   * @param value - The value to set (serialized as string, or null)
   * @param type - The type of the value
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   */
  async setPreference(
    _packageName: string,
    fileName: string,
    key: string,
    value: string | null,
    type: KeyValueType,
    timeoutMs: number = 5000,
  ): Promise<void> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

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
      fileName,
      key,
      value,
      valueType: type,
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
    logger.debug(
      `[CTRL_PROXY_IOS] Sent set_preference request (requestId: ${requestId}, fileName: ${fileName}, key: ${key})`,
    );

    const result = await promise;
    if (!result.success) {
      throw new Error(result.error || "Failed to set preference");
    }
  }

  /**
   * Remove a preference entry.
   *
   * @param _packageName - Unused on iOS, kept for API parity
   * @param fileName - Suite name
   * @param key - The key to remove
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   */
  async removePreference(
    _packageName: string,
    fileName: string,
    key: string,
    timeoutMs: number = 5000,
  ): Promise<void> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

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
      fileName,
      key,
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
    logger.debug(
      `[CTRL_PROXY_IOS] Sent remove_preference request (requestId: ${requestId}, fileName: ${fileName}, key: ${key})`,
    );

    const result = await promise;
    if (!result.success) {
      throw new Error(result.error || "Failed to remove preference");
    }
  }

  /**
   * Clear all preferences in a suite.
   *
   * @param _packageName - Unused on iOS, kept for API parity
   * @param fileName - Suite name to clear
   * @param timeoutMs - Maximum time to wait for response in milliseconds
   */
  async clearPreferenceStore(
    _packageName: string,
    fileName: string,
    timeoutMs: number = 5000,
  ): Promise<void> {
    const startTime = this.context.timer.now();

    if (!(await this.context.ensureConnected())) {
      throw new Error("Failed to connect to CtrlProxy");
    }

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
      fileName,
    });

    const ws = this.context.getWebSocket();
    ws?.send(message);
    logger.debug(
      `[CTRL_PROXY_IOS] Sent clear_preferences request (requestId: ${requestId}, fileName: ${fileName})`,
    );

    const result = await promise;
    if (!result.success) {
      throw new Error(result.error || "Failed to clear preferences");
    }
  }
}
