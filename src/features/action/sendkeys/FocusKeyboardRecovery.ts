import { KeyboardOcclusionError } from "../../../models/KeyboardOcclusionError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type {
  SendKeysFocusOptions,
  SendKeysKeyboard,
  SendKeysObserver,
  SendKeysSelector,
  SendKeysTargetFocuser,
} from "../SendKeys";

export interface FocusKeyboardRecoveryDeps {
  platform(): string;
  focuser: SendKeysTargetFocuser;
  /** The injected keyboard, or the default one built for this device. */
  keyboard(): SendKeysKeyboard;
  observer: Pick<SendKeysObserver, "execute">;
}

/**
 * Focuses the target field and, when the IME covers it, closes the keyboard and retries once.
 * Moved out of SendKeys unchanged (#11840).
 */
export class FocusKeyboardRecovery {
  constructor(private readonly deps: FocusKeyboardRecoveryDeps) {}

  async focusWithKeyboardRecovery(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    signal?.throwIfAborted();
    try {
      return await this.deps.focuser.focus(selector, signal, display, options);
    } catch (error) {
      signal?.throwIfAborted();
      if (this.deps.platform() !== "android" || !(error instanceof KeyboardOcclusionError)) {
        throw error;
      }
      // Keyboard.close cannot target a display. Never dismiss on an ambient display
      // when this action is explicitly routed (including display "0").
      if (display !== undefined) {
        logger.warn("[SendKeys] Display-routed target is covered by the IME", error);
        return { success: false, error: error.message };
      }
      logger.warn("[SendKeys] Target is covered by the IME; closing the keyboard", error);
      try {
        return await this.retryFocusAfterKeyboardClose(selector, error, signal, options);
      } catch (recoveryError) {
        signal?.throwIfAborted();
        logger.warn(
          `[SendKeys] IME focus recovery failed: ${errorMessage(recoveryError)}`,
          recoveryError,
        );
        return { success: false, error: errorMessage(recoveryError) };
      }
    }
  }

  async retryFocusAfterKeyboardClose(
    selector: SendKeysSelector,
    occlusion: KeyboardOcclusionError,
    signal?: AbortSignal,
    options?: SendKeysFocusOptions,
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    const keyboard = this.deps.keyboard();
    let dismissal: Awaited<ReturnType<SendKeysKeyboard["execute"]>>;
    try {
      dismissal = await keyboard.execute("close", signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[SendKeys] Keyboard close failed: ${errorMessage(error)}`, error);
      return { success: false, error: occlusion.message };
    }
    signal?.throwIfAborted();
    if (!dismissal.success) {
      return { success: false, error: occlusion.message };
    }
    // Mirror SetUIState's fresh observation and verified-focus requirement. Each
    // focus execution re-resolves the selector against the refreshed hierarchy.
    await this.deps.observer.execute({
      signal,
      freshness: "fresh",
      minTimestamp: 0,
      skipScreenshot: true,
    });
    signal?.throwIfAborted();
    const retry = await this.deps.focuser.focus(selector, signal, undefined, options);
    signal?.throwIfAborted();
    if (retry.success && retry.focusVerified !== true) {
      return {
        success: false,
        error: "Failed to confirm focus on target field after closing the keyboard",
      };
    }
    return retry;
  }
}
