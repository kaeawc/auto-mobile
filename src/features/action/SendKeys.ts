import {
  DefaultSendKeysCommandExecutor,
  type SendKeysPlatformDependencies,
} from "./sendkeys/DefaultSendKeysCommandExecutor";
import {
  SEND_KEYS_SEMANTIC_KEYS,
  isSemanticKey,
  validateImeKeyEventsText,
} from "./sendkeys/SendKeysSupport";
import { TargetFocus } from "./sendkeys/TargetFocus";
import { TargetState } from "./sendkeys/TargetState";
import { CommandRunner } from "./sendkeys/CommandRunner";
import {
  SendKeysRequestBudget,
  isSendKeysBudgetExhausted,
  type BoundedIosImeOptions,
} from "./sendkeys/SendKeysRequestBudget";
import { FocusKeyboardRecovery } from "./sendkeys/FocusKeyboardRecovery";
import { ActionableError } from "../../models/ActionableError";
import type { BaseActionResult } from "../../models/BaseActionResult";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { HierarchyLayer } from "../../models/HierarchyLayer";
import { withStaleDisplay } from "../observe/StaleDisplayError";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import type { InsertTextState } from "../observe/android/ctrlProxyProtocol";
import type { BootedDevice, ImeAction, ObserveResult } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import { deferTerminalScreenshot } from "../../utils/PostActionCaptureContext";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { prototypeAgentRegistry } from "../prototype/ios/prototypeAgentInjection";
import {
  AndroidPrototypeTextTargetReader,
  IosPrototypeTextTargetReader,
  prototypeTextFieldBindings,
  type PrototypeTextTargetReader,
} from "../prototype/prototypeTextTarget";
import type { HierarchyCaptureRequest } from "../observe/HierarchyCapture";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { type InputKeyModifier, type InputKeyName } from "./InputKey";
import {
  focusedFieldIsPassword,
  redactPasswordImeFailure,
  type ImeFailureDiagnostic,
} from "./imeFailureDiagnostics";
import type { KeyboardProfileId } from "./keyboardProfiles";
import {
  TapOnElement,
  tapFocusFailure,
  tapResolvedLayer,
  type TapOnFocusResult,
} from "./TapOnElement";
import { Keyboard } from "./Keyboard";
import type { RenderedObservationReader } from "./TargetDisplayAction";
import { FieldTypeDetector } from "./FieldTypeDetector";
import { iosSdkBridgeTarget } from "../observe/ios/iosSdkObservationMerge";
import { iosSdkWebValueTarget } from "../observe/ios/iosSdkWebMerge";
import { type KeyboardIdentity } from "./AndroidImeCatalog";

export { DefaultSendKeysCommandExecutor };
export type { SendKeysPlatformDependencies };

export const SEND_KEYS_MAX_COMMANDS = 100;
export const SEND_KEYS_MAX_MODIFIERS = 4;

export {
  IME_COMMIT_READ_BACK_SETTLE_MS,
  CARET_UNKNOWN_WARNING,
  segmentGraphemes,
} from "./sendkeys/AndroidTypingConstants";
import type { ProgressCallback } from "./BaseVisualChange";
import type { ActionCall } from "./ActionCall";

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
export type AndroidSendKeysTypingMode = Exclude<ResolvedSendKeysTypingMode, "xcuiTypeText">;

/**
 * Android delivery for a `clear` command. auto and ime clear through the CtrlProxy IME
 * (`ime_clear_field_v1`), falling back to key-event deletes; the accessibility ACTION_SET_TEXT
 * clear breaks a rich-text editor's live formatting until it resets (#10408), so only an explicit
 * a11y clear uses it (#10479).
 */
export const SEND_KEYS_CLEAR_MODES = ["auto", "ime", "a11y"] as const;
export type SendKeysClearMode = (typeof SEND_KEYS_CLEAR_MODES)[number];

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

export const SEND_KEYS_OPERATIONS = ["insert", "replace"] as const;
export type SendKeysOperation = (typeof SEND_KEYS_OPERATIONS)[number];

export { SEND_KEYS_SEMANTIC_KEYS };
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
  /** Resolve the field in the app or the AutoMobile prototype only (issue #9305). */
  layer?: HierarchyLayer;
}

