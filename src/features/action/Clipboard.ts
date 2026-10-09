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
import { IosRunnerBusyError } from "../observe/ios/runnerErrorCodes";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import type { KeyboardHierarchyProvider } from "./Keyboard";
import { getFocusedTextField, type FocusedTextField } from "./ClearText";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

type ClipboardCtrlProxy = {
  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<{
    success: boolean;
    error?: string;
    text?: string;
    totalTimeMs: number;
    acknowledged?: boolean;
  }>;
};
type ClipboardCtrlProxyFactory = (
  device: BootedDevice,
  adbFactory: AdbClientFactory,
) => ClipboardCtrlProxy;

/** cmd clipboard can reject with an exec error or exit zero with an unsupported message. */
function isClipboardCommandUnavailable(value: unknown): boolean {
  // The host exec seam wraps production rejections, retaining execFile's error as its cause.
  const cause =
    value !== null && typeof value === "object" && "cause" in value ? value.cause : undefined;
  return [value, cause].some((result) => {
    if (result === null || typeof result !== "object") {
      return false;
    }
    const stdout = "stdout" in result ? String(result.stdout) : "";
    const stderr = "stderr" in result ? String(result.stderr) : "";
    return (
      stdout.includes("No shell command implementation") ||
      stderr.includes("No shell command implementation")
    );
  });
}

