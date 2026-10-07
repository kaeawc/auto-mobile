import { AsyncLocalStorage } from "node:async_hooks";
import { readIosTypedTextField, verifyIosTypedText } from "./iosTypedTextVerification";
import {
  resolveTextCtrlProxyTimeoutMs,
  getTextRequestDeadlineMs,
  TEXT_MCP_REQUEST_HEADROOM_MS,
} from "./textTransportTimeout";
import {
  combineAbortSignals,
  getRequestContext,
  runOutsideRequestContext,
} from "../../utils/AbortContext";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import { selectablePanels } from "../../models/DisplayPanel";
import type { BaseActionResult } from "../../models/BaseActionResult";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { HierarchyTarget } from "../../models/HierarchyTarget";
import { withStaleDisplay } from "../../models/StaleDisplayError";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import type { InsertTextState } from "../observe/android/ctrlProxyProtocol";
import type { BootedDevice, ImeAction, ObserveResult } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  beginPostActionCaptureAction,
  deferTerminalScreenshot,
} from "../../utils/PostActionCaptureContext";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import type { HierarchyCaptureRequest } from "../observe/HierarchyCapture";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { AndroidCtrlProxyClient } from "../observe/android";
import { imeCommitUnitFields } from "../observe/android/CtrlProxyText";
import { IOSCtrlProxyClient } from "../observe/ios";
import {
  clearTextWithKeyEvents,
  verifyKeyEventClear,
  getFocusedTextField,
  getFocusedTextLength,
  hasFocusedTextInput,
} from "./ClearText";
import { InputKey, type InputKeyModifier, type InputKeyName } from "./InputKey";
import {
  focusedFieldIsPassword,
  focusedImeFieldClass,
  imeFailureFields,
  imeCommitExceptionResult,
  IME_PASSWORD_COMMIT_UNAVAILABLE_ERROR,
  LEGACY_IME_PASSWORD_REFUSAL,
  redactPasswordImeFailure,
  verifyImeCommitResult,
  withImeFailure,
  type ImeFailureDiagnostic,
} from "./imeFailureDiagnostics";
import { imeActionFailedAfterTextEntered } from "./imeActionFailedAfterTextEntered";
import type { KeyboardProfileId } from "./keyboardProfiles";
import { TapOnElement, tapFocusFailure, type TapOnFocusResult } from "./TapOnElement";
import { Keyboard } from "./Keyboard";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import { FieldTypeDetector } from "./FieldTypeDetector";
import { DefaultElementParser } from "../utility/ElementParser";
import { toSearchable } from "../utility/SearchableNode";
import {
  quarantineAndroidIme,
  withAndroidImeLock,
  type AndroidImeRecoverySnapshot,
} from "./androidImeLock";
import {
  AndroidImeCatalog,
  AUTO_MOBILE_IME_ID,
  createForegroundUserSource,
  imeUserArgs,
  pinnedUser,
  type ImeSubtypeSnapshot,
  type KeyboardIdentity,
} from "./AndroidImeCatalog";

export const SEND_KEYS_MAX_COMMANDS = 100;
export const SEND_KEYS_MAX_MODIFIERS = 4;
const ANDROID_FOCUSED_INPUT_ERROR = "Android event delivery requires a focused editable field";
const IME_CLEAR_FIELD_UNAVAILABLE_ERROR =
  "IME-mode clear needs the CtrlProxy ime_clear_field_v1 capability, and key-event deletion " +
  "could not size the focused text. Update the CtrlProxy APK, then retry.";
const ANDROID_TYPE_FOCUSED_INPUT_ERROR = `${ANDROID_FOCUSED_INPUT_ERROR}. For printable ASCII, mode: "imeKeyEvents" types without requiring a focused editable node.`;

// Give posted formatters/recomposition a bounded chance to finish after a mismatch.
export const IME_COMMIT_READ_BACK_SETTLE_MS = 150;
/** Bounded settled re-reads used by the clear, eventLast caret and eventAll case read-backs. */
const ANDROID_READ_BACK_ATTEMPTS = 3;
/** CtrlProxy's caret-unknown warning (InsertTextPlanner.kt), removed once the caret is proven. */
export const CARET_UNKNOWN_WARNING =
  /Text was inserted, but the caret could not be placed after it \([^)]*\); the caret position is unknown, so insert any further text with request_insert_text rather than key events/;

/** The field still shows its pre-clear text after the full settle poll (#9943). */
const CLEAR_UNCHANGED_WARNING =
  "The field still shows its pre-clear text after the clear was acknowledged; it may be a mask or permanent prefix at its cleared content, or the app may have refused the clear.";

class ImeRestorationError extends Error {}
interface SendKeysImeRecoverySnapshot extends AndroidImeRecoverySnapshot {
  /** Verify the captured user's state even if the foreground user has since changed. */
  userId?: number;
}

function isImeRestorationFailure(error: unknown): boolean {
  return (
    error instanceof ImeRestorationError ||
    (error instanceof AggregateError &&
      error.errors.some((entry) => entry instanceof ImeRestorationError))
  );
}

class SendKeysBudgetError extends Error {
  constructor() {
    super(
      "sendKeys request budget exhausted; stopping to allow cancellation and keyboard restoration",
    );
  }
}

function isSendKeysBudgetExhausted(signal?: AbortSignal): boolean {
  return signal?.aborted === true && signal.reason instanceof SendKeysBudgetError;
}
import {
  ANDROID_KEYCOMBINATION_MIN_API_LEVEL,
  asciiKeyEventNeedsKeyCombination,
  buildAsciiKeyEventPlan,
  type KeyEventPlan,
} from "../../utils/android-cmdline-tools/asciiKeyEvents";
import type { ProgressCallback } from "./BaseVisualChange";

export const SEND_KEYS_TYPING_MODES = [
  "auto",
  "a11y",
  "eventLast",
  "eventAll",
  "eventOnly",
  "ime",
  "imeKeyEvents",
] as const;
export type SendKeysTypingMode = (typeof SEND_KEYS_TYPING_MODES)[number];
export type ResolvedSendKeysTypingMode = Exclude<SendKeysTypingMode, "auto"> | "xcuiTypeText";
type AndroidSendKeysTypingMode = Exclude<ResolvedSendKeysTypingMode, "xcuiTypeText">;

function isPrintableAscii(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint > 0x7e) {
      return false;
    }
  }
  return true;
}

export function segmentGraphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ segment }) => segment,
  );
}