/** `ActionCall` for sendKeys: also carries the target display and the focus scope. */
export interface SendKeysCall extends ActionCall {
  display?: string;
  focus?: SendKeysFocusOptions;
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
  mode?: SendKeysClearMode;
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
  imeTrace?: string[];
  imeFailure?: ImeFailureDiagnostic;
  committedGraphemes?: number;
  /** Device upper bound; this is not the verified committedGraphemes count. */
  committedUnits?: number;
  error?: string;
  /** iOS runner's typed failure code for a key command (`runnerErrorCodes.ts`). */
  errorCode?: string;
  retryable?: boolean;
  verified?: boolean;
  warning?: string;
  /**
   * `autoMobileIme` on Android IME typing. On iOS, for a field merged from the app's SDK
   * observation bridge (#5159): `sdk` when the bridge entered or cleared the text, `xctest` when
   * XCTest stood in.
   */
  backend?: "autoMobileIme" | import("../../models/ObserveResult").ObservationBackend;
  /** Why XCTest stood in for the bridge: it was unavailable, or it does not support the action. */
  fallbackReason?: import("../../models/ObserveResult").ObservationFallbackReason;
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

export interface SendKeysFailure {
  index: number;
  error: string;
}

export interface SendKeysCommandExecution {
  results: SendKeysCommandResult[];
  failure?: SendKeysFailure;
  restorationFailed?: boolean;
}

export interface SendKeysCommandExecutor {
  /** Confirm enter has reached the field before a following accessibility insertion. */
  withEnterReadBack?(
    action: () => Promise<SendKeysCommandResult>,
    signal?: AbortSignal,
    display?: string,
  ): Promise<SendKeysCommandResult>;
  setTargetLayer?(layer: HierarchyLayer | undefined): void;
  /** The focuser reported the target as a password field; honoured for prototype-layer targets. */
  setTargetPasswordField?(passwordField: boolean): void;
  /** iOS: the focused field's SDK observation-bridge identity, when it is a bridge node (#5159). */
  setIosSdkTextTarget?(
    target: import("./sendkeys/IosSdkTextRouting").IosSdkTextTarget | undefined,
  ): void;
  isPasswordTarget?(): boolean;
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
    mode?: SendKeysClearMode,
  ): Promise<{
    success: boolean;
    error?: string;
    retryable?: boolean;
    warning?: string;
    partialApplication?: boolean;
    iosBackend?: import("./IosSdkBridgeTapRouter").IosSdkTapOutcome;
  }>;
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
      identifiers?: readonly string[];
      /** Layer of the resolved element, when known. */
      layer?: HierarchyLayer;
      /** iOS: the resolved element's SDK observation-bridge identity (#5159). */
      sdkTarget?: import("./sendkeys/IosSdkTextRouting").IosSdkTextTarget;
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
  prototypeTextTarget?: PrototypeTextTargetReader;
  displayTransitions?: DisplayTransitionReader;
  lastRenderedObservation?: RenderedObservationReader;
  executor?: SendKeysCommandExecutor;
  focuser?: SendKeysTargetFocuser;
  keyboard?: SendKeysKeyboard;
  observer?: SendKeysObserver;
  timestampProvider?: SendKeysTimestampProvider;
  timer?: Timer;
}

export interface SendKeysRouting extends SendKeysFocusOptions {
  onCommandStart?: () => void;
  onDispatch?: () => void;
  onCommandResult?: (result: SendKeysCommandResult) => void;
  display?: string;
  displayId?: number;
  assertCurrent?: () => void;
}

export type TextActionResult = {
  /** Internal device read-back evidence; omitted from public command results. */
  insertedText?: string;
  /** Internal device reconciliation verdict; omitted from public command results. */
  editorConsumed?: boolean;
  success: boolean;
  retryable?: boolean;
  warning?: string;
  caretPlaced?: boolean;
  resultingTextLength?: number;
  error?: string;
  partialApplication?: boolean;
  imeTrace?: string[];
  imeFailure?: ImeFailureDiagnostic;
  /** Internal stage supplied by transport/restoration boundaries. */
  imeFailureStage?: ImeFailureDiagnostic["stage"];
  committedGraphemes?: number;
  /** Device upper bound; this is not the verified committedGraphemes count. */
  committedUnits?: number;
  sessionUnsafe?: boolean;
  /** Internal: the iOS SDK bridge outcome, mapped to `backend` / `fallbackReason` (#5159). */
  iosBackend?: import("./IosSdkBridgeTapRouter").IosSdkTapOutcome;
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
  /** Reports the editor delta on commit_text_result when it can be read safely. */
  supportsImeInsertedText(): Promise<boolean>;
  supportsImeTrace?(): Promise<boolean>;
  supportsKeyboardProfiles(): Promise<boolean>;
  setKeyboardProfile(
    id: string,
  ): Promise<{ success: boolean; previousProfileId?: string; error?: string }>;
  commitViaIme(
    text: string,
    priorImeId: string | null,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents" | "clearField",
    trace?: boolean,
  ): Promise<TextActionResult>;
}