export class Clipboard {
  // iOS keyboard minimization animations can lag paste delivery by roughly 1.5 seconds (#9078).
  private static readonly PASTE_VERIFICATION_TIMEOUT_MS = 1_500;
  private static readonly PASTE_VERIFICATION_POLL_MS = 250;
  private device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private ctrlProxyFactory: ClipboardCtrlProxyFactory | undefined;
  private hierarchyProvider: KeyboardHierarchyProvider;
  private timer: Timer;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    ctrlProxyFactory?: ClipboardCtrlProxyFactory,
    hierarchyProvider?: KeyboardHierarchyProvider,
    timer: Timer = defaultTimer,
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.adb = adbFactory.create(device);
    this.ctrlProxyFactory = ctrlProxyFactory;
    this.timer = timer;
    this.hierarchyProvider = hierarchyProvider ?? {
      getViewHierarchy: (signal, options) => {
        // Every verification sample must bypass the iOS cache, including the pre-paste sample.
        IOSCtrlProxyClient.getInstance(device).invalidateCache();
        return new ViewHierarchy(device, adbFactory).getViewHierarchy(
          undefined,
          new NoOpPerformanceTracker(),
          false,
          0,
          signal,
          options?.timeoutMs,
        );
      },
    };
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
    const baseline =
      action === "paste" ? await this.readIOSPasteValueBefore(client, signal) : undefined;
    throwIfAborted(signal);
    let dispatched = false;
    let result: Awaited<ReturnType<ClipboardCtrlProxy["requestClipboard"]>>;
    try {
      result = await awaitWhileRequestIsLive(
        client.requestClipboard(action, text, undefined, undefined, signal, () => {
          // copy sets supplied text and clear is idempotent; only paste risks duplication.
          dispatched = action === "paste";
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof IosRunnerBusyError) {
        // The runner refused it before queuing, so nothing was pasted: a plain retry-safe failure.
        logger.warn("[Clipboard] Runner busy; iOS clipboard command not run", error);
        return { success: false, action, error: errorMessage(error) };
      }
      if (dispatched) {
        logger.warn("[Clipboard] iOS paste reply was not confirmed", error);
        return this.indeterminatePasteResult(errorMessage(error));
      }
      throw error;
    }

    if (!result.success) {
      if (dispatched && !result.acknowledged) {
        return this.indeterminatePasteResult(result.error);
      }
      return { success: false, action, error: result.error };
    }

    const unconfirmed = await this.unconfirmedIOSPaste(baseline, signal);
    if (unconfirmed) {
      return unconfirmed;
    }

    logger.info(`[Clipboard] ${action} via iOS CtrlProxy: ${result.totalTimeMs}ms`);
    return {
      success: true,
      action,
      text: result.text,
      method: "a11y",
    };
  }

  /** A failure result when the paste cannot be reported as applied; `undefined` to report success. */
  private async unconfirmedIOSPaste(
    baseline: { field: FocusedTextField | undefined; pasteboardUnreadable: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<ClipboardResult | undefined> {
    const before = baseline?.field;
    const verification =
      before === undefined ? "unverifiable" : await this.verifyIOSPaste(before, signal);
    if (verification === "unchanged") {
      return {
        success: false,
        action: "paste",
        method: "a11y",
        error:
          "Paste was sent but the focused field's value did not change; nothing appears to have been pasted (outcome unconfirmed). The simulator may have minimized the software keyboard for a hardware keyboard. Try pasting again.",
      };
    }
    if (verification === "unreadable") {
      return {
        success: false,
        action: "paste",
        method: "a11y",
        error:
          "Paste was sent but the focused field's value could not be read after the paste, so the paste is unconfirmed and may not have landed. Observe the field before retrying.",
      };
    }
    if (verification === "unverifiable" && baseline?.pasteboardUnreadable) {
      // The runner pastes through an unreadable pasteboard (Cmd+V needs no text), so with no field
      // comparison there is nothing to back a success claim.
      return this.indeterminatePasteResult(
        "the pasteboard could not be read and the focused field's value could not be compared before and after the paste",
      );
    }
    return undefined;
  }

  private async readIOSPasteValueBefore(
    client: ClipboardCtrlProxy,
    signal?: AbortSignal,
  ): Promise<{ field: FocusedTextField | undefined; pasteboardUnreadable: boolean } | undefined> {
    let pasteboardUnreadable = false;
    try {
      const clipboard = await awaitWhileRequestIsLive(
        client.requestClipboard("get", undefined, undefined, undefined, signal),
        signal,
      );
      if (clipboard.success && !clipboard.text) {
        // A pasteboard known to be empty is refused by the runner, so there is nothing to verify.
        logger.info("[Clipboard] iOS paste verification skipped: clipboard empty");
        return undefined;
      }
      pasteboardUnreadable = !clipboard.success;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        "[Clipboard] iOS clipboard pre-read failed; the field is the only evidence",
        error,
      );
      pasteboardUnreadable = true;
    }
    // Cmd+V needs no pasteboard text, so an unreadable pasteboard still gets a field baseline.
    const field = await this.readIOSFocusedValue(Clipboard.PASTE_VERIFICATION_TIMEOUT_MS, signal);
    return { field, pasteboardUnreadable };
  }

  private async readIOSFocusedValue(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FocusedTextField | undefined> {
    try {
      const hierarchy = await raceWithDeadline(
        () => this.hierarchyProvider.getViewHierarchy(signal, { timeoutMs }),
        { timer: this.timer, timeoutMs, signal, label: "iOS paste verification hierarchy" },
      );
      // An empty or placeholder-only field reads as "" so it still gives a baseline (#9078).
      const field =
        hierarchy && !hierarchy.hierarchy?.error
          ? getFocusedTextField(hierarchy, undefined, { iosEmptyAsBlank: true })
          : undefined;
      if (field?.value === undefined && !field?.secure) {
        logger.info("[Clipboard] iOS paste verification unavailable: no focused editable field");
        return undefined;
      }
      return field;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        "[Clipboard] iOS paste verification hierarchy failed; outcome cannot be checked",
        error,
      );
      return undefined;
    }
  }

  /**
   * "unverifiable" covers a secure field, whose value is never read. "unreadable" means the field
   * had a readable baseline but no readable value by the deadline: the paste is unconfirmed (#9078).
   */
  private async verifyIOSPaste(
    before: FocusedTextField,
    signal?: AbortSignal,
  ): Promise<"changed" | "unchanged" | "unverifiable" | "unreadable"> {
    if (before.secure) {
      logger.info("[Clipboard] iOS paste verification skipped for a secure field");
      return "unverifiable";
    }
    const deadline = this.timer.now() + Clipboard.PASTE_VERIFICATION_TIMEOUT_MS;
    let lastReadable = true;
    for (;;) {
      throwIfAborted(signal);
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        return lastReadable ? "unchanged" : "unreadable";
      }
      const after = await this.readIOSFocusedValue(remaining, signal);
      if (after?.secure) {
        logger.info("[Clipboard] iOS paste verification skipped for a secure field");
        return "unverifiable";
      }
      // A missing hierarchy or field may be transient (keyboard animation), so keep polling.
      lastReadable = after !== undefined;
      if (after !== undefined && after.value !== before.value) {
        return "changed";
      }
      const delay = Math.min(Clipboard.PASTE_VERIFICATION_POLL_MS, deadline - this.timer.now());
      if (delay <= 0) {
        return lastReadable ? "unchanged" : "unreadable";
      }
      await awaitWhileRequestIsLive(this.timer.sleep(delay), signal);
    }
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

    let dispatched = false;
    let ctrlProxyReason: string | undefined;
    try {
      const a11yResult = await awaitWhileRequestIsLive(
        a11yClient.requestClipboard(action, text, undefined, undefined, signal, () => {
          // Only paste can duplicate an input action when replayed.
          dispatched = action === "paste";
        }),
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
      ctrlProxyReason = a11yResult.error;
      if (a11yResult.acknowledged || action === "get") {
        // A device refusal is final. get also has no shell recovery on modern Android:
        // reads require foreground target-app code, the default IME, or paste-then-read.
        return {
          success: false,
          action,
          error: a11yResult.error ?? `Accessibility clipboard ${action} failed`,
          method: "a11y",
        };
      }
      if (dispatched) {
        return this.indeterminatePasteResult(a11yResult.error);
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[Clipboard] Accessibility service error: ${error}`, error);
      ctrlProxyReason = errorMessage(error);
      if (dispatched) {
        return this.indeterminatePasteResult(ctrlProxyReason);
      }
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
      return await this.executeAdbClipboard(action, text, signal, ctrlProxyReason);
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

  private indeterminatePasteResult(reason: string | undefined): ClipboardResult {
    return {
      success: false,
      action: "paste",
      method: "a11y",
      error: `Paste outcome is indeterminate: the request was dispatched but no result was confirmed (${reason ?? "unknown error"}). The paste may have been applied. Do not retry automatically. Observe before retrying.`,
    };
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
    ctrlProxyReason?: string,
  ): Promise<ClipboardResult> {
    const unavailableError = `cmd clipboard is not supported on this device/API level${
      ctrlProxyReason === undefined ? "" : ` (CtrlProxy: ${ctrlProxyReason})`
    }`;
    try {
      switch (action) {
        case "copy": {
          // ADB hands the command to the device shell, so preserve user text as one literal word.
          // executeAndroidClipboard already validated copy text before selecting this fallback.
          throwIfAborted(signal);
          const result = await awaitWhileRequestIsLive(
            this.adb.executeCommand(`shell cmd clipboard set ${shellQuote(text!)}`),
            signal,
          );

          // Check if cmd clipboard is supported
          if (isClipboardCommandUnavailable(result)) {
            return {
              success: false,
              action,
              error: unavailableError,
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
          if (isClipboardCommandUnavailable(result)) {
            return {
              success: false,
              action,
              error: unavailableError,
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
          if (isClipboardCommandUnavailable(result)) {
            return {
              success: false,
              action,
              error: unavailableError,
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
          // Use KEYCODE_PASTE (279) to paste
          throwIfAborted(signal);
          await awaitWhileRequestIsLive(
            this.adb.executeCommand("shell input keyevent KEYCODE_PASTE"),
            signal,
          );

          logger.info(`[Clipboard] Pasted clipboard via ADB keyevent`);
          return { success: true, action, method: "adb" };
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
        error: isClipboardCommandUnavailable(error)
          ? unavailableError
          : `ADB clipboard operation failed: ${errorMessage(error)}`,
        method: "adb",
      };
    }
  }
}