function graphemeCodePoints(graphemes: string[]): string {
  return graphemes
    .map((grapheme) =>
      Array.from(
        grapheme,
        (char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
      ).join(" "),
    )
    .join(", ");
}

function validateImeKeyEventsText(
  command: SendKeysTypeCommand,
  platform: BootedDevice["platform"],
): string | null {
  if (
    platform === "android" &&
    command.mode === "imeKeyEvents" &&
    !isPrintableAscii(command.text)
  ) {
    return "imeKeyEvents accepts printable ASCII (U+0020–U+007E) only; use mode: ime for other text.";
  }
  return null;
}

/** An older CtrlProxy refused the IME commit because the focused field is a password field. */
function isLegacyImePasswordRefusal(result: TextActionResult): boolean {
  return (
    result.error === LEGACY_IME_PASSWORD_REFUSAL ||
    result.imeFailure?.cause === LEGACY_IME_PASSWORD_REFUSAL
  );
}

/**
 * A password field's typed text never reaches a diagnostic. An older CtrlProxy's password refusal
 * names the APK update: explicit IME mode never switches delivery on its own.
 */
function redactPasswordTypeResult(
  result: TextActionResult,
  text: string,
  passwordField: boolean,
): void {
  const legacyRefusal = isLegacyImePasswordRefusal(result);
  if (passwordField || legacyRefusal) {
    Object.assign(result, redactPasswordImeFailure(result, text));
  }
  if (legacyRefusal) {
    result.error = IME_PASSWORD_COMMIT_UNAVAILABLE_ERROR;
  }
}

/**
 * Diagnostics are produced before the final observation. When the resolved target or the final
 * observation shows a password field, strip typed text from every type command's IME diagnostic.
 */
function redactPasswordCommandResults(
  result: SendKeysResult,
  commands: SendKeysCommand[],
  passwordTarget: boolean,
): SendKeysResult {
  const password =
    passwordTarget || (result.observation ? focusedFieldIsPassword(result.observation) : false);
  if (!password) {
    return result;
  }
  for (const [position, commandResult] of result.commands.entries()) {
    const command = commands[commandResult.index] ?? commands[position];
    if (command?.action === "type" && commandResult.imeFailure) {
      result.commands[position] = redactPasswordImeFailure(commandResult, command.text);
    }
  }
  return result;
}

function getAutoImeFallback(
  operation: SendKeysOperation,
  requestedMode: SendKeysTypingMode,
  keyboardProfile: KeyboardProfileId | undefined,
  resolvedMode: AndroidSendKeysTypingMode,
  passwordField?: boolean,
): AndroidSendKeysTypingMode | undefined {
  // A password field typed through the IME has no safe fallback: eventAll would need the
  // up-front deliverability check, and a mid-run switch could leave part of it typed.
  if (requestedMode !== "auto" || keyboardProfile || resolvedMode !== "ime" || passwordField) {
    return undefined;
  }
  return operation === "insert" ? "eventAll" : "a11y";
}

export const SEND_KEYS_OPERATIONS = ["insert", "replace"] as const;
export type SendKeysOperation = (typeof SEND_KEYS_OPERATIONS)[number];

export const SEND_KEYS_SEMANTIC_KEYS = [
  "next",
  "previous",
  "done",
  "search",
  "send",
  "go",
] as const;
export type SendKeysSemanticKey = (typeof SEND_KEYS_SEMANTIC_KEYS)[number];
export type SendKeysKey = InputKeyName | SendKeysSemanticKey;

export interface SendKeysSelector {
  elementId?: string;
  testTag?: string;
  text?: string;
  textAny?: string[];
}

export interface SendKeysFocusOptions {
  container?: ElementContainerSelector;
  selectionStrategy?: ElementSelectionStrategy;
  /** Resolve the field in the app or the AutoMobile overlay only (issue #9305). */
  target?: HierarchyTarget;
}

export interface SendKeysTypeCommand {
  action: "type";
  text: string;
  operation?: SendKeysOperation;
  mode?: SendKeysTypingMode;
  keyboardProfile?: KeyboardProfileId;
}

export interface SendKeysKeyCommand {
  action: "key";
  key: SendKeysKey;
  modifiers?: InputKeyModifier[];
}

export interface SendKeysClearCommand {
  action: "clear";
}

export type SendKeysCommand = SendKeysTypeCommand | SendKeysKeyCommand | SendKeysClearCommand;

export interface SendKeysCommandResult extends BaseActionResult {
  index: number;
  action: SendKeysCommand["action"];
  success: boolean;
  textLength?: number;
  operation?: SendKeysOperation;
  requestedMode?: SendKeysTypingMode;
  resolvedMode?: ResolvedSendKeysTypingMode;
  key?: SendKeysKey;
  modifiers?: InputKeyModifier[];
  partialApplication?: boolean;
  imeFailure?: ImeFailureDiagnostic;
  committedGraphemes?: number;
  /** Device upper bound; this is not the verified committedGraphemes count. */
  committedUnits?: number;
  error?: string;
  retryable?: boolean;
  verified?: boolean;
  warning?: string;
  backend?: "autoMobileIme";
  capability?: "semanticText";
  keyboard?: KeyboardIdentity;
}

export interface SendKeysResult extends BaseActionResult {
  success: boolean;
  completedCommands: number;
  failedIndex?: number;
  commands: SendKeysCommandResult[];
  observation?: ObserveResult;
  error?: string;
  retryable?: boolean;
  warning?: string;
}

interface SendKeysFailure {
  index: number;
  error: string;
}

interface SendKeysCommandExecution {
  results: SendKeysCommandResult[];
  failure?: SendKeysFailure;
  restorationFailed?: boolean;
}

export interface SendKeysCommandExecutor {
  resetCaretState?(): void;
  withImeSpan?(action: () => Promise<SendKeysCommandExecution>): Promise<SendKeysCommandExecution>;
  type(
    command: SendKeysTypeCommand,
    signal?: AbortSignal,
    display?: string,
  ): Promise<SendKeysCommandResult>;
  key(
    command: SendKeysKeyCommand,
    signal?: AbortSignal,
    onDispatch?: () => void,
    display?: string,
  ): Promise<SendKeysCommandResult>;
  clear(
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ success: boolean; error?: string; retryable?: boolean; warning?: string }>;
}

export interface SendKeysTargetFocuser {
  focus(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ): Promise<
    Pick<TapOnFocusResult, "success" | "error" | "focusVerified" | typeof tapFocusFailure> & {
      /** The resolved target is a password field. */
      passwordField?: boolean;
    }
  >;
}

export interface SendKeysKeyboard {
  execute(action: "close", signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
}

export interface SendKeysObserver extends Pick<ObserveScreen, "captureScreenshot"> {
  execute(options?: {
    hierarchyOnly?: boolean;
    display?: string;
    signal?: AbortSignal;
    freshness?: HierarchyCaptureRequest["freshness"];
    minTimestamp?: number;
    skipScreenshot?: boolean;
    skipAccessibilityAudit?: boolean;
  }): Promise<ObserveResult>;
}

export interface SendKeysTimestampProvider {
  now(): Promise<number>;
}

export interface SendKeysDependencies {
  displayTransitions?: DisplayTransitionReader;
  lastRenderedObservation?: RenderedObservationReader;
  executor?: SendKeysCommandExecutor;
  focuser?: SendKeysTargetFocuser;
  keyboard?: SendKeysKeyboard;
  observer?: SendKeysObserver;
  timestampProvider?: SendKeysTimestampProvider;
  timer?: Timer;
}

interface SendKeysRouting extends SendKeysFocusOptions {
  onCommandStart?: () => void;
  onDispatch?: () => void;
  onCommandResult?: (result: SendKeysCommandResult) => void;
  display?: string;
  displayId?: number;
  assertCurrent?: () => void;
}

export type TextActionResult = {
  success: boolean;
  retryable?: boolean;
  warning?: string;
  caretPlaced?: boolean;
  resultingTextLength?: number;
  error?: string;
  partialApplication?: boolean;
  imeFailure?: ImeFailureDiagnostic;
  /** Internal stage supplied by transport/restoration boundaries. */
  imeFailureStage?: ImeFailureDiagnostic["stage"];
  committedGraphemes?: number;
  /** Device upper bound; this is not the verified committedGraphemes count. */
  committedUnits?: number;
  sessionUnsafe?: boolean;
};

export interface SendKeysTextClient {
  /** Optional for older clients/APKs; captured before the host dispatches key events. */
  readInsertTextState?(): Promise<InsertTextState | undefined>;
  replace(text: string): Promise<TextActionResult>;
  insert(
    text: string,
    options?: {
      expectedSuffix?: string;
      acceptsCaretNotPlaced?: boolean;
      precedingState?: InsertTextState;
      timeoutMs?: number;
      deadlineMs?: number;
      abortSignal?: AbortSignal;
      onDispatch?: () => void;
    },
  ): Promise<TextActionResult>;
  clear(signal?: AbortSignal): Promise<TextActionResult>;
  ime(action: ImeAction, signal?: AbortSignal, onDispatch?: () => void): Promise<TextActionResult>;
  supportsImeCommit(): Promise<boolean>;
  supportsImeKeyEvents(): Promise<boolean>;
  supportsImeClearField(): Promise<boolean>;
  /** CtrlProxy commits (and clears) through the IME into password fields. */
  supportsImePasswordCommit(): Promise<boolean>;
  supportsKeyboardProfiles(): Promise<boolean>;
  setKeyboardProfile(
    id: string,
  ): Promise<{ success: boolean; previousProfileId?: string; error?: string }>;
  commitViaIme(
    text: string,
    priorImeId: string | null,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents" | "clearField",
  ): Promise<TextActionResult>;
}

type AndroidClearState = { kind: "applied" } | { kind: "pending" } | { kind: "unreadable" };

/** Field text and collapsed caret expected after the eventLast prefix insert (UTF-16 units). */
interface EventLastCaretExpectation {
  text: string;
  caret: number;
}

interface AndroidEventAllProgress {
  mutated: boolean;
  committedGraphemes: number;
  pendingKeyText: string;
  precedingState?: InsertTextState;
  warnings: string[];
  lastInsert?: TextActionResult;
  sinceLastInsertEvents: boolean;
}

type DefaultImeReadResult =
  | { success: true; imeId: string | null }
  | { success: false; error: string };

export interface SendKeysInputKey {
  press(
    key: InputKeyName,
    timeoutMs?: number,
    frameContext?: string,
    modifiers?: readonly InputKeyModifier[],
  ): Promise<{ success: boolean; error?: string; verified?: boolean; warning?: string }>;
}

interface ImeCommitRouting {
  focusedFieldClass?: string | null;
  /** The focused field is a password field: its typed text never reaches logs or diagnostics. */
  passwordField?: boolean;
  delivery?: "clearField";
  signal?: AbortSignal;
  display?: string;
  focusedInputVerified?: boolean;
}

export interface SendKeysPlatformDependencies {
  timer?: Timer;
  textClient?: SendKeysTextClient;
  inputKey?: SendKeysInputKey;
}

interface ImeCommitProgress {
  result: TextActionResult;
  safeToRestore: boolean;
}

interface ActiveImeCommitOptions {
  text: string;
  operation: SendKeysOperation;
  keyboardProfile: KeyboardProfileId | undefined;
  prior: string | null;
  wasEnabled: boolean;
  priorSubtype: ImeSubtypeSnapshot;
  routing?: ImeCommitRouting;
  mode?: "ime" | "imeKeyEvents";
}

type ImeSpanSnapshot = Pick<ActiveImeCommitOptions, "prior" | "wasEnabled" | "priorSubtype">;

interface AndroidImeSpan {
  snapshot?: ImeSpanSnapshot;
  lastType?: { text: string; focusedFieldClass?: string | null; passwordField?: boolean };
  safeToRestore: boolean;
  restorationFailed?: boolean;
  releaseLock?: () => void;
  lockCompletion?: Promise<void>;
}

interface AndroidTypeOptions {
  text: string;
  operation: SendKeysOperation;
  mode: AndroidSendKeysTypingMode;
  keyboardProfile: KeyboardProfileId | undefined;
  autoImeFallback?: AndroidSendKeysTypingMode;
  routing?: ImeCommitRouting;
  focusedInputVerified?: boolean;
}

export class DefaultSendKeysCommandExecutor implements SendKeysCommandExecutor {
  private readonly adb: AdbExecutor;
  private readonly textClient: SendKeysTextClient;
  private readonly inputKey: SendKeysInputKey;
  private readonly observer: SendKeysObserver;
  private readonly timer: Timer;
  private androidKeyCombinationSupported: Promise<boolean> | undefined;
  private androidCaretUnsafe = false;
  /** Foreground user pinned for one IME span; set and cleared under the device IME lock. */
  private imeUserId: number | undefined;
  /** Set while a type command targets a password field: diagnostics never name its characters. */
  private typingPasswordField = false;
  private readonly imeSpanContext = new AsyncLocalStorage<AndroidImeSpan>();

  private get imeSpan(): AndroidImeSpan | undefined {
    return this.imeSpanContext.getStore();
  }

  // IME-mode typing captures the prior IME and profile, then restores both. The shared
  // per-device lock also protects persistent keyboard selection from a concurrent restore.

  constructor(
    private readonly device: BootedDevice,
    adbFactory: AdbClientFactory,
    observer: SendKeysObserver,
    dependencies: SendKeysPlatformDependencies = {},
  ) {
    this.adb = adbFactory.create(device);
    this.observer = observer;
    this.timer = dependencies.timer ?? defaultTimer;
    this.inputKey = dependencies.inputKey ?? new InputKey(device, adbFactory);
    this.textClient = dependencies.textClient ?? this.createTextClient(adbFactory);
  }

  async withImeSpan(
    action: () => Promise<SendKeysCommandExecution>,
  ): Promise<SendKeysCommandExecution> {
    // Scope state to this call, including concurrent calls sharing this executor.
    return this.imeSpanContext.run({ safeToRestore: true }, () => this.finishImeSpan(action));
  }

  private async acquireImeSpan(span: AndroidImeSpan, signal?: AbortSignal): Promise<void> {
    if (span.releaseLock) {
      return;
    }
    const admission = Promise.withResolvers<void>();
    const active = Promise.withResolvers<void>();
    // Keep the existing shared mutex callback alive until the loop's finally restores.
    // Acquire lazily so non-IME commands never inherit IME admission/quarantine failures.
    const completion = withAndroidImeLock(
      this.device.deviceId,
      async () => {
        span.releaseLock = active.resolve;
        admission.resolve();
        await active.promise;
      },
      signal,
      { recoverQuarantined: (snapshot) => this.verifySafeImeRecovery(snapshot, signal) },
    );
    void completion.catch(admission.reject);
    await admission.promise;
    span.lockCompletion = completion;
  }

  private async finishImeSpan(
    action: () => Promise<SendKeysCommandExecution>,
  ): Promise<SendKeysCommandExecution> {
    let execution: SendKeysCommandExecution | undefined;
    let failure: unknown;
    try {
      execution = await action();
    } catch (error) {
      logger.warn("[SendKeys] IME command span failed", error);
      failure = error;
    } finally {
      try {
        await this.restoreImeSpan();
      } catch (restoreError) {
        logger.warn("[SendKeys] IME span restoration failed", restoreError);
        if (failure !== undefined) {
          throw new AggregateError(
            [failure, restoreError],
            `${errorMessage(failure)}; ${errorMessage(restoreError)}`,
          );
        }
        this.reportImeSpanRestoreFailure(execution!, restoreError);
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
    execution!.restorationFailed = execution!.restorationFailed || this.imeSpan?.restorationFailed;
    return execution!;
  }

  private reportImeSpanRestoreFailure(
    execution: SendKeysCommandExecution,
    restoreError: unknown,
  ): void {
    // Prefer the IME-backed type whose commit needed the restore; a span whose types all
    // resolved elsewhere still reports the failure on the last command rather than crashing.
    const result =
      execution.results.findLast(
        (entry) =>
          entry.action === "type" &&
          (entry.resolvedMode === "ime" || entry.resolvedMode === "imeKeyEvents"),
      ) ?? execution.results.at(-1)!;
    result.error = result.success
      ? `Text commit succeeded, but ${errorMessage(restoreError)}`
      : `${result.error ?? "Text commit failed."} ${errorMessage(restoreError)}`;
    result.success = false;
    const lastType = this.imeSpan?.lastType;
    if (lastType && result.action === "type") {
      const failed = withImeFailure(result, lastType.text, "restoration", {
        focusedFieldClass: lastType.focusedFieldClass,
      });
      result.imeFailure = (
        lastType.passwordField ? redactPasswordImeFailure(failed, lastType.text) : failed
      ).imeFailure;
    }
    execution.failure = { index: result.index, error: result.error };
    execution.restorationFailed = true;
  }

  private async restoreImeSpan(): Promise<void> {
    const span = this.imeSpan;
    if (!span) {
      return;
    }
    const snapshot = span.snapshot;
    // Consume the snapshot before cleanup so a failed restore is never retried implicitly.
    span.snapshot = undefined;
    try {
      if (snapshot && !span.safeToRestore) {
        const recovery =
          snapshot.prior === null
            ? 'run "keyboard listImes" and select an enabled IME, or restart the daemon.'
            : `run "keyboard setIme ${snapshot.prior}" or restart the daemon.`;
        throw new ImeRestorationError(
          `Original keyboard restoration was skipped after an unacknowledged cancellation; ${recovery}`,
        );
      }
      if (snapshot) {
        await this.restoreIme(snapshot.prior, snapshot.wasEnabled, snapshot.priorSubtype);
      }
    } catch (error) {
      span.restorationFailed = true;
      logger.warn("[SendKeys] Active IME span restoration failed", error);
      throw error;
    } finally {
      // Clear the pinned user before releasing the lock to another call on this executor.
      if (span.releaseLock) {
        this.imeUserId = undefined;
      }
      span.releaseLock?.();
      span.releaseLock = undefined;
      await span.lockCompletion;
      span.lockCompletion = undefined;
    }
  }

  async type(
    command: SendKeysTypeCommand,
    signal?: AbortSignal,
    display?: string,
  ): Promise<SendKeysCommandResult> {
    signal?.throwIfAborted();
    const operation = command.operation ?? "insert";
    const requestedMode = command.mode ?? "auto";
    let resolvedMode = this.resolveMode(requestedMode);
    const baseResult = {
      index: -1,
      action: "type" as const,
      textLength: Array.from(command.text).length,
      operation,
      requestedMode,
      resolvedMode: this.reportedMode(resolvedMode),
    };
    try {
      const validationError = this.validateTypeCommand(command);
      if (validationError) {
        return {
          ...baseResult,
          ...this.imeResultFields(baseResult.resolvedMode),
          success: false,
          error: validationError,
        };
      }
      const routing = await this.resolveAutoPasswordMode(requestedMode, operation, signal, display);
      resolvedMode = routing.mode;
      baseResult.resolvedMode = this.reportedMode(resolvedMode);
      this.typingPasswordField = routing.passwordField === true;
      // After the mode update, so a refusal reports the key-event route it was checked for.
      await this.verifyPasswordRouting(routing, command.text, signal);
      const autoImeFallback = getAutoImeFallback(
        operation,
        requestedMode,
        command.keyboardProfile,
        resolvedMode,
        routing.passwordField,
      );
      const result: TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode } =
        this.device.platform === "ios"
          ? await this.executeIosType(command.text, operation, signal, display)
          : await this.executeAndroidType({
              text: command.text,
              operation,
              mode: resolvedMode,
              keyboardProfile: command.keyboardProfile,
              autoImeFallback,
              routing: {
                signal,
                display,
                focusedInputVerified: routing.focusedInputVerified,
                focusedFieldClass: routing.focusedFieldClass,
                passwordField: routing.passwordField,
              },
              focusedInputVerified: routing.focusedInputVerified,
            });
      this.recordCaretState(result);
      redactPasswordTypeResult(result, command.text, routing.passwordField === true);
      return {
        ...baseResult,
        success: result.success,
        ...(result.retryable === false ? { retryable: false } : {}),
        error: result.error,
        ...this.textWarningFields(result),
        ...(result.partialApplication ? { partialApplication: true } : {}),
        committedGraphemes: result.committedGraphemes,
        ...imeCommitUnitFields(result),
        ...imeFailureFields(result),
        ...(result.resolvedMode ? { resolvedMode: result.resolvedMode } : {}),
        ...this.imeResultFields(result.resolvedMode ?? baseResult.resolvedMode),
      };
    } catch (error) {
      // A restore failure still needs its recovery instruction after cancellation.
      if (!isImeRestorationFailure(error)) {
        this.checkAbort(signal, error);
      }
      logger.warn("[SendKeys] Text command failed", error);
      return {
        ...baseResult,
        ...this.imeResultFields(baseResult.resolvedMode),
        success: false,
        error: errorMessage(error),
      };
    }
  }

  private imeResultFields(mode: ResolvedSendKeysTypingMode) {
    return this.device.platform === "android" && mode === "ime"
      ? {
          backend: "autoMobileIme" as const,
          capability: "semanticText" as const,
          keyboard: { component: this.commitImeId, package: AUTO_MOBILE_IME_ID.split("/")[0] },
        }
      : {};
  }

  private validateTypeCommand(command: SendKeysTypeCommand): string | null {
    const profileError = this.validateKeyboardProfile(command);
    if (profileError) {
      return profileError;
    }
    return validateImeKeyEventsText(command, this.device.platform);
  }

  private validateKeyboardProfile(command: SendKeysTypeCommand): string | null {
    if (!command.keyboardProfile) {
      return null;
    }
    if (command.mode && command.mode !== "auto" && command.mode !== "ime") {
      return "keyboardProfile requires mode: ime (or auto).";
    }
    if (this.device.platform !== "android") {
      return "keyboardProfile is Android-only; select an Android device.";
    }
    return null;
  }

  async key(
    command: SendKeysKeyCommand,
    signal?: AbortSignal,
    onDispatch?: () => void,
    display?: string,
  ): Promise<SendKeysCommandResult> {
    signal?.throwIfAborted();
    // Explicit keys can move the caret, mutate the selection, or change focus (including IME
    // semantic actions). Subsequent typing must use the service's new reported selection.
    this.resetCaretState();
    const modifiers = command.modifiers ?? [];
    if (isSemanticKey(command.key)) {
      if (this.device.platform === "android") {
        const focusResult = await this.requireFocusedAndroidInput(signal, undefined, display);
        if (!focusResult.success) {
          return {
            index: -1,
            action: "key",
            key: command.key,
            modifiers,
            success: false,
            error: focusResult.error,
          };
        }
      }
      const result = await this.textClient.ime(command.key, signal, onDispatch);
      return {
        index: -1,
        action: "key",
        key: command.key,
        modifiers,
        success: result.success,
        ...(result.retryable === false ? { retryable: false } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    }

    const result = await this.inputKey.press(command.key, undefined, undefined, modifiers);
    return {
      index: -1,
      action: "key",
      key: command.key,
      modifiers,
      success: result.success,
      ...(result.verified === undefined ? {} : { verified: result.verified }),
      ...(result.warning === undefined ? {} : { warning: result.warning }),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async clear(signal?: AbortSignal, display?: string): Promise<TextActionResult> {
    signal?.throwIfAborted();
    this.resetCaretState();
    if (this.device.platform !== "android") {
      return this.textClient.clear(this.device.platform === "ios" ? signal : undefined);
    }
    if (this.imeSpan) {
      return this.executeAndroidImeCommit("", "insert", undefined, {
        signal,
        display,
        delivery: "clearField",
      });
    }
    const { result: clearResult, unchangedWarning } = await this.clearAndVerifyAndroid(
      signal,
      display,
    );
    if (clearResult.success) {
      return this.withTextWarnings(clearResult, [unchangedWarning]);
    }
    logger.warn(`[SendKeys] Android accessibility clear failed: ${clearResult.error}`);
    const focusResult = await this.requireFocusedAndroidInput(signal, undefined, display);
    if (!focusResult.success) {
      return focusResult;
    }
    const textLength = getFocusedTextLength(focusResult.hierarchy, undefined, true);
    if (textLength === undefined) {
      return {
        success: false,
        error: "Cannot determine focused text length for ADB clear fallback",
      };
    }
    return this.clearEventOnlyForReplace(textLength, signal, display);
  }

  /**
   * set_text("") is acknowledged before the app applies it; a following a11y insert plans from a
   * fresh node snapshot and would otherwise write old + new text (#9884). The text read before the
   * clear is what an unapplied clear still shows. Shared by the `clear` command and the clear that
   * precedes an eventAll/eventLast replace (#9940).
   */
  private async clearAndVerifyAndroid(
    signal?: AbortSignal,
    display?: string,
    clear: () => Promise<TextActionResult> = () => this.textClient.clear(),
    passwordField = false,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }> {
    const preClearText = await this.readTextBeforeClear(signal, display, passwordField);
    this.checkAbort(signal);
    const result = await clear();
    if (!result.success) {
      return { result };
    }
    const unchangedWarning = await this.verifyAndroidClearApplied(preClearText, signal, display);
    return { result, ...(unchangedWarning === undefined ? {} : { unchangedWarning }) };
  }

  /**
   * Focused text before a clear, or undefined when there is nothing to verify (empty field, or an
   * unreadable one, which is logged). Hint-aware: placeholder text counts as empty.
   */
  private async readTextBeforeClear(
    signal?: AbortSignal,
    display?: string,
    passwordField = false,
  ): Promise<string | undefined> {
    try {
      const snapshot = this.readFocusedTextSnapshot(
        await this.readFreshObservation(signal, display),
      );
      if (snapshot === undefined && passwordField) {
        // A password field is masked by design; an unverifiable clear is expected, not a fault.
        logger.debug("[SendKeys] Password field is masked; the clear will not be verified");
      } else if (snapshot === undefined) {
        logger.warn(
          "[SendKeys] Focused text is unreadable before the clear; it will not be verified",
        );
      }
      return snapshot && snapshot.length > 0 ? snapshot.text : undefined;
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn(`[SendKeys] Pre-clear read unavailable: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  /**
   * Poll until the acknowledged clear is visible, i.e. the field no longer shows the pre-clear
   * text. Any other content (empty, hint, a mask or permanent prefix) counts as applied. Text that
   * is still unchanged after the full poll is a settled state (a mask or permanent prefix already
   * at its cleared content, or a refused clear), so the clear stays successful with a warning
   * rather than failing the call (#9943). An unreadable field is retried, then passes.
   */
  private async verifyAndroidClearApplied(
    preClearText: string | undefined,
    signal?: AbortSignal,
    display?: string,
  ): Promise<string | undefined> {
    if (preClearText === undefined) {
      return undefined;
    }
    let state: AndroidClearState = { kind: "unreadable" };
    for (let attempt = 0; attempt < ANDROID_READ_BACK_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.timer.sleep(IME_COMMIT_READ_BACK_SETTLE_MS);
      }
      state = await this.readClearState(preClearText, signal, display);
      if (state.kind === "applied") {
        return undefined;
      }
    }
    if (state.kind === "pending") {
      logger.warn(`[SendKeys] ${CLEAR_UNCHANGED_WARNING}`);
      return CLEAR_UNCHANGED_WARNING;
    }
    logger.warn("[SendKeys] The clear could not be verified: the focused field stayed unreadable");
    return undefined;
  }

  private async readClearState(
    preClearText: string,
    signal?: AbortSignal,
    display?: string,
  ): Promise<AndroidClearState> {
    try {
      const snapshot = this.readFocusedTextSnapshot(
        await this.readFreshObservation(signal, display),
      );
      if (snapshot === undefined) {
        return { kind: "unreadable" };
      }
      return snapshot.length === 0 || snapshot.text !== preClearText
        ? { kind: "applied" }
        : { kind: "pending" };
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn(`[SendKeys] Clear read-back unavailable: ${errorMessage(error)}`, error);
      return { kind: "unreadable" };
    }
  }

  private async readFreshObservation(
    signal?: AbortSignal,
    display?: string,
  ): Promise<ObserveResult> {
    this.checkAbort(signal);
    const observation = await this.observer.execute({
      signal,
      freshness: "fresh",
      skipScreenshot: true,
      ...(display === undefined ? {} : { display }),
    });
    this.checkAbort(signal);
    return observation;
  }

  /** Hint-aware length plus the text; undefined when the field cannot be read. */
  private readFocusedTextSnapshot(
    observation: ObserveResult,
  ): { text: string; length: number } | undefined {
    const hierarchy = observation.viewHierarchy;
    if (observation.freshness?.isFresh === false || !hierarchy || hierarchy.hierarchy.error) {
      return undefined;
    }
    // Hint-aware, like ClearText.verifyKeyEventClear: placeholder text counts as empty.
    const length = getFocusedTextLength(hierarchy);
    if (length === undefined) {
      return undefined;
    }
    const text = this.readFocusedText(observation);
    if (length === 0) {
      return { text: text ?? "", length };
    }
    return text === undefined ? undefined : { text, length };
  }

  private resolveMode(requestedMode: SendKeysTypingMode): AndroidSendKeysTypingMode {
    return requestedMode === "auto" ? "ime" : requestedMode;
  }

  resetCaretState(): void {
    this.androidCaretUnsafe = false;
  }

  private async insertText(
    text: string,
    options?: Parameters<SendKeysTextClient["insert"]>[1],
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    const result = await this.textClient.insert(
      text,
      signal ? { ...options, abortSignal: signal } : options,
    );
    this.recordCaretState(result);
    return result;
  }

  private recordCaretState(result: TextActionResult): void {
    // Older APKs omit this field. Only an explicit failure forbids later key-event typing.
    if (this.device.platform === "android" && result.caretPlaced === false) {
      this.androidCaretUnsafe = true;
    }
  }

  private reportedMode(mode: AndroidSendKeysTypingMode): ResolvedSendKeysTypingMode {
    return this.device.platform === "ios" ? "xcuiTypeText" : mode;
  }

  private async resolveAutoPasswordMode(
    requestedMode: SendKeysTypingMode,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<{
    mode: AndroidSendKeysTypingMode;
    focusedInputVerified: boolean;
    verifyPasswordDeliverable: boolean;
    focusedFieldClass?: string | null;
    passwordField?: boolean;
  }> {
    if (this.device.platform !== "android" || requestedMode !== "auto") {
      return {
        mode: this.resolveMode(requestedMode),
        focusedInputVerified: false,
        verifyPasswordDeliverable: false,
      };
    }
    let focusedFieldClass: string | null = null;
    const password = await this.isFocusedAndroidPasswordField(
      operation,
      signal,
      display,
      (observation) => {
        focusedFieldClass = focusedImeFieldClass(observation);
      },
    );
    const focusedInputVerified = password !== undefined;
    if (password && (await this.textClient.supportsImePasswordCommit())) {
      // The CtrlProxy IME commits and clears password fields like any other field.
      return {
        mode: "ime",
        focusedInputVerified,
        verifyPasswordDeliverable: false,
        focusedFieldClass,
        passwordField: true,
      };
    }
    return {
      mode: password ? (operation === "insert" ? "eventAll" : "a11y") : "ime",
      focusedInputVerified,
      verifyPasswordDeliverable: password === true && operation === "insert",
      focusedFieldClass,
      ...(password ? { passwordField: true } : {}),
    };
  }

  private async verifyPasswordRouting(
    routing: { verifyPasswordDeliverable: boolean },
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (routing.verifyPasswordDeliverable) {
      await this.requirePasswordTextDeliverable(text, signal);
    }
  }

  /**
   * Auto insert into a password field is delivered as key events, because CtrlProxy refuses
   * `request_insert_text` on password fields. A character with no key event (non-ASCII, or an
   * uppercase letter / shifted symbol below API 31) would be refused mid-run after the earlier
   * characters were already typed (#9941). Decide up front so nothing is typed in that case.
   */
  private async requirePasswordTextDeliverable(text: string, signal?: AbortSignal): Promise<void> {
    const undeliverable: string[] = [];
    for (const grapheme of segmentGraphemes(text)) {
      signal?.throwIfAborted();
      if (!(await this.getEventAllKeyEventPlan(grapheme))) {
        undeliverable.push(grapheme);
      }
    }
    if (undeliverable.length === 0) {
      return;
    }
    // Never name the characters: they are part of a password.
    const nonAscii = undeliverable.filter((grapheme) => !isPrintableAscii(grapheme)).length;
    const reasons = [
      ...(nonAscii > 0 ? [`${nonAscii} non-ASCII (no key event exists)`] : []),
      ...(undeliverable.length > nonAscii
        ? [
            `${undeliverable.length - nonAscii} uppercase or shifted (key events need Android 12, API 31, or newer)`,
          ]
        : []),
    ];
    throw new ActionableError(
      `Nothing was typed: the text for the focused password field contains ${undeliverable.length} character(s) that cannot be sent as key events on this device (${reasons.join("; ")}), and Android password fields refuse text insertion, so typing would leave part of the password entered. Use operation: "replace" to set the whole value at once.`,
    );
  }

  private async isFocusedAndroidPasswordField(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
    onObservation?: (observation: ObserveResult) => void,
  ): Promise<boolean | undefined> {
    const observation = await this.observer.execute({
      signal,
      freshness: "fresh",
      skipScreenshot: true,
      ...(display === undefined ? {} : { display }),
    });
    onObservation?.(observation);
    const hierarchy = observation.viewHierarchy;
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      // Auto insert already reads focus for password routing. Reject before dispatch
      // rather than trusting an IME acknowledgement with no readable editable target.
      if (operation === "insert") {
        throw new ActionableError(ANDROID_TYPE_FOCUSED_INPUT_ERROR);
      }
      // Replace still dispatches; distinguish absent focus from a focused non-password field.
      return undefined;
    }
    const parser = new DefaultElementParser();
    const detector = new FieldTypeDetector();
    for (const root of parser.extractRootNodes(hierarchy)) {
      let password = false;
      parser.traverseNode(root, (node) => {
        const element = parser.extractNodeProperties(node);
        if (
          (element.focused === true || element.focused === "true") &&
          detector.isPasswordField(element)
        ) {
          password = true;
        }
      });
      if (password) {
        return true;
      }
    }
    return false;
  }

  private async executeIosType(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    signal?.throwIfAborted();
    const resolvedMode = "xcuiTypeText" as const;
    if (operation === "replace") {
      const clearResult = await this.textClient.clear(signal);
      if (!clearResult.success) {
        return { ...clearResult, resolvedMode };
      }
      signal?.throwIfAborted();
    }

    const before = await readIosTypedTextField(this.observer, this.timer, signal, display);
    signal?.throwIfAborted();

    // iOS has one text-delivery mechanism: XCUITest typeText. Preserve the
    // requested cross-platform mode in metadata, but report the actual mechanism.
    const deadlineMs = getTextRequestDeadlineMs();
    const result = await this.textClient.insert(text, {
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      timeoutMs: resolveTextCtrlProxyTimeoutMs(
        text,
        deadlineMs === undefined ? undefined : deadlineMs - this.timer.now(),
      ),
      abortSignal: signal,
    });
    if (!result.success) {
      return {
        ...(operation === "replace" ? markPartialAfterMutation(result) : result),
        resolvedMode,
      };
    }
    return {
      ...(await verifyIosTypedText(text, before, this.observer, this.timer, signal, display)),
      resolvedMode,
    };
  }

  private async executeAndroidType(
    options: AndroidTypeOptions,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const {
      text,
      operation,
      mode,
      keyboardProfile,
      autoImeFallback,
      routing = {},
      focusedInputVerified = false,
    } = options;
    const { signal, display } = routing;
    await this.prepareTypingMode(mode, signal);
    if (operation === "replace") {
      this.resetCaretState();
    }
    switch (mode) {
      case "a11y":
        return operation === "replace"
          ? this.textClient.replace(text)
          : this.insertText(text, undefined, signal);
      case "eventLast":
        return this.executeAndroidEventLast(text, operation, signal, display);
      case "eventAll":
        return this.executeAndroidEventAll(text, operation, signal, focusedInputVerified, display);
      case "eventOnly":
        return this.executeAndroidEventOnly(text, operation, signal, display);
      case "ime":
        return this.executeAndroidImeOrFallback(
          text,
          operation,
          keyboardProfile,
          autoImeFallback,
          routing,
        );
      case "imeKeyEvents":
        return this.executeAndroidImeCommit(
          text,
          operation,
          keyboardProfile,
          routing,
          "imeKeyEvents",
        );
    }
  }

  private async prepareTypingMode(mode: AndroidSendKeysTypingMode, signal?: AbortSignal) {
    // A non-IME typing mode ends the span BEFORE delivery. A later IME type may
    // reactivate; interleaved key/clear commands deliberately retain the active IME.
    if (mode !== "ime" && mode !== "imeKeyEvents") {
      await this.restoreImeSpan();
      this.checkAbort(signal);
    }
  }

  private async executeAndroidImeOrFallback(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    autoImeFallback: AndroidSendKeysTypingMode | undefined,
    routing: ImeCommitRouting = {},
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const { signal } = routing;
    if (!autoImeFallback) {
      return this.executeAndroidImeCommit(text, operation, keyboardProfile, routing);
    }
    if (await this.textClient.supportsImeCommit()) {
      const result = await this.executeAndroidImeCommit(text, operation, keyboardProfile, routing);
      if (!result.imeActivationFailed) {
        return result;
      }
    }
    try {
      const fallback = await this.executeAndroidType({
        text,
        operation,
        mode: autoImeFallback,
        keyboardProfile,
        autoImeFallback: undefined,
        routing,
      });
      return { ...fallback, resolvedMode: fallback.resolvedMode ?? autoImeFallback };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[SendKeys] Fallback text command failed", error);
      return { success: false, error: errorMessage(error), resolvedMode: autoImeFallback };
    }
  }

  private async executeAndroidImeCommit(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    routing: ImeCommitRouting = {},
    mode: "ime" | "imeKeyEvents" = "ime",
  ): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode; imeActivationFailed?: boolean }
  > {
    const { signal } = routing;
    signal?.throwIfAborted();
    if (this.imeSpan) {
      this.imeSpan.lastType = {
        text,
        focusedFieldClass: routing.focusedFieldClass,
        passwordField: routing.passwordField,
      };
      await this.acquireImeSpan(this.imeSpan, signal);
      return this.runAndroidImeCommit(text, operation, keyboardProfile, routing, mode);
    }
    // Serialize the whole capture→activate→commit→restore section per device so a
    // second call cannot borrow/restore the IME while this one is mid-flight (#7464).
    return withAndroidImeLock(
      this.device.deviceId,
      async () => {
        try {
          return await this.runAndroidImeCommit(text, operation, keyboardProfile, routing, mode);
        } finally {
          this.imeUserId = undefined;
        }
      },
      signal,
      { recoverQuarantined: (snapshot) => this.verifySafeImeRecovery(snapshot, signal) },
    );
  }

  /**
   * Every `ime` and `settings` command of one span (read, activate, restore) must target the
   * same user, so the foreground user is resolved once here. `ime` defaults to the current
   * user and `settings` to user 0.
   */
  private async pinImeUser(
    signal?: AbortSignal,
  ): Promise<{ success: true } | { success: false; error: string }> {
    try {
      this.imeUserId = await createForegroundUserSource(this.adb).foregroundUserId(signal);
      return { success: true };
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn("[SendKeys] Failed to resolve the foreground Android user", error);
      return {
        success: false,
        error: `Failed to resolve the foreground Android user: ${errorMessage(error)}`,
      };
    }
  }

  /** The pinned user as ` --user <id>` command text; empty for user 0. */
  private imeUserFlag(): string {
    if (this.imeUserId === undefined) {
      throw new Error("IME user was not pinned before an IME command.");
    }
    const args = imeUserArgs(this.imeUserId);
    return args.length === 0 ? "" : ` ${args.join(" ")}`;
  }

  private pinnedImeCatalog(): AndroidImeCatalog {
    if (this.imeUserId === undefined) {
      throw new Error("IME user was not pinned before an IME command.");
    }
    return new AndroidImeCatalog(this.adb, this.device.deviceId, pinnedUser(this.imeUserId));
  }

  private async verifySafeImeRecovery(
    snapshot: SendKeysImeRecoverySnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (snapshot.wasEnabled === undefined) {
      return false;
    }
    if (snapshot.imeId === AUTO_MOBILE_IME_ID) {
      return false;
    }
    try {
      const catalog = await new AndroidImeCatalog(
        this.adb,
        this.device.deviceId,
        snapshot.userId === undefined
          ? createForegroundUserSource(this.adb)
          : pinnedUser(snapshot.userId),
      ).pinForeground(signal);
      const state = await catalog.list(signal);
      const safe = state.installed.some(
        (ime) => ime.id === snapshot.imeId && ime.enabled && ime.active,
      );
      const commitImeEnabled =
        state.installed.find((ime) => ime.id === AUTO_MOBILE_IME_ID)?.enabled ?? false;
      const commitImeStateMatches = snapshot.wasEnabled ? commitImeEnabled : !commitImeEnabled;
      return (
        commitImeStateMatches &&
        safe &&
        state.activeImeId === snapshot.imeId &&
        (await catalog.readSubtype(snapshot.imeId, signal)).id === snapshot.subtypeId
      );
    } catch (error) {
      logger.warn("[SendKeys] Quarantined keyboard recovery could not be verified", error);
      return false;
    }
  }

  private async runAndroidImeCommit(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    routing: ImeCommitRouting = {},
    mode: "ime" | "imeKeyEvents" = "ime",
  ): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode; imeActivationFailed?: boolean }
  > {
    const { signal } = routing;
    this.checkAbort(signal);
    if (!(await this.textClient.supportsImeCommit())) {
      this.checkAbort(signal);
      const error =
        "IME commit is not available: the installed control-proxy build does not advertise request_commit_text (re-cut/update the APK).";
      logger.warn(`[SendKeys] ${error}`);
      return withImeFailure({ success: false, error }, text, "unsupportedCapability", {
        focusedFieldClass: routing.focusedFieldClass,
      });
    }
    this.checkAbort(signal);
    if (mode === "imeKeyEvents" && !(await this.textClient.supportsImeKeyEvents())) {
      this.checkAbort(signal);
      return withImeFailure(
        { success: false, error: "IME key events are unavailable: update the control-proxy APK." },
        text,
        "unsupportedCapability",
        { focusedFieldClass: routing.focusedFieldClass },
      );
    }
    this.checkAbort(signal);
    if (mode === "imeKeyEvents" && this.androidCaretUnsafe) {
      return withImeFailure(
        {
          success: false,
          error:
            "imeKeyEvents requires a known caret; use eventAll insertion or move the caret first",
        },
        text,
        "commit",
        { focusedFieldClass: routing.focusedFieldClass, textMayHaveBeenApplied: false },
      );
    }

    const profileSupport = await this.checkKeyboardProfileSupport(keyboardProfile);
    this.checkAbort(signal);
    if (!profileSupport.success) {
      return withImeFailure(
        { ...profileSupport, resolvedMode: mode },
        text,
        "unsupportedCapability",
        { focusedFieldClass: routing.focusedFieldClass },
      );
    }

    const captured = await this.captureImeSpanSnapshot(signal);
    if (!captured.success) {
      return withImeFailure(captured, text, "activationBinding", {
        focusedFieldClass: routing.focusedFieldClass,
      });
    }

    return withImeFailure(
      await this.commitWithActiveIme({
        text,
        operation,
        keyboardProfile,
        ...captured.snapshot,
        routing,
        mode,
      }),
      text,
      "commit",
      { focusedFieldClass: routing.focusedFieldClass },
    );
  }

  private async captureImeSpanSnapshot(
    signal?: AbortSignal,
  ): Promise<{ success: true; snapshot: ImeSpanSnapshot } | { success: false; error: string }> {
    if (this.imeSpan?.snapshot) {
      return { success: true, snapshot: this.imeSpan.snapshot };
    }
    const captured = await this.captureImeState(signal);
    if (!captured.success) {
      return captured;
    }
    const { prior, wasEnabled, priorSubtype } = captured;

    return { success: true, snapshot: { prior, wasEnabled, priorSubtype } };
  }

  /** Pins the foreground user, then reads the IME state that the commit must restore. */
  private async captureImeState(
    signal?: AbortSignal,
  ): Promise<
    | { success: true; prior: string | null; wasEnabled: boolean; priorSubtype: ImeSubtypeSnapshot }
    | { success: false; error: string }
  > {
    const pinned = await this.pinImeUser(signal);
    this.checkAbort(signal);
    if (!pinned.success) {
      return pinned;
    }
    const priorResult = await this.readDefaultIme();
    this.checkAbort(signal);
    if (!priorResult.success) {
      return priorResult;
    }
    const prior = priorResult.imeId;
    const enabledResult = await this.readCommitImeEnabled();
    this.checkAbort(signal);
    if (!enabledResult.success) {
      return enabledResult;
    }
    const priorSubtype = await this.pinnedImeCatalog().readSubtype(
      prior ?? AUTO_MOBILE_IME_ID,
      signal,
    );
    return { success: true, prior, wasEnabled: enabledResult.enabled, priorSubtype };
  }

  private async commitWithActiveIme(
    options: ActiveImeCommitOptions,
  ): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode; imeActivationFailed?: boolean }
  > {
    const {
      text,
      operation,
      keyboardProfile,
      prior,
      wasEnabled,
      priorSubtype,
      routing = {},
      mode = "ime",
    } = options;
    const { signal } = routing;
    this.checkAbort(signal);
    const profileResult = await this.setRequestedKeyboardProfile(keyboardProfile);
    if (!profileResult.success) {
      return withImeFailure({ ...profileResult, resolvedMode: mode }, text, "activationBinding", {
        focusedFieldClass: routing.focusedFieldClass,
      });
    }
    const previousProfileId = profileResult.previousProfileId;
    if (signal?.aborted) {
      await this.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      this.checkAbort(signal);
    }

    if (!(await this.activateCommitImeForSpan(options))) {
      let restoreFailure: string | undefined;
      try {
        await this.restoreIme(prior, wasEnabled, priorSubtype);
      } catch (error) {
        restoreFailure = errorMessage(error);
      } finally {
        await this.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      }
      return withImeFailure(
        {
          success: false,
          error: `Failed to activate the IME for text commit.${restoreFailure ? ` ${restoreFailure}` : ""}`,
          // A fallback is safe only after the original IME was restored.
          imeActivationFailed: !restoreFailure,
        },
        text,
        "activationBinding",
        { focusedFieldClass: routing.focusedFieldClass },
      );
    }

    const { outcome, failure, safeToRestore } = await this.performImeCommit(
      text,
      operation,
      prior,
      routing,
      mode,
      { ...priorSubtype, wasEnabled },
    );
    if (safeToRestore) {
      await this.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      return this.restoreAfterImeCommit(prior, wasEnabled, priorSubtype, outcome, failure, mode);
    }
    if (failure !== undefined) {
      throw failure;
    }
    return outcome!;
  }

  private async activateCommitImeForSpan(options: ActiveImeCommitOptions): Promise<boolean> {
    if (this.imeSpan?.snapshot) {
      return true;
    }
    const activated = await this.activateCommitIme(options.wasEnabled);
    if (activated && this.imeSpan) {
      const { prior, wasEnabled, priorSubtype } = options;
      this.imeSpan.snapshot = { prior, wasEnabled, priorSubtype };
    }
    return activated;
  }

  private async prepareImeCommitClear(
    operation: SendKeysOperation,
    routing: ImeCommitRouting,
    prior: string | null,
    priorSubtype: ImeSubtypeSnapshot & { wasEnabled: boolean },
    progress: ImeCommitProgress,
  ): Promise<{ outcome?: TextActionResult; warning?: string }> {
    if (operation !== "replace" && routing.delivery !== "clearField") {
      return {};
    }
    const supportsClearField = await this.textClient.supportsImeClearField();
    this.checkAbort(routing.signal);
    if (!supportsClearField) {
      // IME mode never uses the accessibility clear: it breaks a rich-text editor's live
      // formatting until the editor resets (#10408). Delete with key events instead.
      const cleared = await this.clearImeFieldWithKeyEvents(routing.signal, routing.display);
      if (routing.delivery === "clearField") {
        progress.result = cleared;
      }
      return cleared.success && routing.delivery !== "clearField" ? {} : { outcome: cleared };
    }
    const { result, unchangedWarning } = await this.clearAndVerifyAndroid(
      routing.signal,
      routing.display,
      async () => {
        const cleared = await this.textClient.commitViaIme("", null, routing.signal, "clearField");
        // Record safety before verification can abort or exhaust the request budget.
        progress.safeToRestore = this.canRestoreAfterImeCommit(cleared, prior, priorSubtype);
        if (routing.delivery === "clearField") {
          progress.result = cleared;
        }
        return cleared;
      },
      routing.passwordField === true,
    );
    if (!result.success || !progress.safeToRestore || routing.delivery === "clearField") {
      return { outcome: this.withTextWarnings(result, [unchangedWarning]) };
    }
    return { warning: unchangedWarning };
  }

  /**
   * IME-mode clear for a CtrlProxy without `ime_clear_field_v1`: key-event deletion sized from
   * the focused field, or an update hint when the length is unknown.
   */
  private async clearImeFieldWithKeyEvents(
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    const focusResult = await this.requireFocusedAndroidInput(signal, undefined, display);
    if (!focusResult.success) {
      return focusResult;
    }
    const textLength = getFocusedTextLength(focusResult.hierarchy, undefined, true);
    if (textLength === undefined) {
      return { success: false, error: IME_CLEAR_FIELD_UNAVAILABLE_ERROR };
    }
    logger.info("[SendKeys] CtrlProxy lacks ime_clear_field_v1; clearing with key events");
    return this.clearEventOnlyForReplace(textLength, signal, display);
  }

  private async performImeCommit(
    text: string,
    operation: SendKeysOperation,
    prior: string | null,
    routing: ImeCommitRouting,
    mode: "ime" | "imeKeyEvents",
    priorSubtype: ImeSubtypeSnapshot & { wasEnabled: boolean },
  ): Promise<{
    outcome?: TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode };
    failure?: unknown;
    safeToRestore: boolean;
  }> {
    const { signal } = routing;
    const progress: ImeCommitProgress = { result: { success: false }, safeToRestore: true };
    try {
      this.checkAbort(signal);
      const cleared = await this.prepareImeCommitClear(
        operation,
        routing,
        prior,
        priorSubtype,
        progress,
      );
      this.checkAbort(signal);
      if (cleared.outcome) {
        return {
          outcome: { ...cleared.outcome, resolvedMode: mode },
          safeToRestore: progress.safeToRestore,
        };
      }
      const clearWarning = cleared.warning;
      const result = await this.textClient.commitViaIme(
        text,
        this.imeSpan ? null : prior,
        signal,
        mode === "imeKeyEvents" ? "keyEvents" : "commit",
      );
      progress.safeToRestore = this.canRestoreAfterImeCommit(result, prior, priorSubtype);
      progress.result = result;
      if (result.success && mode === "ime" && text.length > 0) {
        const verifiedResult = await this.verifyImeCommit(result, text, routing, operation);
        return {
          outcome: {
            ...this.withTextWarnings(this.describeImeCommitFailure(verifiedResult), [clearWarning]),
            resolvedMode: mode,
          },
          safeToRestore: progress.safeToRestore,
        };
      }
      return {
        outcome: {
          ...this.withTextWarnings(
            this.describeImeCommitFailure(
              withImeFailure(
                operation === "replace" ? markPartialAfterMutation(result) : result,
                text,
                "commit",
                { focusedFieldClass: routing.focusedFieldClass },
              ),
            ),
            [clearWarning],
          ),
          resolvedMode: mode,
        },
        safeToRestore: progress.safeToRestore,
      };
    } catch (error) {
      if (progress.result.success && isSendKeysBudgetExhausted(signal)) {
        logger.warn("[SendKeys] Budget expired after IME acknowledgement", error);
        return {
          outcome: {
            ...progress.result,
            resolvedMode: mode,
            warning: [
              progress.result.warning,
              "Delivery was acknowledged but not verified before the request budget expired.",
            ]
              .filter(Boolean)
              .join(" "),
          },
          safeToRestore: progress.safeToRestore,
        };
      }
      return {
        ...imeCommitExceptionResult(
          error,
          signal,
          progress.result,
          text,
          routing.focusedFieldClass,
        ),
        safeToRestore: progress.safeToRestore,
      };
    }
  }

  private verifyImeCommit(
    result: TextActionResult,
    text: string,
    routing: ImeCommitRouting,
    operation: SendKeysOperation,
  ): Promise<TextActionResult> {
    const { signal, display } = routing;
    return verifyImeCommitResult(result, text, {
      timer: this.timer,
      settleMs: IME_COMMIT_READ_BACK_SETTLE_MS,
      observe: () =>
        this.observer.execute({
          signal,
          freshness: "fresh",
          skipScreenshot: true,
          // Reuse focused-element extraction without device-state collection or audits.
          hierarchyOnly: true,
          ...(display === undefined ? {} : { display }),
        }),
      checkAbort: (error) => this.checkAbort(signal, error),
      lacksRequiredFocus: (observation) => this.imeReadBackLacksRequiredFocus(observation, routing),
      focusedText: (observation) => this.readImeCommitText(observation, operation, text),
      focusError: ANDROID_TYPE_FOCUSED_INPUT_ERROR,
      passwordField: routing.passwordField,
      // Explicit modes skip the pre-type observe; the read-back still shows a password field.
      isPasswordField: focusedFieldIsPassword,
    });
  }

  private imeReadBackLacksRequiredFocus(
    observation: ObserveResult,
    routing: ImeCommitRouting,
  ): boolean {
    // Auto-submit/navigation can remove focus after a legitimate commit. A passed
    // pre-check makes that read-back unverifiable, like an unreadable field.
    return (
      !routing.focusedInputVerified &&
      observation.viewHierarchy !== undefined &&
      !hasFocusedTextInput(observation.viewHierarchy)
    );
  }

  private readImeCommitText(
    observation: ObserveResult,
    operation: SendKeysOperation,
    sent: string,
  ): string | undefined {
    const text = this.readFocusedText(observation);
    if (!text || this.readFocusedTextSnapshot(observation)?.length !== 0) {
      return text;
    }
    // The field shows only its hint, which is not delivered text (#10252): a hint such as
    // "Search settings" must not satisfy the suffix/subsequence match for "set". Only text
    // that could itself have produced the hint is indistinguishable, so it stays unverified.
    // Rich-text editors may consume markers or change case, so compare the same marker-free,
    // case-insensitive views the IME suffix matcher uses.
    const hint = text.replace(KEY_EVENT_FORMAT_MARKERS, "").toLowerCase();
    const projected = sent.replace(KEY_EVENT_FORMAT_MARKERS, "").toLowerCase();
    const couldBeTyped =
      projected.length === 0 ||
      (operation === "replace" ? hint === projected : hint.endsWith(projected));
    return couldBeTyped ? undefined : "";
  }

  private describeImeCommitFailure(result: TextActionResult): TextActionResult {
    if (result.success || (result.committedUnits ?? 0) <= 0) {
      return result;
    }
    return {
      ...result,
      error: `${result.error ?? "IME commit failed"}; up to ${result.committedUnits} editing units were dispatched before the commit stopped`,
    };
  }

  private readFocusedText(observation: ObserveResult): string | undefined {
    const detector = new FieldTypeDetector();
    const focused = observation.focusedElement;
    if (focused && String(focused.focused) === "true" && detector.detect(focused) === "text") {
      if (detector.isPasswordField(focused)) {
        return undefined;
      }
      return this.searchableText(focused);
    }
    if (!observation.viewHierarchy || !hasFocusedTextInput(observation.viewHierarchy)) {
      return undefined;
    }
    // ClearText already selects focused editable controls, including custom editors
    // with set_text actions, and preserves password metadata for unreadable values.
    const editable = getFocusedTextField(observation.viewHierarchy);
    if (editable !== undefined) {
      return editable.secure ? undefined : editable.value;
    }
    const parser = new DefaultElementParser();
    for (const root of parser.extractRootNodes(observation.viewHierarchy)) {
      let found: string | undefined;
      parser.traverseNode(root, (node) => {
        const element = parser.extractNodeProperties(node);
        if (element.focused === true || element.focused === "true") {
          if (detector.isPasswordField(element)) {
            return;
          }
          found = this.searchableText(element);
        }
      });
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  private searchableText(element: Parameters<typeof toSearchable>[0]): string | undefined {
    const searchable = toSearchable(element);
    return (
      searchable.textSources.value ??
      searchable.textSources.text ??
      (searchable.capturedTextLength === 0 ? "" : undefined)
    );
  }

  private async restoreAfterImeCommit(
    prior: string | null,
    wasEnabled: boolean,
    priorSubtype: ImeSubtypeSnapshot,
    outcome: (TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }) | undefined,
    failure: unknown,
    mode: "ime" | "imeKeyEvents",
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    try {
      if (!this.imeSpan) {
        await this.restoreIme(prior, wasEnabled, priorSubtype);
      }
    } catch (restoreError) {
      const restoreMessage = errorMessage(restoreError);
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, restoreError],
          `${errorMessage(failure)}; ${restoreMessage}`,
        );
      }
      logger.warn(`[SendKeys] IME restoration failed: ${errorMessage(restoreError)}`, restoreError);
      if (outcome && !outcome.success) {
        return { ...outcome, error: `${outcome.error ?? "Text commit failed."} ${restoreMessage}` };
      }
      return {
        ...outcome,
        success: false,
        error: `Text commit succeeded, but ${restoreMessage}`,
        resolvedMode: mode,
        imeFailureStage: "restoration",
      };
    }
    if (failure !== undefined) {
      throw failure;
    }
    return outcome!;
  }

  private checkAbort(signal?: AbortSignal, error?: unknown): void {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
  }

  private canRestoreAfterImeCommit(
    result: TextActionResult,
    prior: string | null,
    subtype: ImeSubtypeSnapshot & { wasEnabled: boolean },
  ): boolean {
    if (result.sessionUnsafe) {
      if (this.imeSpan) {
        this.imeSpan.safeToRestore = false;
      }
      const snapshot: SendKeysImeRecoverySnapshot | undefined =
        prior === null
          ? undefined
          : {
              imeId: prior,
              subtypeId: subtype.id,
              wasEnabled: subtype.wasEnabled,
              userId: this.imeUserId,
            };
      quarantineAndroidIme(this.device.deviceId, snapshot);
      return false;
    }
    return true;
  }

  private async checkKeyboardProfileSupport(
    profile?: KeyboardProfileId,
  ): Promise<TextActionResult> {
    if (!profile || (await this.textClient.supportsKeyboardProfiles())) {
      return { success: true };
    }
    const error =
      "The installed control-proxy build does not support keyboard profiles; update/re-cut the APK.";
    logger.warn(`[SendKeys] ${error}`);
    return { success: false, error };
  }

  private async setRequestedKeyboardProfile(
    profile?: KeyboardProfileId,
  ): Promise<{ success: boolean; previousProfileId?: string; error?: string }> {
    if (!profile) {
      return { success: true };
    }
    const result = await this.textClient.setKeyboardProfile(profile);
    return result.success
      ? result
      : { success: false, error: result.error ?? "Failed to set keyboard profile." };
  }

  private async restoreKeyboardProfileIfNeeded(
    requested?: KeyboardProfileId,
    previous?: string,
  ): Promise<void> {
    if (requested && previous && previous !== requested) {
      await this.restoreKeyboardProfile(previous);
    }
  }

  private async restoreKeyboardProfile(profileId: string): Promise<void> {
    try {
      const result = await runOutsideRequestContext(() =>
        this.textClient.setKeyboardProfile(profileId),
      );
      if (!result.success) {
        logger.warn(
          `[SendKeys] Failed to restore keyboard profile: ${result.error ?? "unknown error"}`,
        );
      }
    } catch (error) {
      logger.warn("[SendKeys] Failed to restore keyboard profile", error);
    }
  }

  private async readDefaultIme(): Promise<DefaultImeReadResult> {
    try {
      const result = await this.adb.executeCommand(
        `shell settings${this.imeUserFlag()} get secure default_input_method`,
      );
      const stderr = result.stderr.trim();
      if (stderr) {
        const error = `Failed to read the current default IME: ${stderr}`;
        logger.warn(`[SendKeys] ${error}`);
        return { success: false, error };
      }
      const imeId = result.stdout.trim();
      return { success: true, imeId: !imeId || imeId === "null" ? null : imeId };
    } catch (error) {
      logger.warn("[SendKeys] Failed to read the current default IME", error);
      return {
        success: false,
        error: `Failed to read the current default IME: ${errorMessage(error)}`,
      };
    }
  }

  private async readCommitImeEnabled(): Promise<
    { success: true; enabled: boolean } | { success: false; error: string }
  > {
    try {
      const result = await this.adb.executeCommand(`shell ime list${this.imeUserFlag()} -s`);
      if (result.stderr.trim()) {
        logger.warn(`[SendKeys] Failed to list enabled IMEs: ${result.stderr.trim()}`);
        return { success: false, error: `Failed to list enabled IMEs: ${result.stderr.trim()}` };
      }
      return {
        success: true,
        enabled: result.stdout.split(/\r?\n/).some((id) => id.trim() === this.commitImeId),
      };
    } catch (error) {
      logger.warn("[SendKeys] Failed to list enabled IMEs", error);
      return { success: false, error: `Failed to list enabled IMEs: ${errorMessage(error)}` };
    }
  }

  private async activateCommitIme(wasEnabled: boolean): Promise<boolean> {
    // Android IME ids are ComponentName.flattenToShortString(): the class is
    // abbreviated to a leading "." because it lives under the package, and that
    // short form is what `settings get secure default_input_method` stores.
    const imeId = this.commitImeId;
    try {
      if (!wasEnabled) {
        const enableResult = await this.adb.executeCommand(
          `shell ime enable${this.imeUserFlag()} ${imeId}`,
        );
        if (enableResult.stderr.trim()) {
          logger.warn(
            `[SendKeys] Failed to enable the text-commit IME: ${enableResult.stderr.trim()}`,
          );
          return false;
        }
      }
      const setResult = await this.adb.executeCommand(
        `shell ime set${this.imeUserFlag()} ${imeId}`,
      );
      if (setResult.stderr.trim()) {
        logger.warn(`[SendKeys] Failed to select the text-commit IME: ${setResult.stderr.trim()}`);
        return false;
      }
      const activeResult = await this.readDefaultIme();
      if (!activeResult.success) {
        return false;
      }
      if (activeResult.imeId !== imeId) {
        logger.warn(
          `[SendKeys] Text-commit IME activation verification failed: expected ${imeId}, got ${activeResult.imeId ?? "none"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      logger.warn("[SendKeys] Failed to activate the text-commit IME", error);
      return false;
    }
  }

  private async restoreIme(
    priorImeId: string | null,
    wasEnabled: boolean,
    subtype: ImeSubtypeSnapshot,
  ): Promise<void> {
    if (priorImeId === this.commitImeId) {
      // The commit IME was already the keyboard, so nothing was switched away from (#10409).
      return;
    }
    const catalog = this.pinnedImeCatalog();
    try {
      // Cleanup must complete even when the ambient request signal has been cancelled.
      await runOutsideRequestContext(async () => {
        await this.restoreComponentAndSubtype(catalog, priorImeId, subtype);
        await this.verifyRestoredIme(catalog, priorImeId, wasEnabled);
      });
    } catch (error) {
      const snapshot: SendKeysImeRecoverySnapshot | undefined =
        priorImeId === null
          ? undefined
          : {
              imeId: priorImeId,
              subtypeId: subtype.id,
              wasEnabled,
              userId: this.imeUserId,
            };
      quarantineAndroidIme(this.device.deviceId, snapshot);
      logger.warn("[SendKeys] Original keyboard restoration failed", error);
      const recovery =
        priorImeId === null
          ? 'run "keyboard listImes" and select an enabled IME, or restart the daemon.'
          : `run "keyboard setIme ${priorImeId}" or restart the daemon.`;
      throw new ImeRestorationError(
        `Could not restore the original keyboard ${priorImeId ?? "(none)"}; ${recovery}`,
        { cause: error },
      );
    }
  }

  private async restoreComponentAndSubtype(
    catalog: AndroidImeCatalog,
    priorImeId: string | null,
    subtype: ImeSubtypeSnapshot,
  ): Promise<void> {
    let componentError: unknown;
    try {
      if (priorImeId !== null) {
        // The caller already holds the per-device lock; select() would deadlock.
        await catalog.selectWithinLock(priorImeId);
      }
    } catch (error) {
      componentError = error;
    }
    try {
      // Restore subtype after component, including when component selection fails.
      await catalog.restoreSubtypeWithinLock(priorImeId ?? AUTO_MOBILE_IME_ID, subtype);
    } catch (error) {
      if (componentError !== undefined) {
        throw new AggregateError(
          [componentError, error],
          "IME component and subtype restoration failed.",
        );
      }
      throw error;
    }
    if (componentError !== undefined) {
      throw componentError;
    }
  }

  private async verifyRestoredIme(
    catalog: AndroidImeCatalog,
    priorImeId: string | null,
    wasEnabled: boolean,
  ): Promise<void> {
    if (priorImeId !== null) {
      const after = await catalog.list();
      if (after.activeImeId !== priorImeId) {
        throw new Error(`Expected ${priorImeId}, got ${after.activeImeId ?? "none"}.`);
      }
    }
    if (!wasEnabled) {
      await this.disableCommitIme();
    }
    const enabled = await this.readCommitImeEnabled();
    if (!enabled.success || enabled.enabled !== wasEnabled) {
      throw new Error("Text-commit IME enabled state did not return to its original value.");
    }
  }

  private get commitImeId(): string {
    return AUTO_MOBILE_IME_ID;
  }

  private async disableCommitIme(): Promise<void> {
    // This removes the companion from the keyboard picker; activateCommitIme re-enables it next time.
    const result = await this.adb.executeCommand(
      `shell ime disable${this.imeUserFlag()} ${this.commitImeId}`,
    );
    if (result.stderr.trim()) {
      throw new Error(`Failed to disable the text-commit IME: ${result.stderr.trim()}`);
    }
  }

  private async executeAndroidEventLast(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const chars = Array.from(text);
    const split = await this.findLastKeyEvent(chars, signal);
    if (!split) {
      const result =
        operation === "replace"
          ? await this.textClient.replace(text)
          : await this.insertText(text, undefined, signal);
      return { ...result, resolvedMode: "a11y" };
    }

    if (this.androidCaretUnsafe) {
      return {
        success: false,
        error:
          "eventLast requires a real tail key event, but a previous insert could not place the caret; text was not sent",
      };
    }
    const focusResult = await this.requireFocusedAndroidInput(
      signal,
      ANDROID_TYPE_FOCUSED_INPUT_ERROR,
      display,
    );
    if (!focusResult.success) {
      return focusResult;
    }

    // Pre-existing text must not satisfy the case read-back for the newly inserted region.
    const beforeText = preExistingFieldText(focusResult.hierarchy, operation);
    const prefix = chars.slice(0, split.index).join("");
    const suffix = chars.slice(split.index + 1).join("");
    const initialResult = await this.insertEventLastPrefix(prefix, operation, signal, display);
    if (!initialResult.success) {
      return initialResult;
    }
    const precedingState = await this.readPrecedingState(suffix.length > 0);
    const eventFailure = await this.executeKeyEventPlanSafely(
      split.plan,
      operation === "replace" || prefix.length > 0,
      signal,
    );
    if (eventFailure) {
      return this.withTextWarnings(eventFailure, [initialResult.warning]);
    }
    let suffixResult: TextActionResult;
    try {
      suffixResult = suffix
        ? await this.insertText(
            suffix,
            {
              expectedSuffix: chars[split.index],
              ...(precedingState ? { precedingState } : {}),
            },
            signal,
          )
        : { success: true };
    } catch (error) {
      logger.warn("[SendKeys] eventLast suffix insertion failed", error);
      return this.withTextWarnings(
        { success: false, partialApplication: true, error: errorMessage(error) },
        [initialResult.warning],
      );
    }
    const verified = await this.verifyKeyEventLetterCase(
      text,
      markPartialAfterMutation(suffixResult),
      "eventLast",
      signal,
      display,
      beforeText,
    );
    return this.withTextWarnings(verified, [initialResult.warning]);
  }

  private async insertEventLastPrefix(
    prefix: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    // The expectation needs the field as it was BEFORE the insert, so it is read up front.
    const expected = await this.expectEventLastCaret(prefix, operation, signal);
    return this.confirmEventLastCaret(
      await this.prepareEventLastPrefix(prefix, operation, signal, display),
      expected,
      signal,
    );
  }

  private async expectEventLastCaret(
    prefix: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
  ): Promise<EventLastCaretExpectation | undefined> {
    if (operation === "replace") {
      return { text: prefix, caret: prefix.length };
    }
    if (!prefix || !this.textClient.readInsertTextState) {
      return undefined;
    }
    try {
      const before = await this.readInsertTextStateWhileLive(signal);
      const expected = before && expectedStateAfterInsert(before, prefix);
      if (!expected) {
        logger.warn(
          `[SendKeys] eventLast cannot prove the caret: pre-insert state is ${describeInsertState(before)}`,
        );
      }
      return expected;
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn(
        `[SendKeys] eventLast pre-insert read unavailable: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /** The client read takes no signal; stop waiting on a cancelled call (the read may finish later). */
  private async readInsertTextStateWhileLive(
    signal?: AbortSignal,
  ): Promise<InsertTextState | undefined> {
    const read = this.textClient.readInsertTextState?.();
    return read && (await awaitWhileRequestIsLive(read, signal));
  }

  /** Turn a `caretPlaced: false` prefix result into a failure unless the caret is proven (#9887). */
  private async confirmEventLastCaret(
    result: TextActionResult,
    expected: EventLastCaretExpectation | undefined,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    if (!result.success || result.caretPlaced !== false) {
      return result;
    }
    // Compose fields report "not placed" even when the caret sits after the prefix.
    if (!expected || !(await this.isCaretProvenAfterPrefix(expected, signal))) {
      return markPartialAfterMutation({
        ...result,
        success: false,
        error:
          "eventLast requires a real tail key event, but the prefix insert could not place the caret; remaining text was not sent",
      });
    }
    this.resetCaretState();
    return this.withoutCaretUnknownWarning(result);
  }

  /** Read the insert state back (bounded) and require exactly the expected text and caret. */
  private async isCaretProvenAfterPrefix(
    expected: EventLastCaretExpectation,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < ANDROID_READ_BACK_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.timer.sleep(IME_COMMIT_READ_BACK_SETTLE_MS);
      }
      this.checkAbort(signal);
      try {
        const state = await this.readInsertTextStateWhileLive(signal);
        if (state && stateMatchesExpectation(state, expected)) {
          return true;
        }
      } catch (error) {
        this.checkAbort(signal, error);
        logger.warn(
          `[SendKeys] eventLast caret read-back unavailable: ${errorMessage(error)}`,
          error,
        );
        return false;
      }
    }
    return false;
  }

  private withoutCaretUnknownWarning(result: TextActionResult): TextActionResult {
    const { warning, ...rest } = result;
    const remaining = warning?.replace(CARET_UNKNOWN_WARNING, "").trim();
    return { ...rest, ...(remaining ? { warning: remaining } : {}) };
  }

  private async findLastKeyEvent(
    chars: string[],
    signal?: AbortSignal,
  ): Promise<{ index: number; plan: KeyEventPlan } | undefined> {
    for (let index = chars.length - 1; index >= 0; index--) {
      const char = chars[index];
      if (!char || /\s/.test(char)) {
        continue;
      }
      const plan = await this.getKeyEventPlan(char, signal);
      if (plan) {
        return { index, plan };
      }
    }
    return undefined;
  }

  private async prepareEventLastPrefix(
    prefix: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    if (operation === "replace") {
      // A bare tail key event follows an empty prefix, so the clear must be visible first (#9940).
      if (prefix) {
        return await this.textClient.replace(prefix);
      }
      const { result, unchangedWarning } = await this.clearForReplace(operation, signal, display);
      return this.withTextWarnings(result, [unchangedWarning]);
    }
    return prefix ? this.insertText(prefix, undefined, signal) : { success: true };
  }

  private async executeAndroidEventAll(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    focusedInputVerified = false,
    display?: string,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const graphemes = segmentGraphemes(text);
    if (this.androidCaretUnsafe || !(await this.hasAndroidKeyEvent(graphemes))) {
      const result =
        operation === "replace"
          ? await this.textClient.replace(text)
          : await this.insertGraphemeRun(graphemes, 0, false, undefined, signal);
      return { ...result, resolvedMode: "a11y" };
    }

    if (!focusedInputVerified) {
      const focusResult = await this.requireFocusedAndroidInput(
        signal,
        ANDROID_TYPE_FOCUSED_INPUT_ERROR,
        display,
      );
      if (!focusResult.success) {
        return focusResult;
      }
    }

    const { result: clearResult, unchangedWarning } = await this.clearForReplace(
      operation,
      signal,
      display,
    );
    if (!clearResult.success) {
      return clearResult;
    }
    const typed = await this.executeAndroidEventAllCharacters(
      graphemes,
      operation === "replace",
      operation === "replace",
      signal,
    );
    if (!typed.success) {
      return typed;
    }
    const confirmed = unchangedWarning
      ? await this.confirmReplaceAfterUnchangedClear(text, unchangedWarning, typed, signal, display)
      : typed;
    return this.verifyKeyEventLetterCase(text, confirmed, "eventAll", signal, display);
  }

  /**
   * The replace's clear left the pre-clear text showing, so the typed text may have landed after
   * it: old text + new text. One read after typing: a field that now equals the requested text
   * was just slow to apply the clear; anything else keeps the unchanged-clear warning, naming the
   * field content. A permanent prefix or mask legitimately gives "prefix + text", which cannot be
   * told from a refused clear by text alone, so this stays a warning rather than a failure.
   */
  private async confirmReplaceAfterUnchangedClear(
    text: string,
    unchangedWarning: string,
    typed: TextActionResult,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    let field: string | undefined;
    try {
      field = this.readFocusedText(await this.readFreshObservation(signal, display));
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn(`[SendKeys] Replace read-back unavailable: ${errorMessage(error)}`, error);
    }
    if (field === text) {
      return typed;
    }
    const observed =
      field === undefined
        ? "The field could not be read after typing."
        : `After typing, the field holds ${JSON.stringify(field)}, not just the requested text: it is either a permanent prefix or mask, or the field refused the clear and now contains both the old and the new text.`;
    return this.withTextWarnings(typed, [`${unchangedWarning} ${observed}`]);
  }

  /**
   * Some keyboards/fields change letter case after key events, e.g. a keyboard's sentence-start
   * shift capitalising the first letter in an empty field (#9888, #10404). Warn only on a
   * case-insensitive match; any other mismatch or an unreadable field is left alone.
   */
  private async verifyKeyEventLetterCase(
    text: string,
    typed: TextActionResult,
    mode: "eventAll" | "eventOnly" | "eventLast",
    signal?: AbortSignal,
    display?: string,
    before = "",
  ): Promise<TextActionResult> {
    if (!typed.success || text.toLowerCase() === text.toUpperCase()) {
      return typed;
    }
    try {
      for (let attempt = 0; attempt < ANDROID_READ_BACK_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await this.timer.sleep(IME_COMMIT_READ_BACK_SETTLE_MS);
        }
        const field = this.readFocusedText(await this.readFreshObservation(signal, display));
        if (field === undefined || keyEventLetterCase(field, text, before) !== "changed") {
          return typed;
        }
        if (attempt === ANDROID_READ_BACK_ATTEMPTS - 1) {
          // The app may intend the other case (all-caps, auto-capitalise). The text was typed,
          // so stay successful: a failed result invites a retry that would duplicate it.
          const warning = `${mode} typed ${JSON.stringify(text)} but the focused field holds ${JSON.stringify(field)}: the keyboard or field changed the letter case (possibly intended). Use mode "ime" or "a11y" for exact case.`;
          logger.warn(`[SendKeys] ${warning}`);
          return this.withTextWarnings(typed, [warning]);
        }
      }
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn(`[SendKeys] ${mode} case read-back unavailable: ${errorMessage(error)}`, error);
    }
    return typed;
  }

  private withTextWarnings(
    result: TextActionResult,
    warnings: Array<string | undefined>,
  ): TextActionResult {
    const combined = [...warnings, result.warning].filter((warning) => warning);
    return { ...result, ...(combined.length ? { warning: combined.join(" ") } : {}) };
  }

  private textWarningFields(result: TextActionResult): Pick<TextActionResult, "warning"> {
    return result.warning ? { warning: result.warning } : {};
  }

  private async executeAndroidEventAllCharacters(
    graphemes: string[],
    previouslyMutated: boolean,
    replacing: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    const progress: AndroidEventAllProgress = {
      mutated: previouslyMutated,
      committedGraphemes: 0,
      pendingKeyText: "",
      warnings: [],
      sinceLastInsertEvents: false,
    };
    for (let index = 0; index < graphemes.length; index++) {
      signal?.throwIfAborted();
      const plan = await this.getEventAllKeyEventPlan(graphemes[index] ?? "");
      if (plan) {
        await this.captureEventAllBaseline(graphemes, index, progress);
        const eventFailure = await this.executeKeyEventPlanSafely(plan, progress.mutated, signal);
        if (eventFailure) {
          return this.withTextWarnings(
            {
              ...eventFailure,
              error: `eventAll could not deliver grapheme ${this.describeGraphemes([graphemes[index] ?? ""])}: ${eventFailure.error ?? "unknown error"}`,
              committedGraphemes: progress.committedGraphemes,
            },
            progress.warnings,
          );
        }
        progress.mutated = true;
        progress.committedGraphemes++;
        progress.pendingKeyText += graphemes[index];
        progress.sinceLastInsertEvents = true;
        continue;
      }
      const runStart = index;
      index = await this.eventAllInsertRunEnd(graphemes, index);
      const insertResult = await this.insertEventAllRun(
        graphemes.slice(runStart, index + 1),
        progress,
        signal,
      );
      if (!insertResult.success) {
        return insertResult;
      }
      // An unknown caret prohibits further key events until an explicit caret reset.
      if (insertResult.caretPlaced === false) {
        const remainder = await this.insertEventAllRemainder(
          graphemes.slice(index + 1),
          progress,
          signal,
        );
        if (!remainder.success) {
          return remainder;
        }
        break;
      }
    }
    return this.finishEventAll(graphemes, replacing, progress);
  }

  private async readPrecedingState(needed: boolean): Promise<InsertTextState | undefined> {
    return needed ? this.textClient.readInsertTextState?.() : undefined;
  }

  private async captureEventAllBaseline(
    graphemes: string[],
    index: number,
    progress: AndroidEventAllProgress,
  ): Promise<void> {
    if (progress.pendingKeyText) {
      return;
    }
    // Each run gets its own pre-dispatch snapshot, including runs after a service insert.
    progress.precedingState = await this.readPrecedingState(
      await this.hasFollowingEventAllInsert(graphemes, index),
    );
  }

  private async hasFollowingEventAllInsert(graphemes: string[], index: number): Promise<boolean> {
    for (const grapheme of graphemes.slice(index + 1)) {
      if (!(await this.getEventAllKeyEventPlan(grapheme))) {
        return true;
      }
    }
    return false;
  }

  private async eventAllInsertRunEnd(graphemes: string[], index: number): Promise<number> {
    while (
      index + 1 < graphemes.length &&
      !(await this.getEventAllKeyEventPlan(graphemes[index + 1] ?? ""))
    ) {
      index++;
    }
    return index;
  }

  private async insertEventAllRun(
    run: string[],
    progress: AndroidEventAllProgress,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    const result = await this.insertGraphemeRun(
      run,
      progress.committedGraphemes,
      progress.mutated,
      progress.pendingKeyText
        ? {
            expectedSuffix: progress.pendingKeyText,
            ...(progress.precedingState ? { precedingState: progress.precedingState } : {}),
          }
        : undefined,
      signal,
    );
    if (result.success) {
      progress.mutated = true;
      progress.committedGraphemes += run.length;
      progress.pendingKeyText = "";
      progress.precedingState = undefined;
      progress.sinceLastInsertEvents = false;
      progress.lastInsert = result;
      if (result.warning) {
        progress.warnings.push(result.warning);
      }
    }
    return result.success ? result : this.withTextWarnings(result, progress.warnings);
  }

  private async insertEventAllRemainder(
    rest: string[],
    progress: AndroidEventAllProgress,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    if (!rest.length) {
      return { success: true };
    }
    signal?.throwIfAborted();
    // insertEventAllRun reset pendingKeyText; the service supplies the remembered caret.
    return this.insertEventAllRun(rest, progress, signal);
  }

  private finishEventAll(
    graphemes: string[],
    replacing: boolean,
    progress: AndroidEventAllProgress,
  ): TextActionResult {
    // Planned length only: insert has an unknown prefix, and later key events are unobserved.
    // Old APKs omit the length. Other typing modes do not use this check.
    if (
      replacing &&
      !progress.sinceLastInsertEvents &&
      progress.lastInsert?.resultingTextLength !== undefined
    ) {
      const expected = graphemes.reduce((length, grapheme) => length + grapheme.length, 0);
      const actual = progress.lastInsert.resultingTextLength;
      if (actual !== expected) {
        progress.warnings.push(
          `eventAll finished with ${actual} UTF-16 units in the field, expected ${expected}; some input may have been lost or overwritten`,
        );
      }
    }
    return {
      success: true,
      ...(progress.warnings.length ? { warning: progress.warnings.join(" ") } : {}),
    };
  }

  private describeGraphemes(graphemes: string[]): string {
    return this.typingPasswordField
      ? `(${graphemes.length} password character(s))`
      : graphemeCodePoints(graphemes);
  }

  private async getEventAllKeyEventPlan(grapheme: string): Promise<KeyEventPlan | null> {
    return grapheme.length === 1 && isPrintableAscii(grapheme)
      ? this.getKeyEventPlan(grapheme)
      : null;
  }

  private async insertGraphemeRun(
    run: string[],
    committedGraphemes: number,
    previouslyMutated: boolean,
    options?: Parameters<SendKeysTextClient["insert"]>[1],
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    const text = run.join("");
    const codePoints = this.describeGraphemes(run);
    try {
      const result = await this.insertText(text, options, signal);
      if (result.success) {
        return result;
      }
      logger.warn(`[SendKeys] Android text insertion failed: ${result.error ?? "unknown error"}`);
      return markPartialAfterPriorMutation(
        {
          ...result,
          error: `eventAll could not insert grapheme(s) ${codePoints}: ${result.error ?? "unknown error"}`,
          committedGraphemes,
        },
        previouslyMutated,
      );
    } catch (error) {
      logger.warn("[SendKeys] Android text insertion failed", error);
      return {
        success: false,
        error: `eventAll could not insert grapheme(s) ${codePoints}: ${errorMessage(error)}`,
        committedGraphemes,
        partialApplication: true,
      };
    }
  }

  private async executeKeyEventPlanSafely(
    plan: KeyEventPlan,
    previouslyMutated: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult | undefined> {
    try {
      await this.executeKeyEventPlan(plan, signal);
      return undefined;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[SendKeys] Android key event dispatch failed", error);
      const failure = { success: false, error: errorMessage(error) };
      return previouslyMutated ? markPartialAfterMutation(failure) : failure;
    }
  }

  /**
   * Clear before a replace and wait until it is visible, so a following insert or the preceding-state
   * baseline read does not plan from the pre-clear text (#9940). `unchangedWarning` is set when the
   * field still shows its pre-clear text: a mask or prefix at its cleared content, or a refused clear.
   */
  private async clearForReplace(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }> {
    if (operation !== "replace") {
      return { result: { success: true } };
    }
    return this.clearAndVerifyAndroid(signal, display);
  }

  private async hasAndroidKeyEvent(graphemes: string[]): Promise<boolean> {
    for (const grapheme of graphemes) {
      if (await this.getEventAllKeyEventPlan(grapheme)) {
        return true;
      }
    }
    return false;
  }

  private async executeAndroidEventOnly(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    const plans: KeyEventPlan[] = [];
    const chars = Array.from(text);
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index] ?? "";
      const plan = await this.getKeyEventPlan(char, signal);
      if (!plan) {
        return {
          success: false,
          error: `eventOnly cannot type the character at index ${index} with Android key events`,
        };
      }
      plans.push(plan);
    }

    const focusResult = await this.requireFocusedAndroidInput(
      signal,
      ANDROID_TYPE_FOCUSED_INPUT_ERROR,
      display,
    );
    if (!focusResult.success) {
      return focusResult;
    }

    if (operation === "replace") {
      const textLength = getFocusedTextLength(focusResult.hierarchy, undefined, true);
      if (textLength === undefined) {
        return {
          success: false,
          error:
            "eventOnly replacement requires a known focused text length; use a11y replacement instead",
        };
      }
      const clearResult = await this.clearEventOnlyForReplace(textLength, signal, display);
      if (!clearResult.success) {
        return clearResult;
      }
    }

    // Pre-existing text must not satisfy the case read-back for the newly inserted region.
    const beforeText = preExistingFieldText(focusResult.hierarchy, operation);
    let mutated = operation === "replace";
    if (this.androidCaretUnsafe) {
      return {
        success: false,
        error: "eventOnly requires a known caret; use eventAll insertion or move the caret first",
      };
    }
    for (const plan of plans) {
      const eventFailure = await this.executeKeyEventPlanSafely(plan, mutated, signal);
      if (eventFailure) {
        return eventFailure;
      }
      mutated = true;
    }
    return this.verifyKeyEventLetterCase(
      text,
      { success: true },
      "eventOnly",
      signal,
      display,
      beforeText,
    );
  }

  private async clearEventOnlyForReplace(
    count: number,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    let deleted = false;
    try {
      const supportsKeyCombination = await this.supportsAndroidKeyCombination(signal);
      await clearTextWithKeyEvents(
        this.adb,
        count,
        signal,
        () => {
          deleted = true;
        },
        supportsKeyCombination,
      );
      const verification = await verifyKeyEventClear(
        () =>
          this.observer.execute({
            signal,
            freshness: "fresh",
            minTimestamp: 0,
            ...(display === undefined ? {} : { display }),
            skipScreenshot: true,
          }),
        signal,
      );
      return deleted ? markPartialAfterMutation(verification) : verification;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[SendKeys] Android replacement clearing failed", error);
      const failure = { success: false, error: errorMessage(error) };
      return deleted ? markPartialAfterMutation(failure) : failure;
    }
  }

  private async requireFocusedAndroidInput(
    signal?: AbortSignal,
    error: string = ANDROID_FOCUSED_INPUT_ERROR,
    display?: string,
  ): Promise<
    | { success: true; hierarchy: NonNullable<ObserveResult["viewHierarchy"]> }
    | { success: false; error: string }
  > {
    const observation = await this.observer.execute({
      signal,
      freshness: "fresh",
      ...(display === undefined ? {} : { display }),
      skipScreenshot: true,
    });
    const hierarchy = observation.viewHierarchy;
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      return {
        success: false,
        error,
      };
    }
    return { success: true, hierarchy };
  }

  private async getKeyEventPlan(char: string, signal?: AbortSignal): Promise<KeyEventPlan | null> {
    let supportsKeyCombination = false;
    if (asciiKeyEventNeedsKeyCombination(char)) {
      supportsKeyCombination = await this.supportsAndroidKeyCombination(signal);
    }
    return buildAsciiKeyEventPlan(char, supportsKeyCombination);
  }

  private async supportsAndroidKeyCombination(signal?: AbortSignal): Promise<boolean> {
    this.androidKeyCombinationSupported ??= readAndroidDeviceApiLevel(this.adb, 1000, this.timer)
      .then((apiLevel) => apiLevel !== null && apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL)
      .catch((error) => {
        // Unexpected probe rejection must allow the next request to retry.
        this.androidKeyCombinationSupported = undefined;
        throw toActionableError(error, "Failed to read Android key-combination capability");
      });
    return awaitWhileRequestIsLive(this.androidKeyCombinationSupported, signal);
  }

  private async executeKeyEventPlan(plan: KeyEventPlan, signal?: AbortSignal): Promise<void> {
    for (const command of plan.commands) {
      signal?.throwIfAborted();
      await this.adb.executeCommand(command, undefined, undefined, undefined, signal);
    }
  }

  private createTextClient(adbFactory: AdbClientFactory): SendKeysTextClient {
    if (this.device.platform === "android") {
      const client = AndroidCtrlProxyClient.getInstance(this.device, adbFactory);
      return {
        readInsertTextState: async () => {
          const result = await client.requestInsertTextState();
          return result.success ? result.state : undefined;
        },
        replace: async (text) => client.requestSetText(text),
        insert: async (text, options) =>
          client.requestInsertText(
            text,
            options?.timeoutMs,
            undefined,
            {
              ...options,
              acceptsCaretNotPlaced: true,
            },
            {
              abortSignal: options?.abortSignal,
              onDispatch: options?.onDispatch,
              deadlineMs: options?.deadlineMs,
            },
          ),
        clear: async () => client.requestClearText(),
        ime: async (action, signal, onDispatch) =>
          client.requestImeAction(action, 5000, undefined, signal, onDispatch),
        supportsImeCommit: async () =>
          (await client.supportsCommand("request_commit_text")) &&
          (await client.supportsCommand("request_cancel_ime_commit")),
        supportsImeKeyEvents: async () => client.supportsCommand("ime_key_events_v1"),
        supportsImeClearField: async () => client.supportsCommand("ime_clear_field_v1"),
        supportsImePasswordCommit: async () => client.supportsCommand("ime_password_commit_v1"),
        supportsKeyboardProfiles: async () =>
          client.supportsCommand("request_set_keyboard_profile"),
        setKeyboardProfile: async (id) => client.setKeyboardProfile(id),
        commitViaIme: async (text, priorImeId, signal, delivery) => {
          const result = await client.commitViaIme(
            text,
            priorImeId ?? undefined,
            undefined,
            undefined,
            signal,
            delivery,
          );
          return {
            success: result.success,
            ...(result.error ? { error: result.error } : {}),
            ...(result.partialApplication ? { partialApplication: true } : {}),
            ...(result.sessionUnsafe ? { sessionUnsafe: true } : {}),
            ...(result.transportFailure ? { imeFailureStage: "transport" as const } : {}),
            ...imeCommitUnitFields(result),
          };
        },
      };
    }

    const client = IOSCtrlProxyClient.getInstance(this.device);
    return {
      replace: async (text) => {
        const clearResult = await client.requestClearText();
        return clearResult.success ? client.requestAppendText(text) : clearResult;
      },
      insert: async (text, options) =>
        client.requestAppendText(
          text,
          options?.timeoutMs ?? resolveTextCtrlProxyTimeoutMs(text),
          undefined,
          undefined,
          {
            abortSignal: options?.abortSignal,
            ...(options?.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
          },
        ),
      clear: async (signal) =>
        client.requestClearText(undefined, 5000, undefined, { abortSignal: signal }),
      ime: async (action, signal, onDispatch) =>
        client.requestImeAction(action, 5000, undefined, signal, onDispatch),
      supportsImeCommit: async () => false,
      supportsImeKeyEvents: async () => false,
      supportsImeClearField: async () => false,
      supportsImePasswordCommit: async () => false,
      supportsKeyboardProfiles: async () => false,
      setKeyboardProfile: async () => ({
        success: false,
        error: "Keyboard profiles are Android-only",
      }),
      commitViaIme: async () => ({ success: false, error: "IME commit is Android-only" }),
    };
  }
}

export class SendKeys {
  private readonly executor: SendKeysCommandExecutor;
  private readonly focuser: SendKeysTargetFocuser;
  private readonly keyboard?: SendKeysKeyboard;
  private readonly observer: SendKeysObserver;
  private readonly timestampProvider: SendKeysTimestampProvider;
  private readonly timer: Timer;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly displayTransitionReader: DisplayTransitionReader;
  /** The selector resolved to a password field during the current execute. */
  private focusedPasswordTarget = false;

  constructor(
    private readonly device: BootedDevice,
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    dependencies: SendKeysDependencies = {},
  ) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.keyboard = dependencies.keyboard;
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.displayTransitionReader = dependencies.displayTransitions ?? displayTransitions;
    this.observer = dependencies.observer ?? new RealObserveScreen(device, adbFactory);
    this.timestampProvider =
      dependencies.timestampProvider ??
      (device.platform === "android"
        ? { now: async () => adbFactory.create(device).getDeviceTimestampMs() }
        : { now: async () => defaultTimer.now() });
    this.executor =
      dependencies.executor ??
      new DefaultSendKeysCommandExecutor(device, adbFactory, this.observer, { timer: this.timer });
    this.focuser =
      dependencies.focuser ??
      ({
        focus: async (selector, signal, display, options) => {
          const tap = new TapOnElement(device, adbFactory.create(device), {
            timer: this.timer,
            lastRenderedObservation: this.lastRenderedObservation,
          });
          const result = await tap.execute(
            { ...selector, ...options, action: "focus", display },
            undefined,
            signal,
            { throwOnKeyboardOcclusion: true },
          );
          return {
            success: result.success,
            error: result.error,
            focusVerified: result.focusVerified,
            [tapFocusFailure]: result[tapFocusFailure],
            ...(result.element && new FieldTypeDetector().isPasswordField(result.element)
              ? { passwordField: true }
              : {}),
          };
        },
      } satisfies SendKeysTargetFocuser);
  }

  async execute(
    commands: SendKeysCommand[],
    selector?: SendKeysSelector,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ): Promise<SendKeysResult> {
    this.focusedPasswordTarget = false;
    const result = await this.executeFocused(
      commands,
      selector,
      progress,
      signal,
      display,
      options,
    );
    return redactPasswordCommandResults(result, commands, this.focusedPasswordTarget);
  }

  private async executeFocused(
    commands: SendKeysCommand[],
    selector?: SendKeysSelector,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ): Promise<SendKeysResult> {
    const focusOptionsError = this.validateFocusOptions(selector, options);
    if (focusOptionsError) {
      return {
        success: false,
        completedCommands: 0,
        failedIndex: 0,
        commands: [],
        error: focusOptionsError,
      };
    }
    const preflight = this.preflightCommands(commands);
    this.executor.resetCaretState?.();
    let displayId: number | undefined;
    let assertCurrent: (() => void) | undefined;
    if (display !== undefined) {
      if (preflight) {
        return {
          success: false,
          completedCommands: 0,
          failedIndex: preflight.failure.index,
          commands: preflight.results,
          error: preflight.failure.error,
        };
      }
      try {
        const target = await this.prepareExplicitDisplay(
          commands,
          selector,
          display,
          signal,
          options,
        );
        displayId = target.displayId;
        selector = target.selector;
        assertCurrent = target.assertCurrent;
      } catch (error) {
        return this.displayRoutingFailure(error, signal);
      }
    }
    const semanticKey =
      commands.length === 1 && commands[0]?.action === "key" && isSemanticKey(commands[0].key)
        ? commands[0].key
        : undefined;
    if (this.device.platform === "ios" && semanticKey) {
      return this.executeBoundedIosIme(commands, selector, progress, signal, semanticKey, {
        ...options,
        display,
        assertCurrent,
      });
    }
    const routing = { ...options, display, displayId, assertCurrent };
    return this.executeWithRequestBudget(commands, { selector, progress, signal, routing });
  }

  private async executeWithRequestBudget(
    commands: SendKeysCommand[],
    options: {
      selector?: SendKeysSelector;
      progress?: ProgressCallback;
      signal?: AbortSignal;
      routing: SendKeysRouting;
    },
  ): Promise<SendKeysResult> {
    const { selector, progress, signal, routing } = options;
    // Capture the live accessor while request context is active; timers may run outside it.
    const getDeadlineMs = getRequestContext()?.getDeadlineMs;
    const deadlineMs = getTextRequestDeadlineMs(getDeadlineMs);
    if (this.device.platform !== "android" || deadlineMs === undefined) {
      return this.executeUnbounded(commands, selector, progress, signal, routing);
    }
    const controller = new AbortController();
    const remainingMs = deadlineMs - this.timer.now() - TEXT_MCP_REQUEST_HEADROOM_MS;
    let handle: NodeJS.Timeout | undefined;
    const expireOrRearm = () => {
      const liveRemainingMs =
        (getTextRequestDeadlineMs(getDeadlineMs) ?? deadlineMs) -
        this.timer.now() -
        TEXT_MCP_REQUEST_HEADROOM_MS;
      if (liveRemainingMs > 0) {
        handle = this.timer.setTimeout(expireOrRearm, liveRemainingMs);
      } else {
        controller.abort(new SendKeysBudgetError());
      }
    };
    expireOrRearm();
    const combined = combineAbortSignals(signal, controller.signal);
    const results: SendKeysCommandResult[] = [];
    let pending = false;
    try {
      return await this.executeUnbounded(commands, selector, progress, combined, {
        ...routing,
        onCommandStart: () => {
          pending = true;
        },
        onCommandResult: (result) => {
          pending = false;
          results.push(result);
        },
      });
    } catch (error) {
      if (!isImeRestorationFailure(error)) {
        signal?.throwIfAborted();
      }
      if (!isSendKeysBudgetExhausted(combined)) {
        // Preserve the same error identity as the no-deadline path.
        throw error;
      }
      logger.warn("[SendKeys] Request budget exhausted", error);
      const result = this.budgetResult(commands.length, results, pending, remainingMs <= 0);
      if (isImeRestorationFailure(error)) {
        result.success = false;
        result.error = `${result.error ?? "Text commit succeeded, but"} ${errorMessage(error)}`;
      }
      return result;
    } finally {
      if (handle !== undefined) {
        this.timer.clearTimeout(handle);
      }
    }
  }

  private budgetResult(
    commandCount: number,
    results: SendKeysCommandResult[],
    indeterminate: boolean,
    refusedAtAdmission: boolean,
  ): SendKeysResult {
    const completedCommands = results.filter((result) => result.success).length;
    const warnings = results.flatMap((result) => (result.warning ? [result.warning] : []));
    if (completedCommands === commandCount) {
      return {
        success: true,
        completedCommands,
        commands: results,
        warning: [
          ...warnings,
          "All commands were delivered; the request budget expired before final observation completed.",
        ].join(" "),
      };
    }
    const firstUnconfirmed = results.length;
    const notSent = commandCount - firstUnconfirmed - (indeterminate ? 1 : 0);
    const error =
      `sendKeys request budget exhausted: ${completedCommands} command(s) delivered; ` +
      `${notSent} command(s) not sent.` +
      (indeterminate
        ? ` Command ${firstUnconfirmed} outcome is indeterminate: it may have been sent but was not acknowledged. Do not retry automatically; observe before retrying.`
        : refusedAtAdmission
          ? " no request budget remained at admission; no commands were sent."
          : " No further commands were dispatched.");
    return {
      success: false,
      completedCommands,
      failedIndex: firstUnconfirmed,
      commands: results,
      error,
      warning: [
        ...warnings,
        "Partial application: already delivered commands are not rolled back.",
      ].join(" "),
      retryable: false,
    };
  }

  private validateFocusOptions(
    selector: SendKeysSelector | undefined,
    options: SendKeysFocusOptions = {},
  ): string | undefined {
    if (selector) {
      return undefined;
    }
    for (const field of ["container", "selectionStrategy", "target"] as const) {
      if (options[field] !== undefined) {
        return `${field} requires a selector naming the field to focus`;
      }
    }
    return undefined;
  }

  private displayRoutingFailure(error: unknown, signal?: AbortSignal): SendKeysResult {
    signal?.throwIfAborted();
    logger.warn(`sendKeys display routing failed: ${errorMessage(error)}`, error);
    return withStaleDisplay(
      {
        success: false,
        completedCommands: 0,
        failedIndex: 0,
        commands: [],
        error: errorMessage(error),
      },
      error,
    );
  }

  private async prepareExplicitDisplay(
    commands: SendKeysCommand[],
    selector: SendKeysSelector | undefined,
    display: string,
    signal?: AbortSignal,
    options: SendKeysFocusOptions = {},
  ): Promise<{ displayId?: number; selector?: SendKeysSelector; assertCurrent: () => void }> {
    const target = await prepareTargetDisplayAction(
      this.device,
      display,
      { execute: (options) => this.observer.execute({ ...options, skipScreenshot: true }) },
      this.adbFactory.create(this.device),
      this.lastRenderedObservation,
      signal,
      this.displayTransitionReader,
    );
    if (
      this.device.platform === "android" &&
      !selector &&
      commands.some((command) => command.action !== "key" || isSemanticKey(command.key))
    ) {
      await this.assertFocusedDisplay(target.observation, signal);
    }
    if (selector && this.device.platform === "android") {
      const focused = await this.focusSelector(selector, signal, display, options);
      if (!focused.success) {
        throw new Error(focused.error ?? "Unable to focus target field");
      }
      return { displayId: target.displayId, assertCurrent: target.assertCurrent };
    }
    return { displayId: target.displayId, selector, assertCurrent: target.assertCurrent };
  }

  private async assertFocusedDisplay(
    observation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (selectablePanels(this.device.displays).length === 1) {
      return;
    }
    // An explicitly captured panel (and its focused node) does not establish global input focus.
    const focusedWindow = observation.viewHierarchy?.windows?.find((window) => window.isFocused);
    const focusedPanel = focusedWindow
      ? await new ObservedAndroidDisplayCache(this.timer).panelForLogicalId(
          this.device,
          this.adbFactory.create(this.device),
          focusedWindow.displayId,
          signal,
          focusedWindow.panelUniqueId,
        )
      : undefined;
    if (focusedPanel?.key === observation.display.key) {
      return;
    }
    throw new ActionableError(
      `sendKeys on display "${observation.display.key}" requires a selector for text, clear, or IME keys because the focused panel is ${focusedPanel ? `"${focusedPanel.key}"` : "unknown"}. Use tapOn to focus a field on display "${observation.display.key}", or clear the pin with setActiveDevice {display: null}.`,
    );
  }

  private async executeBoundedIosIme(
    commands: SendKeysCommand[],
    selector: SendKeysSelector | undefined,
    progress: ProgressCallback | undefined,
    signal: AbortSignal | undefined,
    key: SendKeysSemanticKey,
    target: Pick<SendKeysRouting, "display" | "assertCurrent" | "container" | "selectionStrategy">,
  ): Promise<SendKeysResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    let dispatched = false;
    let actionResult: SendKeysCommandResult | undefined;
    const deadline = Symbol("IME action deadline");
    let interaction!: Promise<SendKeysResult>;
    const startInteraction = () =>
      (interaction = this.executeUnbounded(commands, selector, progress, controller.signal, {
        onDispatch: () => {
          dispatched = true;
        },
        onCommandResult: (result) => {
          actionResult = result;
        },
        ...target,
      }));
    try {
      try {
        return await raceWithDeadline(startInteraction, {
          timer: this.timer,
          timeoutMs: 5000,
          label: "iOS IME interaction",
          timeoutError: () => deadline,
        });
      } catch (error) {
        if (error !== deadline) {
          throw error;
        }
      }
      controller.abort();
      void interaction.catch((error) => {
        // The timed-out interaction can still settle while the connection recovers.
        logger.debug(
          `[SendKeys] iOS IME interaction settled after deadline: ${errorMessage(error)}`,
        );
      });
      if (actionResult) {
        return {
          success: actionResult.success,
          completedCommands: actionResult.success ? 1 : 0,
          ...(!actionResult.success ? { failedIndex: 0, error: actionResult.error } : {}),
          commands: [actionResult],
          ...(actionResult.success
            ? {
                warning:
                  "Post-action observation did not complete within 5000ms; the IME action was already applied.",
              }
            : {}),
        };
      }
      const error = dispatched
        ? `IME action '${key}' outcome is indeterminate: the request was dispatched but no result was received within 5000ms. Do not retry automatically.`
        : `IME action '${key}' timed out before dispatch after 5000ms.`;
      return {
        success: false,
        completedCommands: 0,
        failedIndex: 0,
        commands: [{ index: 0, action: "key", key, success: false, error, retryable: !dispatched }],
        error,
        retryable: !dispatched,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async executeUnbounded(
    commands: SendKeysCommand[],
    selector?: SendKeysSelector,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysResult> {
    signal?.throwIfAborted();
    const preflight = this.preflightCommands(commands);
    const observe = async (minTimestamp?: number) => {
      await progress?.(commands.length, commands.length, "Observing final keyboard input state");
      const capture = this.observer.captureScreenshot?.bind(this.observer);
      const observation = await this.observer.execute({
        ...(routing.display === undefined ? {} : { display: routing.display }),
        signal,
        freshness: "fresh",
        minTimestamp,
        ...(capture ? { skipScreenshot: true, skipAccessibilityAudit: true } : {}),
      });
      if (
        capture &&
        !deferTerminalScreenshot(observation, (chosen, requestSignal) =>
          capture(undefined, requestSignal ?? signal, chosen),
        )
      ) {
        await capture(undefined, signal, observation);
      }
      return observation;
    };
    // Accept hierarchy updates emitted while focus or command delivery is completing.
    const actionStartTimestamp = preflight ? undefined : await this.timestampProvider.now();
    const focusFailure = preflight ? undefined : await this.focusTarget(selector, signal, routing);
    signal?.throwIfAborted();
    // Preserve resolver diagnostics even if a later observation is unavailable
    // or would consume the bounded iOS IME deadline. No command was dispatched.
    if (focusFailure) {
      const observation =
        routing.container !== undefined || routing.selectionStrategy !== undefined
          ? undefined
          : await observe();
      return this.buildResult([], focusFailure, observation);
    }
    const execution =
      preflight ?? (await this.executeCommands(commands, progress, signal, routing));
    const terminal = this.terminalCommandFailure(commands.length, execution, signal);
    if (terminal) {
      return terminal;
    }
    signal?.throwIfAborted();
    const observation = await observe(actionStartTimestamp);
    return this.buildResult(execution.results, execution.failure, observation);
  }

  private terminalCommandFailure(
    commandCount: number,
    execution: SendKeysCommandExecution,
    signal?: AbortSignal,
  ): SendKeysResult | undefined {
    if (execution.failure && isSendKeysBudgetExhausted(signal)) {
      return {
        ...this.buildResult(execution.results, execution.failure),
        warning: `Request budget exhausted: ${commandCount - execution.results.length} command(s) not sent. Already delivered commands are not rolled back.`,
      };
    }
    if (
      execution.restorationFailed ||
      execution.results.some((result) => result.retryable === false)
    ) {
      return this.buildResult(execution.results, execution.failure);
    }
    return undefined;
  }

  private preflightCommands(
    commands: SendKeysCommand[],
  ): { results: SendKeysCommandResult[]; failure: SendKeysFailure } | undefined {
    if (commands.length > SEND_KEYS_MAX_COMMANDS) {
      throw new ActionableError(
        `sendKeys commands must contain at most ${SEND_KEYS_MAX_COMMANDS} entries`,
      );
    }
    for (const [index, command] of commands.entries()) {
      if (command.action === "key" && (command.modifiers?.length ?? 0) > SEND_KEYS_MAX_MODIFIERS) {
        throw new ActionableError(
          `sendKeys commands[${index}].modifiers must contain at most ${SEND_KEYS_MAX_MODIFIERS} entries`,
        );
      }
    }
    for (const [index, command] of commands.entries()) {
      if (command.action !== "type") {
        continue;
      }
      const error = validateImeKeyEventsText(command, this.device.platform);
      if (error) {
        return {
          results: [
            {
              index,
              action: "type",
              success: false,
              textLength: Array.from(command.text).length,
              operation: command.operation ?? "insert",
              requestedMode: command.mode ?? "auto",
              resolvedMode: "imeKeyEvents",
              error,
            },
          ],
          failure: { index, error },
        };
      }
    }
    return undefined;
  }

  private async focusTarget(
    selector?: SendKeysSelector,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysFailure | undefined> {
    if (!selector) {
      return undefined;
    }
    signal?.throwIfAborted();
    const result = await this.focusSelector(selector, signal, routing.display, {
      container: routing.container,
      selectionStrategy: routing.selectionStrategy,
      target: routing.target,
    });
    return result.success
      ? undefined
      : {
          index: 0,
          error: result.error ?? "Failed to focus the target element before sending keys",
        };
  }

  private async focusSelector(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options: SendKeysFocusOptions = {},
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    const result = await this.focusWithKeyboardRecovery(selector, signal, display, options);
    signal?.throwIfAborted();
    this.focusedPasswordTarget ||= result.passwordField === true;
    if (!result.success && result[tapFocusFailure]) {
      return {
        ...result,
        error: `${result.error} The field may be scrolled out of view; use swipeOn with lookFor to bring it into view, then retry.`,
      };
    }
    return result;
  }

  private async focusWithKeyboardRecovery(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    signal?.throwIfAborted();
    try {
      return await this.focuser.focus(selector, signal, display, options);
    } catch (error) {
      signal?.throwIfAborted();
      if (this.device.platform !== "android" || !(error instanceof KeyboardOcclusionError)) {
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

  private async retryFocusAfterKeyboardClose(
    selector: SendKeysSelector,
    occlusion: KeyboardOcclusionError,
    signal?: AbortSignal,
    options?: SendKeysFocusOptions,
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    const keyboard =
      this.keyboard ?? new Keyboard(this.device, this.adbFactory, undefined, this.timer);
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
    await this.observer.execute({
      signal,
      freshness: "fresh",
      minTimestamp: 0,
      skipScreenshot: true,
    });
    signal?.throwIfAborted();
    const retry = await this.focuser.focus(selector, signal, undefined, options);
    signal?.throwIfAborted();
    if (retry.success && retry.focusVerified !== true) {
      return {
        success: false,
        error: "Failed to confirm focus on target field after closing the keyboard",
      };
    }
    return retry;
  }

  private async executeCommands(
    commands: SendKeysCommand[],
    progress?: ProgressCallback,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysCommandExecution> {
    const results: SendKeysCommandResult[] = [];
    const action = () =>
      this.executeCommandLoop(commands, progress, signal, {
        ...routing,
        onCommandResult: (result) => {
          results.push(result);
          routing.onCommandResult?.(result);
        },
      });
    const needsImeSpan = commands.some(
      (command) =>
        command.action === "type" &&
        ["auto", "ime", "imeKeyEvents"].includes(command.mode ?? "auto"),
    );
    try {
      return await (this.device.platform === "android" && needsImeSpan && this.executor.withImeSpan
        ? this.executor.withImeSpan(action)
        : action());
    } catch (error) {
      if (!isImeRestorationFailure(error) || isSendKeysBudgetExhausted(signal)) {
        // Budget failures retain the delivery accounting in executeWithRequestBudget.
        throw error;
      }
      logger.warn("[SendKeys] Command execution and IME restoration failed", error);
      return {
        results,
        failure: { index: results.length, error: errorMessage(error) },
        restorationFailed: true,
      };
    }
  }

  private async executeCommandLoop(
    commands: SendKeysCommand[],
    progress?: ProgressCallback,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysCommandExecution> {
    const results: SendKeysCommandResult[] = [];
    for (let index = 0; index < commands.length; index++) {
      signal?.throwIfAborted();
      await progress?.(index, commands.length, `Executing sendKeys command ${index + 1}`);
      const command = commands[index];
      if (!command) {
        continue;
      }
      const result = await this.executeCommandResult(command, index, signal, routing);
      this.checkBudgetCommandResult(result, signal);
      result.index = index;
      this.addImeFailureGuidance(command, result, results);
      routing.onCommandResult?.(result);
      results.push(result);
      if (!result.success) {
        return {
          results,
          failure: {
            index,
            error: result.error ?? `sendKeys command ${index} failed`,
          },
        };
      }
    }
    return { results };
  }

  private checkBudgetCommandResult(result: SendKeysCommandResult, signal?: AbortSignal): void {
    if (isSendKeysBudgetExhausted(signal) && result.partialApplication && !result.success) {
      signal?.throwIfAborted();
    }
  }

  private async executeCommandResult(
    command: SendKeysCommand,
    index: number,
    signal: AbortSignal | undefined,
    routing: SendKeysRouting,
  ): Promise<SendKeysCommandResult> {
    try {
      routing.assertCurrent?.();
      // Command dispatches below bypass BaseVisualChange's action boundary.
      await beginPostActionCaptureAction();
      signal?.throwIfAborted();
      routing.onCommandStart?.();
      return await this.executeCommand(
        command,
        signal,
        routing.onDispatch,
        routing.displayId,
        routing.display,
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[SendKeys] ${command.action} command ${index} failed`, error);
      return withStaleDisplay(
        {
          index,
          action: command.action,
          success: false,
          error: errorMessage(error),
        },
        error,
      );
    }
  }

  private addImeFailureGuidance(
    command: SendKeysCommand,
    result: SendKeysCommandResult,
    completed: readonly SendKeysCommandResult[],
  ): void {
    if (
      !result.success &&
      command.action === "key" &&
      isSemanticKey(command.key) &&
      completed.some((previous) => previous.action === "type" && previous.success)
    ) {
      result.error = imeActionFailedAfterTextEntered(command.key, result.error || "unknown error");
      logger.warn(`[SendKeys] ${result.error}`);
    }
  }

  private buildResult(
    results: SendKeysCommandResult[],
    failure: SendKeysFailure | undefined,
    observation?: ObserveResult,
  ): SendKeysResult {
    const warnings = results.filter((result) => result.warning).map((result) => result.warning);
    if (failure) {
      const staleDisplay = results[failure.index]?.staleDisplay;
      return {
        success: false,
        completedCommands: results.filter((result) => result.success).length,
        failedIndex: failure.index,
        commands: results,
        observation,
        error: failure.error,
        ...(results[failure.index]?.retryable === false ? { retryable: false } : {}),
        ...(staleDisplay ? { staleDisplay } : {}),
        ...(warnings.length ? { warning: warnings.join(" ") } : {}),
      };
    }

    return {
      success: true,
      completedCommands: results.length,
      commands: results,
      observation,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  }

  private async executeCommand(
    command: SendKeysCommand,
    signal?: AbortSignal,
    onDispatch?: () => void,
    displayId?: number,
    display?: string,
  ): Promise<SendKeysCommandResult> {
    switch (command.action) {
      case "type":
        return this.executor.type(command, signal, display);
      case "key":
        if (displayId !== undefined && !isSemanticKey(command.key)) {
          this.executor.resetCaretState?.();
          const result = await new InputKey(this.device, this.adbFactory).press(
            command.key,
            undefined,
            undefined,
            command.modifiers,
            { displayId, signal, onDispatch },
          );
          return {
            index: -1,
            action: "key",
            key: command.key,
            modifiers: command.modifiers,
            success: result.success,
            ...(result.error ? { error: result.error } : {}),
          };
        }
        return this.executor.key(command, signal, onDispatch, display);
      case "clear":
        return this.executor.clear(signal, display).then((result) => ({
          index: -1,
          action: "clear",
          success: result.success,
          ...(result.retryable === false ? { retryable: false } : {}),
          ...(result.warning === undefined ? {} : { warning: result.warning }),
          ...(result.error ? { error: result.error } : {}),
        }));
    }
  }
}

/** Inline-format markers a rich-text editor may consume while keys are typed. */
const KEY_EVENT_FORMAT_MARKERS = /[*_~`]/g;

/**
 * Whether the field holds the typed text, holds it only in a different letter case, or neither.
 * Rich-text editors may consume formatting markers, so a marker-free view is compared too.
 */
function keyEventLetterCase(
  field: string,
  text: string,
  before = "",
): "exact" | "changed" | "other" {
  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const strip = (value: string): string => value.replace(KEY_EVENT_FORMAT_MARKERS, "");
  const views = [
    { field, text, before },
    { field: strip(field), text: strip(text), before: strip(before) },
  ].filter((view) => view.text.length > 0);
  // A match that was already in the field before typing says nothing about the new region.
  const grew = (fold: (value: string) => string): boolean =>
    views.some(
      (view) =>
        occurrences(fold(view.field), fold(view.text)) >
        occurrences(fold(view.before), fold(view.text)),
    );
  if (grew((value) => value)) {
    return "exact";
  }
  return grew((value) => value.toLowerCase()) ? "changed" : "other";
}

/** The text already in the focused field that a case read-back must not count; none on replace. */
function preExistingFieldText(
  hierarchy: Parameters<typeof getFocusedTextField>[0],
  operation: SendKeysOperation,
): string {
  return operation === "replace" ? "" : (getFocusedTextField(hierarchy)?.value ?? "");
}

function isSemanticKey(key: SendKeysKey): key is SendKeysSemanticKey {
  return (SEND_KEYS_SEMANTIC_KEYS as readonly string[]).includes(key);
}

/** Where the prefix insert leaves the field, from the state read before it; undefined if unprovable. */
function expectedStateAfterInsert(
  before: InsertTextState,
  prefix: string,
): EventLastCaretExpectation | undefined {
  // A hint is placeholder text, not content, and an empty Compose field reports no text and an
  // unset (-1/-1) selection: either way the field is empty with the caret at 0 (#9948). Any
  // selection on empty text is meaningless; the insert lands at 0.
  const text = before.isShowingHintText ? "" : (before.text ?? "");
  const emptyField = text.length === 0;
  const start = emptyField ? 0 : Math.min(before.selectionStart, before.selectionEnd);
  const end = emptyField ? 0 : Math.max(before.selectionStart, before.selectionEnd);
  if (start < 0 || end > text.length) {
    return undefined;
  }
  return { text: text.slice(0, start) + prefix + text.slice(end), caret: start + prefix.length };
}

function describeInsertState(state: InsertTextState | undefined): string {
  return state
    ? `text length ${state.text?.length ?? "none"}, hint ${state.isShowingHintText}, selection ${state.selectionStart}/${state.selectionEnd}`
    : "unreadable";
}

function stateMatchesExpectation(
  state: InsertTextState,
  expected: EventLastCaretExpectation,
): boolean {
  return (
    !state.isShowingHintText &&
    state.text === expected.text &&
    state.selectionStart === expected.caret &&
    state.selectionEnd === expected.caret
  );
}

function markPartialAfterMutation(result: TextActionResult): TextActionResult {
  return result.success || result.partialApplication
    ? result
    : { ...result, partialApplication: true };
}

function markPartialAfterPriorMutation(
  result: TextActionResult,
  previouslyMutated: boolean,
): TextActionResult {
  return previouslyMutated ? markPartialAfterMutation(result) : result;
}