export interface SendKeysInputKey {
  press(
    key: InputKeyName,
    timeoutMs?: number,
    frameContext?: string,
    modifiers?: readonly InputKeyModifier[],
  ): Promise<{
    success: boolean;
    error?: string;
    errorCode?: string;
    verified?: boolean;
    warning?: string;
  }>;
}

/** The focused element's SDK bridge identity, so text entry can follow it to the bridge (#5159). */
export function sdkTargetField(
  device: Pick<BootedDevice, "platform">,
  element: Record<string, unknown> | undefined,
): { sdkTarget?: import("./sendkeys/IosSdkTextRouting").IosSdkTextTarget } {
  if (device.platform !== "ios" || !element) {
    return {};
  }
  // A native bridge node, else a DOM input or textarea merged from an opted-in web view (#5162).
  const sdkTarget = iosSdkBridgeTarget(element) ?? iosSdkWebValueTarget(element);
  return sdkTarget ? { sdkTarget } : {};
}

export class SendKeys {
  private readonly prototypeTextTarget: PrototypeTextTargetReader;
  private readonly executor: SendKeysCommandExecutor;
  private readonly focuser: SendKeysTargetFocuser;
  private readonly keyboard?: SendKeysKeyboard;
  private readonly observer: SendKeysObserver;
  private readonly timestampProvider: SendKeysTimestampProvider;
  private readonly timer: Timer;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly displayTransitionReader: DisplayTransitionReader;
  private readonly requestBudget: SendKeysRequestBudget;
  private readonly focusRecovery: FocusKeyboardRecovery;
  private readonly target = new TargetState();
  private readonly targetFocus: TargetFocus;
  private readonly commandRunner: CommandRunner;

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
    this.prototypeTextTarget =
      dependencies.prototypeTextTarget ??
      (device.platform === "android"
        ? new AndroidPrototypeTextTargetReader(this.observer)
        : new IosPrototypeTextTargetReader({
            deviceId: device.deviceId,
            connections: prototypeAgentRegistry,
            bindings: prototypeTextFieldBindings,
          }));
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
            layer: result[tapResolvedLayer],
            [tapFocusFailure]: result[tapFocusFailure],
            identifiers: [
              result.element?.["resource-id"],
              result.element?.["test-tag"],
              result.element?.["view-id"],
            ].filter((id): id is string => typeof id === "string" && id.length > 0),
            ...(result.element && new FieldTypeDetector().isPasswordField(result.element)
              ? { passwordField: true }
              : {}),
            ...sdkTargetField(device, result.element),
          };
        },
      } satisfies SendKeysTargetFocuser);
    this.requestBudget = new SendKeysRequestBudget({
      platform: () => this.device.platform,
      timer: this.timer,
      executeUnbounded: (commands, selector, progress, signal, routing) =>
        this.executeUnbounded(commands, selector, progress, signal, routing),
    });
    this.focusRecovery = new FocusKeyboardRecovery({
      platform: () => this.device.platform,
      focuser: this.focuser,
      keyboard: () =>
        this.keyboard ??
        new Keyboard(this.device, { adbFactory: this.adbFactory, timer: this.timer }),
      observer: { execute: (options) => this.observer.execute(options) },
    });
    this.targetFocus = new TargetFocus({
      device: this.device,
      adb: () => this.adbFactory.create(this.device),
      observer: this.observer,
      timer: this.timer,
      lastRenderedObservation: () => this.lastRenderedObservation,
      displayTransitionReader: this.displayTransitionReader,
      target: this.target,
      isSemanticKey: (key) => isSemanticKey(key),
      focusWithKeyboardRecovery: (selector, signal, display, options) =>
        this.focusWithKeyboardRecovery(selector, signal, display, options),
      setTargetLayer: (layer) => this.executor.setTargetLayer?.(layer),
      setTargetPasswordField: (passwordField) =>
        this.executor.setTargetPasswordField?.(passwordField),
      setIosSdkTextTarget: (target) => this.executor.setIosSdkTextTarget?.(target),
    });
    this.commandRunner = new CommandRunner({
      device: this.device,
      adbFactory: this.adbFactory,
      executor: this.executor,
      prototypeTextTarget: this.prototypeTextTarget,
      timer: this.timer,
      target: this.target,
      isSemanticKey: (key) => isSemanticKey(key),
    });
  }

  async execute(
    commands: SendKeysCommand[],
    selector?: SendKeysSelector,
    call: SendKeysCall = {},
  ): Promise<SendKeysResult> {
    const options = call.focus;
    this.target.focusedPassword = false;
    this.target.prototypeIdentifiers = [selector?.elementId, selector?.testTag].filter(
      (id): id is string => !!id,
    );
    this.target.effectiveLayer = options?.layer;
    this.executor.setTargetLayer?.(this.target.effectiveLayer);
    this.executor.setTargetPasswordField?.(false);
    this.executor.setIosSdkTextTarget?.(undefined);
    const result = await this.executeFocused(commands, selector, call);
    return redactPasswordCommandResults(result, commands, this.target.focusedPassword);
  }

  private async executeFocused(
    commands: SendKeysCommand[],
    selector: SendKeysSelector | undefined,
    call: SendKeysCall,
  ): Promise<SendKeysResult> {
    const { progress, signal, display, focus: options } = call;
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
      return this.executeBoundedIosIme(commands, semanticKey, {
        selector,
        progress,
        signal,
        target: { ...options, display, assertCurrent },
      });
    }
    const routing = { ...options, display, displayId, assertCurrent };
    return this.executeWithRequestBudget(commands, { selector, progress, signal, routing });
  }

  private executeWithRequestBudget(
    commands: SendKeysCommand[],
    options: {
      selector?: SendKeysSelector;
      progress?: ProgressCallback;
      signal?: AbortSignal;
      routing: SendKeysRouting;
    },
  ): Promise<SendKeysResult> {
    return this.requestBudget.executeWithRequestBudget(commands, options);
  }

  private validateFocusOptions(
    selector: SendKeysSelector | undefined,
    options: SendKeysFocusOptions = {},
  ): string | undefined {
    if (selector) {
      return undefined;
    }
    for (const field of ["container", "selectionStrategy", "layer"] as const) {
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

  private prepareExplicitDisplay(
    commands: SendKeysCommand[],
    selector: SendKeysSelector | undefined,
    display: string,
    signal?: AbortSignal,
    options: SendKeysFocusOptions = {},
  ): Promise<{ displayId?: number; selector?: SendKeysSelector; assertCurrent: () => void }> {
    return this.targetFocus.prepareExplicitDisplay(commands, selector, display, signal, options);
  }

  private executeBoundedIosIme(
    commands: SendKeysCommand[],
    key: SendKeysSemanticKey,
    options: BoundedIosImeOptions,
  ): Promise<SendKeysResult> {
    return this.requestBudget.executeBoundedIosIme(commands, key, options);
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

  private focusTarget(
    selector?: SendKeysSelector,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysFailure | undefined> {
    return this.targetFocus.focusTarget(selector, signal, routing);
  }

  private focusSelector(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options: SendKeysFocusOptions = {},
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    return this.targetFocus.focusSelector(selector, signal, display, options);
  }

  private focusWithKeyboardRecovery(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    return this.focusRecovery.focusWithKeyboardRecovery(selector, signal, display, options);
  }

  private executeCommands(
    commands: SendKeysCommand[],
    progress?: ProgressCallback,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysCommandExecution> {
    return this.commandRunner.executeCommands(commands, progress, signal, routing);
  }

  private buildResult(
    results: SendKeysCommandResult[],
    failure: SendKeysFailure | undefined,
    observation?: ObserveResult,
  ): SendKeysResult {
    return this.commandRunner.buildResult(results, failure, observation);
  }
}
