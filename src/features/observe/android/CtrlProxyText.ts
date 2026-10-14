/**
 * CtrlProxyText - Android text delegate.
 *
 * Thin wrapper over SharedTextDelegate.
 */

import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
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
  trace?: string[];
  /** Editor delta captured by the device; internal transport evidence only. */
  insertedText?: string;
  /** Device reconciliation confirmed input consumed by the editor. */
  editorConsumed?: boolean;
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

/** Only the explicit opt-in adds a wire field; older requests keep their exact shape. */
function imeCommitTraceFields(trace?: boolean): { trace?: true } {
  return trace === true ? { trace: true } : {};
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
 * 1. Canonical spelling: NFC normalization.
 * 2. Only request delimiters of real inline-format spans are optional, evaluated
 *    after NFC and line-start block-shortcut removal (/^(>|[-*•+]|\d+[.)]) /gm).
 *    A span is D content D with the same D: backtick (code), ** (bold), ~~ (strike),
 *    * (bold), _ (italic), or ~ (strike). Content is non-empty, contains no LF or
 *    occurrence of D's marker character, and neither starts nor ends with whitespace.
 *    Runs are exact: opening D cannot follow the same marker; closing D cannot
 *    precede it. Opening D must start the text or follow a non-letter/non-digit;
 *    closing D must end the text or precede a non-letter/non-digit ([\p{L}\p{N}]).
 *    Each kind scans independently left to right, allowing different kinds to nest.
 *    Non-code spans with either delimiter inside code are excluded: code content is literal.
 *    Every other marker is required literal text; inserted markers are never stripped.
 *    Matched opening/closing character counts must agree per span (so **x** may
 *    become x, *x*, or **x**, but *bold* cannot become *bold or bold*).
 *    Marker-only requests remain unverifiable and match: a lone closing marker
 *    typed by a separate call cannot be predicted.
 * 3. Line-start block shortcut consumed or replaced by a list marker.
 * 4. Input filters: lower/upper case tokens (including expansions) and decimal-digit value.
 * 5. Input mask: the editor may ADD characters that are not letters, digits or marks
 *    (`[^\p{L}\p{N}\p{M}]`) around the sent text; every sent token must remain in order.
 *    This also accepts added punctuation such as "hi, there" -> "hi, there!".
 * 6. Mention chips and code fences: unpredictable replacements retain subsequence acceptance on the delta.
 * 7. Device success permits exactly one final LF consumed as submit (not CRLF):
 *    a request ending in \n\n must still show the first newline. For a lone \n,
 *    the inserted text must contain no letter, digit or mark.
 */
export function imeInsertedTextMatches(
  insertedText: string,
  text: string,
  options?: { deviceSucceeded?: boolean; editorConsumed?: boolean },
): boolean {
  if (options?.deviceSucceeded === true && text.endsWith("\n") && !text.endsWith("\r\n")) {
    if (text === "\n") {
      return !/[\p{L}\p{N}\p{M}]/u.test(insertedText);
    }
    // Use the strict two-argument matcher so a second newline cannot be forgiven.
    if (imeInsertedTextMatches(insertedText, text.slice(0, -1))) {
      return true;
    }
  }
  return (
    imeInsertedTextStrictMatches(insertedText, text) ||
    (options?.deviceSucceeded === true &&
      options.editorConsumed === true &&
      imeEditorConsumedMatches(insertedText, text))
  );
}

