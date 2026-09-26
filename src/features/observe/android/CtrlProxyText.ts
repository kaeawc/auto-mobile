/**
 * CtrlProxyText - Android text delegate.
 *
 * Thin wrapper over SharedTextDelegate.
 */

import { SharedTextDelegate } from "../shared/SharedTextDelegate";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { BaseResult } from "../shared/types";
import type { DelegateContext } from "./types";
import { sendCommand } from "../DeviceServiceUtils";
import {
  KEYBOARD_PROFILE_CATALOG_VERSIONS,
  type KeyboardProfileCatalog,
} from "../../action/keyboardProfiles";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

export interface SetKeyboardProfileResult {
  success: boolean;
  activeProfileId?: string;
  previousProfileId?: string;
  error?: string;
}

export interface ImeCommitActionResult extends BaseResult {
  partialApplication?: boolean;
  /** Cancellation could not be acknowledged; the host must retain the temporary IME. */
  sessionUnsafe?: boolean;
}

export class CtrlProxyText extends SharedTextDelegate {
  constructor(context: DelegateContext) {
    super(context);
  }

  async requestInsertText(
    text: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    return sendCommand<BaseResult>(this.context, {
      idPrefix: "insertText",
      responseType: "insert_text",
      messageType: "request_insert_text",
      params: { text },
      timeoutMs,
      perf,
      errorLabel: "Insert text",
    });
  }

  async commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs: number = 10000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<ImeCommitActionResult> {
    let dispatchedId: string | undefined;
    let timedOut = false;
    let result: ImeCommitActionResult;
    try {
      result = await sendCommand<ImeCommitActionResult>(this.context, {
        idPrefix: "commitText",
        responseType: "commit_text",
        messageType: "request_commit_text",
        params: { text, priorImeId },
        timeoutMs,
        perf,
        abortSignal: signal,
        onDispatch: (id) => {
          dispatchedId = id;
        },
        errorLabel: "Commit text",
        timeoutError: (timeout) => {
          timedOut = true;
          return {
            success: false,
            totalTimeMs: timeout,
            partialApplication: true,
            error: `IME commit response timed out after ${timeout}ms; editor state is unknown`,
          };
        },
      });
      if (!timedOut) {
        return result;
      }
    } catch (error) {
      if (!dispatchedId) {
        throw error;
      }
      result = {
        success: false,
        totalTimeMs: 0,
        partialApplication: true,
        error: errorMessage(error),
      };
    }
    if (!dispatchedId) {
      return result;
    }
    const targetRequestId = dispatchedId;
    try {
      const ack = await sendCommand<{
        success: boolean;
        targetRequestId?: string;
        partialApplication?: boolean;
        error?: string;
      }>(this.context, {
        idPrefix: "cancelImeCommit",
        responseType: "cancel_ime_commit",
        messageType: "request_cancel_ime_commit",
        params: { targetRequestId },
        timeoutMs: 2000,
        cancelScreenshotBackoff: false,
      });
      if (ack.success && ack.targetRequestId === targetRequestId) {
        return {
          ...result,
          partialApplication: result.partialApplication || ack.partialApplication,
        };
      }
    } catch (error) {
      // A lost cancellation acknowledgement cannot prove the editor is quiescent.
      logger.debug(`IME cancellation acknowledgement failed: ${errorMessage(error)}`);
    }
    return {
      ...result,
      success: false,
      partialApplication: true,
      sessionUnsafe: true,
      error: `${result.error ?? "IME commit failed"}; cancellation was not acknowledged`,
    };
  }

  async setKeyboardProfile(
    profileId: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<SetKeyboardProfileResult> {
    return sendCommand<SetKeyboardProfileResult>(this.context, {
      idPrefix: "setKeyboardProfile",
      responseType: "set_keyboard_profile",
      messageType: "request_set_keyboard_profile",
      params: { profileId },
      timeoutMs,
      perf,
      errorLabel: "Set keyboard profile",
    });
  }

  async listKeyboardProfiles(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<KeyboardProfileCatalog & { error?: string }> {
    return sendCommand<KeyboardProfileCatalog & { error?: string }>(this.context, {
      idPrefix: "listKeyboardProfiles",
      responseType: "keyboard_profiles_result",
      messageType: "request_list_keyboard_profiles",
      params: { supportedCatalogVersions: Array.from(KEYBOARD_PROFILE_CATALOG_VERSIONS) },
      timeoutMs,
      perf,
      errorLabel: "List keyboard profiles",
    });
  }
}
