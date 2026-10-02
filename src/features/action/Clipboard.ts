import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice, ClipboardResult } from "../../models";
import { logger } from "../../utils/logger";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { shellQuote } from "../../utils/shellQuote";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";

type ClipboardCtrlProxy = {
  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; text?: string; totalTimeMs: number }>;
};
type ClipboardCtrlProxyFactory = (
  device: BootedDevice,
  adbFactory: AdbClientFactory,
) => ClipboardCtrlProxy;

export class Clipboard {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private ctrlProxyFactory: ClipboardCtrlProxyFactory | undefined;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    ctrlProxyFactory?: ClipboardCtrlProxyFactory,
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.adb = adbFactory.create(device);
    this.ctrlProxyFactory = ctrlProxyFactory;
  }

  async execute(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    signal?: AbortSignal,
  ): Promise<ClipboardResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("clipboard");

    try {
      // Platform-specific clipboard execution
      switch (this.device.platform) {
        case "android":
          return await perf.track("androidClipboard", () =>
            this.executeAndroidClipboard(action, text, signal),
          );
        case "ios":
          return await perf.track("iosClipboard", () =>
            this.executeIOSClipboard(action, text, signal),
          );
        default:
          perf.end();
          return {
            success: false,
            action,
            error: unsupportedPlatformError(this.device.platform, "use the clipboard").message,
          };
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("[Clipboard] Clipboard operation failed", error);
      perf.end();
      return {
        success: false,
        action,
        error: `Failed to execute clipboard ${action}: ${errorMessage(error)}`,
      };
    } finally {
      perf.end();
    }
  }

  private async executeIOSClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    signal?: AbortSignal,
  ): Promise<ClipboardResult> {
    if (action === "copy" && !text) {
      return { success: false, action, error: "Text is required for copy action" };
    }

    throwIfAborted(signal);
    const client = this.getIOSCtrlProxy();
    const result = await awaitWhileRequestIsLive(
      client.requestClipboard(action, text, undefined, undefined, signal),
      signal,
    );

    if (!result.success) {
      return { success: false, action, error: result.error };
    }

    logger.info(`[Clipboard] ${action} via iOS CtrlProxy: ${result.totalTimeMs}ms`);
    return {
      success: true,
      action,
      text: result.text,
      method: "a11y",
    };
  }

  /**
   * Execute Android-specific clipboard operation
   * Tries accessibility service first. Mutating actions can fall back to ADB cmd clipboard;
   * get returns the accessibility result because cmd clipboard is unavailable on Android.
   * @param action - Clipboard action to perform
   * @param text - Text for copy action
   * @returns Result of the clipboard operation
   */
  private async executeAndroidClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    signal?: AbortSignal,
  ): Promise<ClipboardResult> {
    // Validate input
    if (action === "copy" && !text) {
      return {
        success: false,
        action,
        error: "Text is required for copy action",
      };
    }

    // Try accessibility service first (preferred method)
    throwIfAborted(signal);
    const a11yClient = this.getAndroidCtrlProxy();

    try {
      const a11yResult = await awaitWhileRequestIsLive(
        a11yClient.requestClipboard(action, text, undefined, undefined, signal),
        signal,
      );

      if (a11yResult.success) {
        logger.info(`[Clipboard] ${action} via accessibility service: ${a11yResult.totalTimeMs}ms`);
        const a11yClipboardResult: ClipboardResult = {
          success: true,
          action,
          text: a11yResult.text,
          method: "a11y",
        };

        return a11yClipboardResult;
      }

      logger.warn(`[Clipboard] Accessibility service ${action} failed: ${a11yResult.error}`);
      if (action === "get") {
        // On Android 10+, a background service cannot directly read a target app's clipboard.
        // Working read strategies require foreground target-app code, the default IME role, or
        // paste-then-read from a focused editable node. `cmd clipboard get` is not a recovery path
        // on modern Android builds because the shell command is usually unimplemented.
        return {
          success: false,
          action,
          error: a11yResult.error ?? "Accessibility clipboard get failed",
          method: "a11y",
        };
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[Clipboard] Accessibility service error: ${error}`, error);
      if (action === "get") {
        return {
          success: false,
          action,
          error: `Accessibility clipboard get failed: ${errorMessage(error)}`,
          method: "a11y",
        };
      }
    }

    // Fall back to ADB cmd clipboard
    try {
      return await this.executeAdbClipboard(action, text, signal);
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("[Clipboard] Clipboard operation failed", error);
      return {
        success: false,
        action,
        error: `All clipboard methods failed. Last error: ${errorMessage(error)}`,
      };
    }
  }

  private getIOSCtrlProxy(): ClipboardCtrlProxy {
    if (this.ctrlProxyFactory) {
      return this.ctrlProxyFactory(this.device, this.adbFactory);
    }
    return IOSCtrlProxyClient.getInstance(this.device);
  }

  private getAndroidCtrlProxy(): ClipboardCtrlProxy {
    if (this.ctrlProxyFactory) {
      return this.ctrlProxyFactory(this.device, this.adbFactory);
    }
    return AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
  }

  /**
   * Execute clipboard operation via ADB cmd clipboard
   * @param action - Clipboard action to perform
   * @param text - Text for copy action
   * @returns Result of the clipboard operation
   */
  private async executeAdbClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    signal?: AbortSignal,
  ): Promise<ClipboardResult> {
    try {
      switch (action) {
        case "copy": {
          if (!text) {
            return {
              success: false,
              action,
              error: "Text is required for copy action",
            };
          }
          // ADB hands the command to the device shell, so preserve user text as one literal word.
          throwIfAborted(signal);
          const result = await awaitWhileRequestIsLive(
            this.adb.executeCommand(`shell cmd clipboard set ${shellQuote(text)}`),
            signal,
          );

          // Check if cmd clipboard is supported
          if (result.includes("No shell command implementation")) {
            return {
              success: false,
              action,
              error: "cmd clipboard is not supported on this device/API level",
              method: "adb",
            };
          }

          logger.info(`[Clipboard] Set clipboard via ADB cmd clipboard`);
          return {
            success: true,
            action,
            method: "adb",
          };
        }

        case "get": {
          throwIfAborted(signal);
          const result = await awaitWhileRequestIsLive(
            this.adb.executeCommand("shell cmd clipboard get"),
            signal,
          );

          // Check if cmd clipboard is supported
          if (result.includes("No shell command implementation")) {
            return {
              success: false,
              action,
              error: "cmd clipboard is not supported on this device/API level",
              method: "adb",
            };
          }

          logger.info(`[Clipboard] Got clipboard via ADB cmd clipboard`);
          return {
            success: true,
            action,
            text: result.trim(),
            method: "adb",
          };
        }

        case "clear": {
          throwIfAborted(signal);
          const result = await awaitWhileRequestIsLive(
            this.adb.executeCommand("shell cmd clipboard clear"),
            signal,
          );

          // Check if cmd clipboard is supported
          if (result.includes("No shell command implementation")) {
            return {
              success: false,
              action,
              error: "cmd clipboard is not supported on this device/API level",
              method: "adb",
            };
          }

          logger.info(`[Clipboard] Cleared clipboard via ADB cmd clipboard`);
          return {
            success: true,
            action,
            method: "adb",
          };
        }

        case "paste": {
          // For paste, we need to use key event since cmd clipboard doesn't have a paste command
          // First, try to get clipboard content to verify it exists
          throwIfAborted(signal);
          const clipboardContent = await awaitWhileRequestIsLive(
            this.adb.executeCommand("shell cmd clipboard get"),
            signal,
          );

          if (clipboardContent.includes("No shell command implementation")) {
            return {
              success: false,
              action,
              error: "cmd clipboard is not supported on this device/API level",
              method: "adb",
            };
          }

          // Use KEYCODE_PASTE (279) to paste
          throwIfAborted(signal);
          await awaitWhileRequestIsLive(
            this.adb.executeCommand("shell input keyevent KEYCODE_PASTE"),
            signal,
          );

          logger.info(`[Clipboard] Pasted clipboard via ADB keyevent`);
          return {
            success: true,
            action,
            method: "adb",
          };
        }

        default:
          return {
            success: false,
            action,
            error: `Unknown clipboard action: ${action}`,
          };
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("[Clipboard] Clipboard operation failed", error);
      return {
        success: false,
        action,
        error: `ADB clipboard operation failed: ${errorMessage(error)}`,
        method: "adb",
      };
    }
  }
}
