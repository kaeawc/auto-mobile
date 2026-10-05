import { ActionableError, toActionableError } from "../../models/ActionableError";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import { selectablePanels } from "../../models/DisplayPanel";
import type { BaseActionResult } from "../../models/BaseActionResult";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import { withStaleDisplay } from "../../models/StaleDisplayError";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import type { InsertTextState } from "../observe/android/ctrlProxyProtocol";
import type { BootedDevice, ImeAction, ObserveResult } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import type { HierarchyCaptureRequest } from "../observe/HierarchyCapture";
import { AndroidCtrlProxyClient } from "../observe/android";
import {
  imeCommitSegmentCount,
  imeCommitSubsequenceMatches,
  imeCommitSuffixMatches,
  imeCommitUnitFields,
} from "../observe/android/CtrlProxyText";
import { IOSCtrlProxyClient } from "../observe/ios";
import {
  clearTextWithKeyEvents,
  verifyKeyEventClear,
  getFocusedTextField,
  getFocusedTextLength,
  hasFocusedTextInput,
} from "./ClearText";
import { InputKey, type InputKeyModifier, type InputKeyName } from "./InputKey";
import { imeActionFailedAfterTextEntered } from "./imeActionFailedAfterTextEntered";
import type { KeyboardProfileId } from "./keyboardProfiles";
import { TapOnElement, tapFocusFailure, type TapOnFocusResult } from "./TapOnElement";
import { Keyboard } from "./Keyboard";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import { FieldTypeDetector } from "./FieldTypeDetector";
import { DefaultElementParser } from "../utility/ElementParser";
import { toSearchable } from "../utility/SearchableNode";
import { quarantineAndroidIme, withAndroidImeLock } from "./androidImeLock";
import {
  AndroidImeCatalog,
  AUTO_MOBILE_IME_ID,
  type ImeSubtypeSnapshot,
  type KeyboardIdentity,
} from "./AndroidImeCatalog";

export const SEND_KEYS_MAX_COMMANDS = 100;
export const SEND_KEYS_MAX_MODIFIERS = 4;

// Give posted formatters/recomposition a bounded chance to finish after a mismatch.
export const IME_COMMIT_READ_BACK_SETTLE_MS = 150;

class ImeRestorationError extends Error {}
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

