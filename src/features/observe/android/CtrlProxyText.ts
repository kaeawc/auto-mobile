/**
 * CtrlProxyText - Android text delegate.
 *
 * Thin wrapper over SharedTextDelegate.
 */

import type { SetTextOptions } from "../DeviceService";
import type { InsertTextState } from "./ctrlProxyProtocol";
import { SharedTextDelegate } from "../shared/SharedTextDelegate";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ImeAction } from "../../../models";
import type { ActionTimingResult, BaseResult } from "../shared/types";
import type { A11ySetTextResult, DelegateContext } from "./types";
import { sendCommand } from "../DeviceServiceUtils";
import {
  KEYBOARD_PROFILE_CATALOG_VERSIONS,
  type KeyboardProfileCatalog,
} from "../../action/keyboardProfiles";
import { errorMessage } from "../../../utils/describeUnknownError";
import { TextIndeterminateError } from "../../action/textTransportTimeout";
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
  /** Host transport failed to deliver an unambiguous device result. */
  transportFailure?: boolean;
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

/** Check literal or autoformatted suffixes; undefined means nothing is verifiable. */
export function imeCommitSuffixMatches(committedText: string, text: string): boolean | undefined {
  // Strip exactly INLINE_FORMAT_SPAN's marker characters from both sides so
  // editors that have converted only some spans can still satisfy the check.
  const markers = /[*_~`]/g;
  const projectedText = text.replace(markers, "");
  if (projectedText.length === 0) {
    // Marker-only requests leave no verifiable content: skip, rather than
    // passing accidentally because every string ends with the empty string.
    return undefined;
  }
  return committedText.endsWith(text) || committedText.replace(markers, "").endsWith(projectedText);
}

/**
 * Accept canonical spellings, decimal digit values, and locale-independent case
 * filters. Lowercase expansions stay atomic (İ is not i + a separate dot), while
 * uppercase expansions allow input filters such as straße -> STRASSE.
 * Formatting may remove punctuation/symbols only when sent content remains.
 */
export function imeCommitSubsequenceMatches(committedText: string, text: string): boolean {
  const field = committedText.normalize("NFC");
  const sent = text.normalize("NFC");
  if (imeCaseSubsequenceMatches(field, sent)) {
    return true;
  }
  const formatting = /[^\p{L}\p{N}\p{M}]/gu;
  // Recompose after stripping formatting so e-◌́ still matches canonical é.
  const sentContent = sent.replace(formatting, "").normalize("NFC");
  return (
    sentContent.length > 0 &&
    imeCaseSubsequenceMatches(field.replace(formatting, "").normalize("NFC"), sentContent)
  );
}

function imeCaseSubsequenceMatches(field: string, sent: string): boolean {
  const lowerTokens = (value: string): string[] =>
    Array.from(value, (codePoint) => imeDecimalDigit(codePoint).toLowerCase());
  const upperTokens = (value: string): string[] =>
    Array.from(value, imeDecimalDigit).flatMap((codePoint) => Array.from(codePoint.toUpperCase()));
  return (
    imeCodePointSubsequenceMatches(lowerTokens(field), lowerTokens(sent)) ||
    imeCodePointSubsequenceMatches(upperTokens(field), upperTokens(sent))
  );
}

function imeDecimalDigit(codePoint: string): string {
  if (!/\p{Nd}/u.test(codePoint)) {
    return codePoint;
  }
  const value = codePoint.codePointAt(0)!;
  let start = value;
  // Unicode decimal digits are ordered runs of ten; adjacent sets (e.g. math
  // styles) form longer runs. Modulo ten preserves the value in every set.
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) {
    start--;
  }
  return String((value - start) % 10);
}

function imeCodePointSubsequenceMatches(
  field: readonly string[],
  sent: readonly string[],
): boolean {
  let index = 0;
  for (const codePoint of field) {
    if (codePoint === sent[index]) {
      index++;
    }
    if (index === sent.length) {
      return true;
    }
  }
  return index === sent.length;
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

  override async requestImeAction(
    action: ImeAction,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<ActionTimingResult> {
    let dispatched = false;
    const startMs = this.context.timer.now();
    const unconfirmed = (reason: string, totalTimeMs: number): ActionTimingResult => ({
      success: false,
      action,
      totalTimeMs,
      ...(dispatched ? { retryable: false } : {}),
      error: dispatched
        ? `IME action '${action}' outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). Do not retry automatically. Observe before retrying.`
        : reason,
    });
    try {
      return await sendCommand<ActionTimingResult>(this.context, {
        idPrefix: "imeAction",
        responseType: "ime_action",
        messageType: "request_ime_action",
        params: { action },
        timeoutMs,
        perf,
        abortSignal,
        onDispatch: () => {
          dispatched = true;
          onDispatch?.();
        },
        notConnectedError: () => ({
          success: false,
          action,
          totalTimeMs: 0,
          error: "Not connected",
        }),
        unsupportedCommandError: (_messageType, error) => ({
          success: false,
          action,
          totalTimeMs: 0,
          error,
        }),
        timeoutError: (timeout) => unconfirmed(`IME action timed out after ${timeout}ms`, timeout),
      });
    } catch (error) {
      logger.warn("[CtrlProxyText] IME action transport failed", error);
      return unconfirmed(errorMessage(error), this.context.timer.now() - startMs);
    }
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
    transport: Pick<SetTextOptions, "abortSignal" | "onDispatch" | "deadlineMs"> = {},
  ): Promise<A11ySetTextResult> {
    let dispatched = false;
    const startMs = this.context.timer.now();
    const unconfirmed = (reason: string, totalTimeMs: number): A11ySetTextResult => ({
      success: false,
      totalTimeMs,
      ...(dispatched ? { retryable: false, partialApplication: true } : {}),
      error: dispatched ? new TextIndeterminateError(reason).message : reason,
    });
    try {
      return await sendCommand<A11ySetTextResult>(this.context, {
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
        abortSignal: transport.abortSignal,
        deadlineMs: transport.deadlineMs,
        onDispatch: () => {
          dispatched = true;
          transport.onDispatch?.();
        },
        timeoutError: (timeout) => unconfirmed(`Insert text timed out after ${timeout}ms`, timeout),
      });
    } catch (error) {
      logger.warn("[CtrlProxyText] Insert text transport failed", error);
      return unconfirmed(errorMessage(error), this.context.timer.now() - startMs);
    }
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
        params: {
          text,
          priorImeId,
          ...(delivery === "keyEvents" ? { delivery } : {}),
          timeoutMs: Math.max(1, timeoutMs - 500),
        },
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
            transportFailure: true,
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
        transportFailure: true,
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
