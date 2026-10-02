/**
 * CtrlProxyText - Android text delegate.
 *
 * Thin wrapper over SharedTextDelegate.
 */

import type { InsertTextState } from "./ctrlProxyProtocol";
import { SharedTextDelegate } from "../shared/SharedTextDelegate";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { BaseResult } from "../shared/types";
import type { A11ySetTextResult, DelegateContext } from "./types";
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
  /** Device upper bound on dispatched editing units; absent/zero means unknown or none. */
  committedUnits?: number;
  /** Cancellation could not be acknowledged; the host must retain the temporary IME. */
  sessionUnsafe?: boolean;
}

/** Preserve old APK result shapes: absent/zero count conveys no known dispatch progress. */
export function imeCommitUnitFields(
  result: Pick<ImeCommitActionResult, "committedUnits">,
): Pick<ImeCommitActionResult, "committedUnits"> {
  const { committedUnits } = result;
  return committedUnits !== undefined && committedUnits > 0 ? { committedUnits } : {};
}

// Match ImeCommitDriver's inline span boundaries. Only non-terminal spans incur
// its conversion polling; each can wait 12 x 40ms plus editor read round trips.
const INLINE_FORMAT_SPAN =
  /```|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~/g;

export function imeCommitSegmentCount(text: string): number {
  const matches = Array.from(text.matchAll(INLINE_FORMAT_SPAN));
  if (matches.length === 0) {
    return 1;
  }
  const last = matches[matches.length - 1]!;
  return matches.length + (last.index + last[0].length < text.length ? 1 : 0);
}

export const IME_COMMIT_TIMEOUT = {
  baseMs: 10_000,
  perSegmentMs: 750,
  perCharMs: 20,
  capMs: 25_000,
} as const;

export function imeCommitTimeoutMs(text: string): number {
  // Reserve 5s of the 30s tool budget for cancellation, IME restoration, and observation.
  return Math.min(
    IME_COMMIT_TIMEOUT.capMs,
    IME_COMMIT_TIMEOUT.baseMs +
      IME_COMMIT_TIMEOUT.perSegmentMs * (imeCommitSegmentCount(text) - 1) +
      IME_COMMIT_TIMEOUT.perCharMs * text.length,
  );
}

export class CtrlProxyText extends SharedTextDelegate {
  constructor(context: DelegateContext) {
    super(context);
  }

  async requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }> {
    return sendCommand(this.context, {
      idPrefix: "insertTextState",
      responseType: "insert_text_state",
      messageType: "request_insert_text_state",
      params: {},
      timeoutMs: 5000,
      errorLabel: "Read insert text state",
    });
  }

  async requestInsertText(
    text: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    options?: {
      expectedSuffix?: string;
      acceptsCaretNotPlaced?: boolean;
      precedingState?: InsertTextState;
    },
  ): Promise<A11ySetTextResult> {
    return sendCommand<A11ySetTextResult>(this.context, {
      idPrefix: "insertText",
      responseType: "insert_text",
      messageType: "request_insert_text",
      params: {
        text,
        acceptsCaretNotPlaced: options?.acceptsCaretNotPlaced ?? true,
        ...(options?.expectedSuffix ? { expectedSuffix: options.expectedSuffix } : {}),
        ...(options?.precedingState ? { precedingState: options.precedingState } : {}),
      },
      timeoutMs,
      perf,
      errorLabel: "Insert text",
    });
  }

  async commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs: number = imeCommitTimeoutMs(text),
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents",
  ): Promise<ImeCommitActionResult> {
    let dispatchedId: string | undefined;
    let timedOut = false;
    let result: ImeCommitActionResult;
    try {
      result = await sendCommand<ImeCommitActionResult>(this.context, {
        idPrefix: "commitText",
        responseType: "commit_text",
        messageType: "request_commit_text",
        params: { text, priorImeId, ...(delivery === "keyEvents" ? { delivery } : {}) },
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
        committedUnits?: number;
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
          ...imeCommitUnitFields(ack),
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