function getAutoImeFallback(
  operation: SendKeysOperation,
  requestedMode: SendKeysTypingMode,
  keyboardProfile: KeyboardProfileId | undefined,
  resolvedMode: AndroidSendKeysTypingMode,
): AndroidSendKeysTypingMode | undefined {
  if (requestedMode !== "auto" || keyboardProfile || resolvedMode !== "ime") {
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

export interface SendKeysCommandExecutor {
  resetCaretState?(): void;
  type(
    command: SendKeysTypeCommand,
    signal?: AbortSignal,
    display?: string,
  ): Promise<SendKeysCommandResult>;
  key(
    command: SendKeysKeyCommand,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<SendKeysCommandResult>;
  clear(signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
}

export interface SendKeysTargetFocuser {
  focus(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ): Promise<
    Pick<TapOnFocusResult, "success" | "error" | "focusVerified" | typeof tapFocusFailure>
  >;
}

export interface SendKeysKeyboard {
  execute(action: "close", signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
}

export interface SendKeysObserver {
  execute(options?: {
    display?: string;
    signal?: AbortSignal;
    freshness?: HierarchyCaptureRequest["freshness"];
    minTimestamp?: number;
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
  onDispatch?: () => void;
  onCommandResult?: (result: SendKeysCommandResult) => void;
  display?: string;
  displayId?: number;
  assertCurrent?: () => void;
}

export type TextActionResult = {
  success: boolean;
  warning?: string;
  caretPlaced?: boolean;
  resultingTextLength?: number;
  error?: string;
  partialApplication?: boolean;
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
    },
  ): Promise<TextActionResult>;
  clear(): Promise<TextActionResult>;
  ime(action: ImeAction, signal?: AbortSignal, onDispatch?: () => void): Promise<TextActionResult>;
  supportsImeCommit(): Promise<boolean>;
  supportsImeKeyEvents(): Promise<boolean>;
  supportsKeyboardProfiles(): Promise<boolean>;
  setKeyboardProfile(
    id: string,
  ): Promise<{ success: boolean; previousProfileId?: string; error?: string }>;
  commitViaIme(
    text: string,
    priorImeId: string | null,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents",
  ): Promise<TextActionResult>;
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
  signal?: AbortSignal;
  display?: string;
}

export interface SendKeysPlatformDependencies {
  timer?: Timer;
  textClient?: SendKeysTextClient;
  inputKey?: SendKeysInputKey;
}

export class DefaultSendKeysCommandExecutor implements SendKeysCommandExecutor {
  private readonly adb: AdbExecutor;
  private readonly textClient: SendKeysTextClient;
  private readonly inputKey: SendKeysInputKey;
  private readonly observer: SendKeysObserver;
  private readonly timer: Timer;
  private androidKeyCombinationSupported: Promise<boolean> | undefined;
  private androidCaretUnsafe = false;

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
      resolvedMode = await this.resolveAutoPasswordMode(requestedMode, operation, signal, display);
      baseResult.resolvedMode = this.reportedMode(resolvedMode);
      const autoImeFallback = getAutoImeFallback(
        operation,
        requestedMode,
        command.keyboardProfile,
        resolvedMode,
      );
      const result: TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode } =
        this.device.platform === "ios"
          ? await this.executeIosType(command.text, operation, signal)
          : await this.executeAndroidType(
              command.text,
              operation,
              resolvedMode,
              command.keyboardProfile,
              autoImeFallback,
              { signal, display },
              this.isAutoPasswordInsert(requestedMode, resolvedMode),
            );
      this.recordCaretState(result);
      return {
        ...baseResult,
        success: result.success,
        error: result.error,
        ...this.textWarningFields(result),
        ...(result.partialApplication ? { partialApplication: true } : {}),
        committedGraphemes: result.committedGraphemes,
        ...imeCommitUnitFields(result),
        ...(result.resolvedMode ? { resolvedMode: result.resolvedMode } : {}),
        ...this.imeResultFields(result.resolvedMode ?? baseResult.resolvedMode),
      };
    } catch (error) {
      // A restore failure still needs its recovery instruction after cancellation.
      if (!this.isImeRestorationFailure(error)) {
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

  private isImeRestorationFailure(error: unknown): boolean {
    return (
      error instanceof ImeRestorationError ||
      (error instanceof AggregateError &&
        error.errors.some((entry) => entry instanceof ImeRestorationError))
    );
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
  ): Promise<SendKeysCommandResult> {
    signal?.throwIfAborted();
    // Explicit keys can move the caret, mutate the selection, or change focus (including IME
    // semantic actions). Subsequent typing must use the service's new reported selection.
    this.resetCaretState();
    const modifiers = command.modifiers ?? [];
    if (isSemanticKey(command.key)) {
      if (this.device.platform === "android") {
        const focusResult = await this.requireFocusedAndroidInput(signal);
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

  async clear(signal?: AbortSignal): Promise<TextActionResult> {
    signal?.throwIfAborted();
    this.resetCaretState();
    const clearResult = await this.textClient.clear();
    if (clearResult.success || this.device.platform !== "android") {
      return clearResult;
    }
    logger.warn(`[SendKeys] Android accessibility clear failed: ${clearResult.error}`);
    const focusResult = await this.requireFocusedAndroidInput(signal);
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
    return this.clearEventOnlyForReplace(textLength, signal);
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
  ): Promise<TextActionResult> {
    const result = await this.textClient.insert(text, options);
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

  private isAutoPasswordInsert(
    requestedMode: SendKeysTypingMode,
    mode: AndroidSendKeysTypingMode,
  ): boolean {
    return requestedMode === "auto" && mode === "eventAll";
  }

  private async resolveAutoPasswordMode(
    requestedMode: SendKeysTypingMode,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<AndroidSendKeysTypingMode> {
    if (this.device.platform !== "android" || requestedMode !== "auto") {
      return this.resolveMode(requestedMode);
    }
    return (await this.isFocusedAndroidPasswordField(signal, display))
      ? operation === "insert"
        ? "eventAll"
        : "a11y"
      : "ime";
  }

  private async isFocusedAndroidPasswordField(
    signal?: AbortSignal,
    display?: string,
  ): Promise<boolean> {
    const observation = await this.observer.execute({
      signal,
      freshness: "fresh",
      ...(display === undefined ? {} : { display }),
    });
    const hierarchy = observation.viewHierarchy;
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      return false;
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
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    signal?.throwIfAborted();
    const resolvedMode = "xcuiTypeText" as const;
    if (operation === "replace") {
      const clearResult = await this.textClient.clear();
      if (!clearResult.success) {
        return { ...clearResult, resolvedMode };
      }
      signal?.throwIfAborted();
    }

    // iOS has one text-delivery mechanism: XCUITest typeText. Preserve the
    // requested cross-platform mode in metadata, but report the actual mechanism.
    const result = await this.textClient.insert(text);
    if (!result.success) {
      return {
        ...(operation === "replace" ? markPartialAfterMutation(result) : result),
        resolvedMode,
      };
    }
    return { success: true, resolvedMode };
  }

  private async executeAndroidType(
    text: string,
    operation: SendKeysOperation,
    mode: AndroidSendKeysTypingMode,
    keyboardProfile: KeyboardProfileId | undefined,
    autoImeFallback?: AndroidSendKeysTypingMode,
    routing: ImeCommitRouting = {},
    focusedInputVerified = false,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const { signal } = routing;
    if (operation === "replace") {
      this.resetCaretState();
    }
    switch (mode) {
      case "a11y":
        return operation === "replace" ? this.textClient.replace(text) : this.insertText(text);
      case "eventLast":
        return this.executeAndroidEventLast(text, operation, signal);
      case "eventAll":
        return this.executeAndroidEventAll(text, operation, signal, focusedInputVerified);
      case "eventOnly":
        return this.executeAndroidEventOnly(text, operation, signal);
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
      const fallback = await this.executeAndroidType(
        text,
        operation,
        autoImeFallback,
        keyboardProfile,
        undefined,
        routing,
      );
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
    // Serialize the whole capture→activate→commit→restore section per device so a
    // second call cannot borrow/restore the IME while this one is mid-flight (#7464).
    return withAndroidImeLock(
      this.device.deviceId,
      () => this.runAndroidImeCommit(text, operation, keyboardProfile, routing, mode),
      signal,
    );
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
      return { success: false, error };
    }
    this.checkAbort(signal);
    if (mode === "imeKeyEvents" && !(await this.textClient.supportsImeKeyEvents())) {
      this.checkAbort(signal);
      return {
        success: false,
        error: "IME key events are unavailable: update the control-proxy APK.",
      };
    }
    this.checkAbort(signal);
    if (mode === "imeKeyEvents" && this.androidCaretUnsafe) {
      return {
        success: false,
        error:
          "imeKeyEvents requires a known caret; use eventAll insertion or move the caret first",
      };
    }

    const profileSupport = await this.checkKeyboardProfileSupport(keyboardProfile);
    this.checkAbort(signal);
    if (!profileSupport.success) {
      return { ...profileSupport, resolvedMode: mode };
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
    const wasEnabled = enabledResult.enabled;
    const catalog = new AndroidImeCatalog(this.adb, this.device.deviceId);
    const priorSubtype = await catalog.readSubtype(prior ?? AUTO_MOBILE_IME_ID, signal);

    return this.commitWithActiveIme(
      text,
      operation,
      keyboardProfile,
      prior,
      wasEnabled,
      priorSubtype,
      routing,
      mode,
    );
  }

  private async commitWithActiveIme(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    prior: string | null,
    wasEnabled: boolean,
    priorSubtype: ImeSubtypeSnapshot,
    routing: ImeCommitRouting = {},
    mode: "ime" | "imeKeyEvents" = "ime",
  ): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode; imeActivationFailed?: boolean }
  > {
    const { signal } = routing;
    this.checkAbort(signal);
    const profileResult = await this.setRequestedKeyboardProfile(keyboardProfile);
    if (!profileResult.success) {
      return { ...profileResult, resolvedMode: mode };
    }
    const previousProfileId = profileResult.previousProfileId;
    if (signal?.aborted) {
      await this.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      this.checkAbort(signal);
    }

    if (!(await this.activateCommitIme(wasEnabled))) {
      let restoreFailure: string | undefined;
      try {
        await this.restoreIme(prior, wasEnabled, priorSubtype);
      } catch (error) {
        restoreFailure = errorMessage(error);
      } finally {
        await this.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      }
      return {
        success: false,
        error: `Failed to activate the IME for text commit.${restoreFailure ? ` ${restoreFailure}` : ""}`,
        // A fallback is safe only after the original IME was restored.
        imeActivationFailed: !restoreFailure,
      };
    }

    const { outcome, failure, safeToRestore } = await this.performImeCommit(
      text,
      operation,
      prior,
      routing,
      mode,
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

  private async performImeCommit(
    text: string,
    operation: SendKeysOperation,
    prior: string | null,
    routing: ImeCommitRouting,
    mode: "ime" | "imeKeyEvents",
  ): Promise<{
    outcome?: TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode };
    failure?: unknown;
    safeToRestore: boolean;
  }> {
    const { signal } = routing;
    let safeToRestore = true;
    try {
      this.checkAbort(signal);
      if (operation === "replace") {
        const clearResult = await this.textClient.clear();
        this.checkAbort(signal);
        if (!clearResult.success) {
          return { outcome: { ...clearResult, resolvedMode: mode }, safeToRestore };
        }
      }
      this.checkAbort(signal);
      const result = await this.textClient.commitViaIme(
        text,
        prior,
        signal,
        mode === "imeKeyEvents" ? "keyEvents" : "commit",
      );
      safeToRestore = this.canRestoreAfterImeCommit(result);
      if (result.success && mode === "ime" && text.length > 0) {
        const error = await this.verifyImeCommit(text, routing);
        if (error !== undefined) {
          return {
            outcome: {
              ...this.describeImeCommitFailure({
                success: false,
                partialApplication: true,
                ...imeCommitUnitFields(result),
                error,
              }),
              resolvedMode: mode,
            },
            safeToRestore,
          };
        }
      }
      return {
        outcome: {
          ...this.describeImeCommitFailure(
            operation === "replace" ? markPartialAfterMutation(result) : result,
          ),
          resolvedMode: mode,
        },
        safeToRestore,
      };
    } catch (error) {
      return { failure: error, safeToRestore };
    }
  }

  private async verifyImeCommit(
    text: string,
    routing: ImeCommitRouting,
  ): Promise<string | undefined> {
    const { signal, display } = routing;
    const multiSegment = imeCommitSegmentCount(text) > 1;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        this.checkAbort(signal);
        if (attempt > 0) {
          await this.timer.sleep(IME_COMMIT_READ_BACK_SETTLE_MS);
          this.checkAbort(signal);
        }
        const observation = await this.observer.execute({
          signal,
          freshness: "fresh",
          ...(display === undefined ? {} : { display }),
        });
        this.checkAbort(signal);
        const committedText = this.readFocusedText(observation);
        if (committedText === undefined) {
          return undefined;
        }
        const suffixMatches = imeCommitSuffixMatches(committedText, text);
        // Marker-only text and unreadable fields cannot verify a successful commit.
        // Pre-existing insert content can satisfy the whole-field subsequence check;
        // detecting that requires a pre-commit read. Replace clears the field first.
        if (
          suffixMatches === undefined ||
          (multiSegment ? suffixMatches : imeCommitSubsequenceMatches(committedText, text))
        ) {
          return undefined;
        }
        if (attempt === 2) {
          return `IME partial commit: sent ${JSON.stringify(text)} but the focused field holds ${JSON.stringify(committedText)}`;
        }
      }
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn(`[SendKeys] IME read-back unavailable: ${errorMessage(error)}`, error);
    }
    return undefined;
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
      await this.restoreIme(prior, wasEnabled, priorSubtype);
    } catch (restoreError) {
      const restoreMessage = errorMessage(restoreError);
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, restoreError],
          `${errorMessage(failure)}; ${restoreMessage}`,
        );
      }
      if (outcome && !outcome.success) {
        return { ...outcome, error: `${outcome.error ?? "Text commit failed."} ${restoreMessage}` };
      }
      return {
        success: false,
        error: `Text commit succeeded, but ${restoreMessage}`,
        resolvedMode: mode,
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

  private canRestoreAfterImeCommit(result: TextActionResult): boolean {
    if (result.sessionUnsafe) {
      quarantineAndroidIme(this.device.deviceId);
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
      const result = await this.textClient.setKeyboardProfile(profileId);
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
        "shell settings get secure default_input_method",
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
      const result = await this.adb.executeCommand("shell ime list -s");
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
        const enableResult = await this.adb.executeCommand(`shell ime enable ${imeId}`);
        if (enableResult.stderr.trim()) {
          logger.warn(
            `[SendKeys] Failed to enable the text-commit IME: ${enableResult.stderr.trim()}`,
          );
          return false;
        }
      }
      const setResult = await this.adb.executeCommand(`shell ime set ${imeId}`);
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
    const catalog = new AndroidImeCatalog(this.adb, this.device.deviceId);
    try {
      await this.restoreComponentAndSubtype(catalog, priorImeId, subtype);
      await this.verifyRestoredIme(catalog, priorImeId, wasEnabled);
    } catch (error) {
      quarantineAndroidIme(this.device.deviceId);
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
    const result = await this.adb.executeCommand(`shell ime disable ${this.commitImeId}`);
    if (result.stderr.trim()) {
      throw new Error(`Failed to disable the text-commit IME: ${result.stderr.trim()}`);
    }
  }

  private async executeAndroidEventLast(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const chars = Array.from(text);
    const split = await this.findLastKeyEvent(chars, signal);
    if (!split) {
      const result =
        operation === "replace" ? await this.textClient.replace(text) : await this.insertText(text);
      return { ...result, resolvedMode: "a11y" };
    }

    if (this.androidCaretUnsafe) {
      return {
        success: false,
        error:
          "eventLast requires a real tail key event, but a previous insert could not place the caret; text was not sent",
      };
    }
    const focusResult = await this.requireFocusedAndroidInput(signal);
    if (!focusResult.success) {
      return focusResult;
    }

    const prefix = chars.slice(0, split.index).join("");
    const suffix = chars.slice(split.index + 1).join("");
    const initialResult = await this.prepareEventLastPrefix(prefix, operation);
    if (!initialResult.success) {
      return initialResult;
    }

    if (initialResult.caretPlaced === false) {
      return markPartialAfterMutation({
        ...initialResult,
        success: false,
        error:
          "eventLast requires a real tail key event, but the prefix insert could not place the caret; remaining text was not sent",
      });
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
    try {
      const suffixResult = suffix
        ? await this.insertText(suffix, {
            expectedSuffix: chars[split.index],
            ...(precedingState ? { precedingState } : {}),
          })
        : { success: true };
      return this.withTextWarnings(markPartialAfterMutation(suffixResult), [initialResult.warning]);
    } catch (error) {
      logger.warn("[SendKeys] eventLast suffix insertion failed", error);
      return this.withTextWarnings(
        { success: false, partialApplication: true, error: errorMessage(error) },
        [initialResult.warning],
      );
    }
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
  ): Promise<TextActionResult> {
    if (operation === "replace") {
      return prefix ? await this.textClient.replace(prefix) : await this.textClient.clear();
    }
    return prefix ? this.insertText(prefix) : { success: true };
  }

  private async executeAndroidEventAll(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    focusedInputVerified = false,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const graphemes = segmentGraphemes(text);
    if (this.androidCaretUnsafe || !(await this.hasAndroidKeyEvent(graphemes))) {
      const result =
        operation === "replace"
          ? await this.textClient.replace(text)
          : await this.insertGraphemeRun(graphemes, 0, false);
      return { ...result, resolvedMode: "a11y" };
    }

    if (!focusedInputVerified) {
      const focusResult = await this.requireFocusedAndroidInput(signal);
      if (!focusResult.success) {
        return focusResult;
      }
    }

    const clearResult = await this.clearForReplace(operation);
    if (!clearResult.success) {
      return clearResult;
    }
    return this.executeAndroidEventAllCharacters(
      graphemes,
      operation === "replace",
      operation === "replace",
      signal,
    );
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
              error: `eventAll could not deliver grapheme ${graphemeCodePoints([graphemes[index] ?? ""])}: ${eventFailure.error ?? "unknown error"}`,
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
    return this.insertEventAllRun(rest, progress);
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

  private async getEventAllKeyEventPlan(grapheme: string): Promise<KeyEventPlan | null> {
    return grapheme.length === 1 && isPrintableAscii(grapheme)
      ? this.getKeyEventPlan(grapheme)
      : null;
  }

  private async insertGraphemeRun(
    run: string[],
    committedGraphemes: number,
    previouslyMutated: boolean,
    options?: {
      expectedSuffix?: string;
      acceptsCaretNotPlaced?: boolean;
      precedingState?: InsertTextState;
    },
  ): Promise<TextActionResult> {
    const text = run.join("");
    const codePoints = graphemeCodePoints(run);
    try {
      const result = await this.insertText(text, options);
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

  private clearForReplace(operation: SendKeysOperation): Promise<TextActionResult> {
    return operation === "replace" ? this.textClient.clear() : Promise.resolve({ success: true });
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

    const focusResult = await this.requireFocusedAndroidInput(signal);
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
      const clearResult = await this.clearEventOnlyForReplace(textLength, signal);
      if (!clearResult.success) {
        return clearResult;
      }
    }

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
    return { success: true };
  }

  private async clearEventOnlyForReplace(
    count: number,
    signal?: AbortSignal,
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
        () => this.observer.execute({ signal, freshness: "fresh", minTimestamp: 0 }),
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
  ): Promise<
    | { success: true; hierarchy: NonNullable<ObserveResult["viewHierarchy"]> }
    | { success: false; error: string }
  > {
    const observation = await this.observer.execute({ signal, freshness: "fresh" });
    const hierarchy = observation.viewHierarchy;
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      return {
        success: false,
        error: "Android event delivery requires a focused editable field",
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
          client.requestInsertText(text, undefined, undefined, {
            ...options,
            acceptsCaretNotPlaced: true,
          }),
        clear: async () => client.requestClearText(),
        ime: async (action) => client.requestImeAction(action),
        supportsImeCommit: async () =>
          (await client.supportsCommand("request_commit_text")) &&
          (await client.supportsCommand("request_cancel_ime_commit")),
        supportsImeKeyEvents: async () => client.supportsCommand("ime_key_events_v1"),
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
      insert: async (text) => client.requestAppendText(text),
      clear: async () => client.requestClearText(),
      ime: async (action, signal, onDispatch) =>
        client.requestImeAction(action, 5000, undefined, signal, onDispatch),
      supportsImeCommit: async () => false,
      supportsImeKeyEvents: async () => false,
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
    return this.executeUnbounded(commands, selector, progress, signal, {
      ...options,
      display,
      displayId,
      assertCurrent,
    });
  }

  private validateFocusOptions(
    selector: SendKeysSelector | undefined,
    options: SendKeysFocusOptions = {},
  ): string | undefined {
    if (selector) {
      return undefined;
    }
    for (const field of ["container", "selectionStrategy"] as const) {
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
      this.observer,
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
      return this.observer.execute({
        display: routing.display,
        signal,
        freshness: "fresh",
        minTimestamp,
      });
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
    signal?.throwIfAborted();
    const observation = await observe(actionStartTimestamp);
    return this.buildResult(execution.results, execution.failure, observation);
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
    await this.observer.execute({ signal, freshness: "fresh", minTimestamp: 0 });
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
  ): Promise<{ results: SendKeysCommandResult[]; failure?: SendKeysFailure }> {
    const results: SendKeysCommandResult[] = [];
    for (let index = 0; index < commands.length; index++) {
      signal?.throwIfAborted();
      await progress?.(index, commands.length, `Executing sendKeys command ${index + 1}`);
      const command = commands[index];
      if (!command) {
        continue;
      }
      let result: SendKeysCommandResult;
      try {
        routing.assertCurrent?.();
        result = await this.executeCommand(
          command,
          signal,
          routing.onDispatch,
          routing.displayId,
          routing.display,
        );
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn(`[SendKeys] ${command.action} command ${index} failed`, error);
        result = withStaleDisplay(
          {
            index,
            action: command.action,
            success: false,
            error: errorMessage(error),
          },
          error,
        );
      }
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
        return this.executor.key(command, signal, onDispatch);
      case "clear":
        return this.executor.clear(signal).then((result) => ({
          index: -1,
          action: "clear",
          success: result.success,
          ...(result.error ? { error: result.error } : {}),
        }));
    }
  }
}

function isSemanticKey(key: SendKeysKey): key is SendKeysSemanticKey {
  return (SEND_KEYS_SEMANTIC_KEYS as readonly string[]).includes(key);
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