/** Bound additional strict checks, including suffix/newline combinations, on rich-text input. */
function imeEditorConsumedMatches(insertedText: string, text: string): boolean {
  if (insertedText.length === 0 || text.length > 4096) {
    return false;
  }
  let candidates = 0;
  const matches = (candidate: string): boolean => {
    candidates++;
    // Marker-only candidates carry no read-back evidence (the strict matcher skips them).
    return (
      candidate.replace(/[*_~`]/g, "").length > 0 &&
      imeInsertedTextStrictMatches(insertedText, candidate)
    );
  };
  // Try the whole request first, then proper suffixes from longest to shortest.
  for (let start = 0; start < text.length && candidates < 128; start++) {
    const suffix = text.slice(start);
    if (start > 0 && matches(suffix)) {
      return true;
    }
    for (
      let index = suffix.indexOf("\n");
      index >= 0 && candidates < 128;
      index = suffix.indexOf("\n", index + 1)
    ) {
      // A CRLF is one editor unit; this tolerance is for a consumed LF only.
      if (
        text[start + index - 1] !== "\r" &&
        matches(suffix.slice(0, index) + suffix.slice(index + 1))
      ) {
        return true;
      }
    }
  }
  return false;
}

function imeInsertedTextStrictMatches(insertedText: string, text: string): boolean {
  const markers = /[*_~`]/g;
  if (text.replace(markers, "").length === 0) {
    return true;
  }
  // Mirror MENTION_BEFORE_SPACE in ImeCommitDriver.kt, at any token-ending space.
  if (/(^|\s)@[\p{L}\p{N}._-]+ /u.test(text) || text.includes("```")) {
    return imeCommitSubsequenceMatches(insertedText, text);
  }
  // Mirror LINE_START_SHORTCUT in ImeCommitDriver.kt, at each line start.
  const blockShortcut = /^(>|[-*•+]|\d+[.)]) /gm;
  const project = (value: string): string => value.normalize("NFC").replace(blockShortcut, "");
  const field = project(insertedText);
  const sent = project(text);
  // Try fully kept delimiters first. A mask can itself resemble a block shortcut
  // (e.g. *a* -> * a*) or equal a required token beyond an optional closer.
  if (imeCaseInputMaskTokensMatch(insertedText.normalize("NFC"), sent)) {
    return true;
  }
  const spans = imeRequestFormatDelimiters(sent);
  return (
    imeCaseInputMaskTokensMatch(field, sent, spans) || imeConvertedSpansMatch(field, sent, spans)
  );
}

interface ImeInputMaskToken {
  value: string;
  /** Signed span ID: positive for opening characters, negative for closing, zero for literals. */
  delimiter: number;
}

interface ImeFormatDelimiters {
  positions: Int32Array;
  count: number;
}

// Excluding each marker from content bounds backtracking to that marker-free run.
// Edge whitespace is rejected inside the regex so an invalid candidate cannot
// consume a delimiter that could open the next valid span.
// Capture the preceding code point: Bun's Unicode lookbehind can inspect only
// the low surrogate of an astral letter and incorrectly accept that boundary.
const IME_REQUEST_FORMAT_SPANS: readonly (readonly [RegExp, number])[] = [
  [/(^|[^\p{L}\p{N}`])(`[^`\s](?:[^`\n]*[^`\s])?`)(?![\p{L}\p{N}`])/gu, 1],
  [/(^|[^\p{L}\p{N}*])(\*\*[^*\s](?:[^*\n]*[^*\s])?\*\*)(?![\p{L}\p{N}*])/gu, 2],
  [/(^|[^\p{L}\p{N}~])(~~[^~\s](?:[^~\n]*[^~\s])?~~)(?![\p{L}\p{N}~])/gu, 2],
  [/(^|[^\p{L}\p{N}*])(\*[^*\s](?:[^*\n]*[^*\s])?\*)(?![\p{L}\p{N}*])/gu, 1],
  [/(^|[^\p{L}\p{N}_])(_[^_\s](?:[^_\n]*[^_\s])?_)(?![\p{L}\p{N}_])/gu, 1],
  [/(^|[^\p{L}\p{N}~])(~[^~\s](?:[^~\n]*[^~\s])?~)(?![\p{L}\p{N}~])/gu, 1],
];

function imeRequestFormatDelimiters(text: string): ImeFormatDelimiters {
  const positions = new Int32Array(text.length);
  const codeContent = new Uint8Array(text.length);
  let count = 0;
  for (const [pattern, width] of IME_REQUEST_FORMAT_SPANS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[1]!.length;
      const end = start + match[2]!.length;
      if (codeContent[start] || codeContent[end - 1]) {
        continue;
      }
      // Code is scanned first; mark its interior so other kinds cannot consume
      // literal markers there. A code span inside another kind remains optional.
      if (text[start] === "`") {
        codeContent.fill(1, start + width, end - width);
      }
      count++;
      positions.fill(count, start, start + width);
      positions.fill(-count, end - width, end);
    }
  }
  return { positions, count };
}

function* imeInputMaskTokens(
  text: string,
  spans: ImeFormatDelimiters | undefined,
  upperCase: boolean,
): Generator<ImeInputMaskToken, void> {
  let offset = 0;
  for (const codePoint of text) {
    const digit = imeDecimalDigit(codePoint);
    // Lowercase expansions remain atomic, just like imeLowerTokens; uppercase
    // expansions split, just like imeUpperTokens. Delimiters themselves are ASCII.
    const values = upperCase ? digit.toUpperCase() : [digit.toLowerCase()];
    for (const value of values) {
      yield { value, delimiter: spans?.positions[offset] ?? 0 };
    }
    offset += codePoint.length;
  }
}

function imeCaseInputMaskTokensMatch(
  field: string,
  sent: string,
  spans?: ImeFormatDelimiters,
  convertedMarkers?: ReadonlySet<string>,
): boolean {
  return [false, true].some((upperCase) =>
    imeInputMaskTokensMatch(
      imeInputMaskTokens(field, undefined, upperCase),
      Array.from(imeInputMaskTokens(sent, spans, upperCase)),
      spans?.count ?? 0,
      convertedMarkers,
    ),
  );
}

function imeInputMaskTokensMatch(
  field: Generator<ImeInputMaskToken, void>,
  sent: readonly ImeInputMaskToken[],
  spanCount: number,
  convertedMarkers?: ReadonlySet<string>,
): boolean {
  const cursor: ImeInputMaskCursor = { position: 0 };
  const balances = new Int32Array(spanCount);
  for (const { value: token } of field) {
    const candidate = imeInputMaskTokenCandidate(sent, cursor, token);
    if (candidate >= 0) {
      imeRecordDelimiterMatch(balances, sent[candidate]!.delimiter);
      cursor.position = candidate + 1;
    } else if (/[\p{L}\p{N}\p{M}]/u.test(token) || convertedMarkers?.has(token)) {
      return false;
    }
  }
  while (sent[cursor.position]?.delimiter) {
    cursor.position++;
  }
  return cursor.position === sent.length && balances.every((balance) => balance === 0);
}

interface ImeInputMaskCursor {
  position: number;
  run?: ImeDelimiterRun;
}

interface ImeDelimiterRun {
  end: number;
  candidates: Map<string, { positions: number[]; cursor: number }>;
}

function imeInputMaskTokenCandidate(
  sent: readonly ImeInputMaskToken[],
  cursor: ImeInputMaskCursor,
  token: string,
): number {
  if (sent[cursor.position]?.value === token) {
    return cursor.position;
  }
  if (!sent[cursor.position]?.delimiter) {
    return -1;
  }
  if (!cursor.run || cursor.position >= cursor.run.end) {
    cursor.run = imeBufferDelimiterRun(sent, cursor.position);
  }
  return imeDelimiterRunCandidate(cursor.run, cursor.position, token);
}

// Buffer each optional run and its first required token once. Candidate queues
// advance monotonically, so neither repeated nor distinct mask additions rescan it.
function imeBufferDelimiterRun(sent: readonly ImeInputMaskToken[], start: number): ImeDelimiterRun {
  const candidates: ImeDelimiterRun["candidates"] = new Map();
  let end = start;
  while (end < sent.length) {
    const { value, delimiter } = sent[end]!;
    let queue = candidates.get(value);
    if (!queue) {
      queue = { positions: [], cursor: 0 };
      candidates.set(value, queue);
    }
    queue.positions.push(end++);
    if (delimiter === 0) {
      break;
    }
  }
  return { end, candidates };
}

function imeDelimiterRunCandidate(run: ImeDelimiterRun, position: number, token: string): number {
  const queue = run.candidates.get(token);
  if (!queue) {
    return -1;
  }
  while (queue.cursor < queue.positions.length && queue.positions[queue.cursor]! < position) {
    queue.cursor++;
  }
  return queue.positions[queue.cursor] ?? -1;
}

function imeConvertedSpansMatch(field: string, sent: string, spans: ImeFormatDelimiters): boolean {
  const literals: string[] = [];
  const convertedMarkers = new Set<string>();
  for (let offset = 0; offset < sent.length; offset++) {
    const character = sent[offset]!;
    if (spans.positions[offset]) {
      convertedMarkers.add(character);
    } else {
      literals.push(character);
    }
  }
  const converted = literals.join("");
  const normalized = converted.normalize("NFC");
  if (normalized === converted) {
    return false;
  }
  // This path represents ALL spans converted. Unmatched markers of those spans
  // cannot be mask additions here: that would bypass the per-span pairing check.
  return imeCaseInputMaskTokensMatch(field, normalized, undefined, convertedMarkers);
}

function imeRecordDelimiterMatch(balances: Int32Array, delimiter: number): void {
  if (delimiter !== 0) {
    balances[Math.abs(delimiter) - 1]! += Math.sign(delimiter);
  }
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
  return (
    imeCodePointSubsequenceMatches(imeLowerTokens(field), imeLowerTokens(sent)) ||
    imeCodePointSubsequenceMatches(imeUpperTokens(field), imeUpperTokens(sent))
  );
}

function imeLowerTokens(value: string): string[] {
  return Array.from(value, (codePoint) => imeDecimalDigit(codePoint).toLowerCase());
}

function imeUpperTokens(value: string): string[] {
  return Array.from(value, imeDecimalDigit).flatMap((codePoint) =>
    Array.from(codePoint.toUpperCase()),
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
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
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
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
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
    ...[delivery, trace]: [delivery?: "commit" | "keyEvents" | "clearField", trace?: boolean]
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
          ...(delivery === "commit" ? {} : { delivery }),
          timeoutMs: Math.max(1, timeoutMs - 500),
          ...imeCommitTraceFields(trace),
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
