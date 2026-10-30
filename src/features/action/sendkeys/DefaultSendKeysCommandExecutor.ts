import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { readBackWithSettle } from "./readBackWithSettle";
import { TypingSession } from "./TypingSession";
import { KeyEventSupport } from "./KeyEventSupport";
import {
  FocusedTextClearVerifier,
  checkAbort as checkAbortCheckpoint,
  isEnterConfirmed,
  type EnterFieldState,
} from "./FocusedTextClearVerifier";
import { EventLastTyper } from "./EventLastTyper";
import { EventAllTyper } from "./EventAllTyper";
import { ImeCommitTyper } from "./ImeCommitTyper";
import { ImeRestore, type SendKeysImeRecoverySnapshot } from "./ImeRestore";
import type { ImeCommitRouting, AndroidTypeOptions } from "./ImeTypes";
import {
  ANDROID_FOCUSED_INPUT_ERROR,
  ANDROID_TYPE_FOCUSED_INPUT_ERROR,
} from "./AndroidTypingConstants";
import { ImeSpanService, isImeRestorationFailure } from "./ImeSpan";
import type { AndroidModeTyper } from "./AndroidModeTyper";
import { A11yTyper } from "./A11yTyper";
import { EventOnlyTyper } from "./EventOnlyTyper";
import { PasswordRouting } from "./PasswordRouting";
import { createSendKeysTextClient } from "./CtrlProxyTextClient";
import {
  getAutoImeFallback,
  graphemeCodePoints,
  hasFocusedPasswordField,
  inputKeyOutcomeFields,
  markPartialAfterMutation,
  markPartialAfterPriorMutation,
  preExistingFieldText,
  redactPasswordTypeResult,
} from "./ExecutorHelpers";
import { isSemanticKey, validateImeKeyEventsText } from "./SendKeysSupport";
import { isSendKeysBudgetExhausted } from "./SendKeysRequestBudget";
import { IosTyper } from "./IosTyper";
import { IosSdkTextRouting, iosBackendFields, type IosSdkTextTarget } from "./IosSdkTextRouting";
import { deviceIosSdkWebTextRouter, type IosSdkWebTextRouter } from "../IosSdkWebTextRouter";
import {
  deviceIosSdkBridgeTextRouter,
  type IosSdkBridgeTextRouter,
} from "../IosSdkBridgeTextRouter";
import { AsyncLocalStorage } from "node:async_hooks";
import { clearIosFieldWithVerification } from "../iosClearVerification";
import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import type { InsertTextState } from "../../observe/android/ctrlProxyProtocol";
import type { BootedDevice, ObserveResult } from "../../../models";
import { requireAndroidOrIosPlatform } from "../../../models/Platform";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { scopeObserveResultToLayer } from "../../observe/hierarchyLayer";
import { imeCommitUnitFields } from "../../observe/android/CtrlProxyText";
import { getFocusedTextLength } from "../ClearText";
import { InputKey } from "../InputKey";
import { imeFailureFields } from "../imeFailureDiagnostics";
import type { KeyboardProfileId } from "../keyboardProfiles";
import { AUTO_MOBILE_IME_ID, type ImeSubtypeSnapshot } from "../AndroidImeCatalog";
import type { KeyEventPlan } from "../../../utils/android-cmdline-tools/asciiKeyEvents";
import type {
  AndroidSendKeysTypingMode,
  ResolvedSendKeysTypingMode,
  SendKeysClearMode,
  SendKeysCommandExecution,
  SendKeysCommandExecutor,
  SendKeysCommandResult,
  SendKeysInputKey,
  SendKeysKeyCommand,
  SendKeysObserver,
  SendKeysOperation,
  SendKeysTextClient,
  SendKeysTypeCommand,
  SendKeysTypingMode,
  TextActionResult,
} from "../SendKeys";

export interface SendKeysPlatformDependencies {
  timer?: Timer;
  textClient?: SendKeysTextClient;
  inputKey?: SendKeysInputKey;
  /** Routes iOS text entry and clear on an SDK bridge field (#5159). */
  iosSdkTextRouter?: IosSdkBridgeTextRouter;
  iosSdkWebTextRouter?: IosSdkWebTextRouter;
  imeSpanService?: Pick<
    ImeSpanService,
    "imeSpan" | "withImeSpan" | "acquireImeSpan" | "restoreImeSpan"
  >;
}

export class DefaultSendKeysCommandExecutor implements SendKeysCommandExecutor {
  private readonly adb: AdbExecutor;
  private readonly textClient: SendKeysTextClient;
  private readonly inputKey: SendKeysInputKey;
  private readonly observer: SendKeysObserver;
  private readonly timer: Timer;
  private readonly clearVerifier: FocusedTextClearVerifier;
  private readonly passwordRouting: PasswordRouting;
  private readonly iosTyper: IosTyper;
  private readonly iosSdkText: IosSdkTextRouting;
  // These values intentionally survive commands and concurrent calls on this executor.
  private readonly session = new TypingSession();
  private readonly keyEventSupport: KeyEventSupport;
  private targetLayer: HierarchyLayer | undefined;
  private targetPasswordField = false;

  setTargetLayer(layer: HierarchyLayer | undefined): void {
    this.targetLayer = layer;
  }

  setTargetPasswordField(passwordField: boolean): void {
    this.targetPasswordField = passwordField;
  }

  setIosSdkTextTarget(target: IosSdkTextTarget | undefined): void {
    this.iosSdkText.setTarget(target);
  }

  private isPasswordRouting(routedPassword: boolean | undefined): boolean {
    return routedPassword === true || this.knownPrototypePasswordTarget();
  }

  /** A prototype password field may not be flagged focused, so the focuser's verdict is trusted. */
  private knownPrototypePasswordTarget(): boolean {
    return this.targetLayer === "prototype" && this.targetPasswordField;
  }

  isPasswordTarget(): boolean {
    return this.session.typingPasswordField;
  }
  private readonly imeTraceContext = new AsyncLocalStorage<{ lines?: string[] }>();
  private readonly imeSpanService: NonNullable<SendKeysPlatformDependencies["imeSpanService"]>;
  private readonly eventOnlyTyper: EventOnlyTyper;
  private readonly a11yTyper: AndroidModeTyper;
  private readonly eventLastTyper: AndroidModeTyper;
  private readonly eventAllTyper: AndroidModeTyper;
  private readonly imeCommitTyper: ImeCommitTyper;
  private readonly imeRestore: ImeRestore;

  // IME-mode typing captures the prior IME and profile, then restores both. The shared
  // per-device lock also protects persistent keyboard selection from a concurrent restore.

  constructor(
    private readonly device: BootedDevice,
    adbFactory: AdbClientFactory,
    observer: SendKeysObserver,
    dependencies: SendKeysPlatformDependencies = {},
  ) {
    this.adb = adbFactory.create(device);
    // All executor-owned observations, including iOS pre/post reads, use this choke point.
    this.observer = {
      execute: async (options) => {
        const observation = await observer.execute(options);
        this.iosSdkText.observed(observation);
        if (this.targetLayer !== "prototype") {
          return observation;
        }
        return observation.viewHierarchy
          ? scopeObserveResultToLayer(
              observation,
              "prototype",
              requireAndroidOrIosPlatform(device.platform, "sendKeys"),
            )
          : { ...observation, focusedElement: undefined, accessibilityFocusedElement: undefined };
      },
      captureScreenshot: observer.captureScreenshot?.bind(observer),
    };
    this.timer = dependencies.timer ?? defaultTimer;
    this.iosSdkText = new IosSdkTextRouting({
      router: dependencies.iosSdkTextRouter ?? deviceIosSdkBridgeTextRouter(device),
      webRouter: dependencies.iosSdkWebTextRouter ?? deviceIosSdkWebTextRouter(device),
      observe: (signal) => this.observer.execute({ hierarchyOnly: true, signal }),
    });
    this.clearVerifier = this.createClearVerifier();
    this.passwordRouting = this.createPasswordRouting();
    this.iosTyper = this.createIosTyper();
    this.inputKey = dependencies.inputKey ?? new InputKey(device, adbFactory);
    this.textClient = dependencies.textClient ?? this.createTextClient(adbFactory);
    this.keyEventSupport = this.createKeyEventSupport();
    this.imeSpanService =
      dependencies.imeSpanService ??
      new ImeSpanService({
        deviceId: device.deviceId,
        verifySafeImeRecovery: (snapshot, signal) => this.verifySafeImeRecovery(snapshot, signal),
        restoreIme: (prior, wasEnabled, subtype) => this.restoreIme(prior, wasEnabled, subtype),
        clearPinnedUser: () => {
          this.session.imeUserId = undefined;
        },
      });
    this.imeRestore = new ImeRestore({
      adb: this.adb,
      device: this.device,
      textClient: this.textClient,
      session: this.session,
      checkAbort: (signal, error) => this.checkAbort(signal, error),
    });
    this.a11yTyper = new A11yTyper({
      replace: (text) => this.textClient.replace(text),
      insertText: (text, signal) => this.insertText(text, undefined, signal),
    });
    this.eventOnlyTyper = new EventOnlyTyper({
      session: this.session,
      adb: this.adb,
      observer: { execute: (options) => this.observer.execute(options) },
      getKeyEventPlan: (char, signal) => this.getKeyEventPlan(char, signal),
      requireFocusedAndroidInput: (signal, display) =>
        this.requireFocusedAndroidInput(signal, ANDROID_TYPE_FOCUSED_INPUT_ERROR, display),
      executeKeyEventPlanSafely: (plan, mutated, signal) =>
        this.executeKeyEventPlanSafely(plan, mutated, signal),
      verifyKeyEventLetterCase: (text, typed, signal, display, before) =>
        this.verifyKeyEventLetterCase(text, typed, "eventOnly", signal, display, before),
      supportsAndroidKeyCombination: (signal) => this.supportsAndroidKeyCombination(signal),
      preExistingFieldText: (hierarchy, operation) => preExistingFieldText(hierarchy, operation),
      markPartialAfterMutation: (result) => markPartialAfterMutation(result),
    });

    this.eventLastTyper = new EventLastTyper({
      session: this.session,
      textClient: this.textClient,
      preExistingFieldText: (hierarchy, operation) => preExistingFieldText(hierarchy, operation),
      markPartialAfterMutation: (result) => markPartialAfterMutation(result),
      insertText: (text, options, signal) => this.insertText(text, options, signal),
      requireFocusedAndroidInput: (signal, error, display) =>
        this.requireFocusedAndroidInput(signal, error, display),
      readPrecedingState: (needed) => this.readPrecedingState(needed),
      executeKeyEventPlanSafely: (plan, mutated, signal) =>
        this.executeKeyEventPlanSafely(plan, mutated, signal),
      withTextWarnings: (result, warnings) => this.withTextWarnings(result, warnings),
      verifyKeyEventLetterCase: (text, typed, mode, signal, display, before) =>
        this.verifyKeyEventLetterCase(text, typed, mode, signal, display, before),
      checkAbort: (signal, error) => this.checkAbort(signal, error),
      getKeyEventPlan: (char, signal) => this.getKeyEventPlan(char, signal),
      clearForReplace: (operation, signal, display) =>
        this.clearForReplace(operation, signal, display),
      timer: this.timer,
      resetCaretState: () => this.resetCaretState(),
    });
    this.eventAllTyper = this.createEventAllTyper();
    this.imeCommitTyper = new ImeCommitTyper(
      {
        executeAndroidImeCommit: (...args) => this.executeAndroidImeCommit(...args),
        clearImeFieldWithKeyEvents: (signal, display) =>
          this.clearImeFieldWithKeyEvents(signal, display),
        textClient: this.textClient,
        markPartialAfterMutation: (result) => markPartialAfterMutation(result),
        device: this.device,
        observer: { execute: (options) => this.observer.execute(options) },
        timer: this.timer,
        imeTraceContext: { getStore: () => this.imeTraceContext.getStore() },
        eventOnlyTyper: {
          clearEventOnlyForReplace: (count, signal, display) =>
            this.eventOnlyTyper.clearEventOnlyForReplace(count, signal, display),
        },
        session: this.session,
        getTargetLayer: () => this.targetLayer,
        isSendKeysBudgetExhausted: (signal) => isSendKeysBudgetExhausted(signal),
        executeAndroidType: (options) => this.executeAndroidType(options),
        verifySafeImeRecovery: (snapshot, signal) => this.verifySafeImeRecovery(snapshot, signal),
        checkAbort: (signal, error) => this.checkAbort(signal, error),
        restoreIme: (prior, enabled, subtype) => this.restoreIme(prior, enabled, subtype),
        clearAndVerifyAndroid: (signal, display, clear, passwordField) =>
          this.clearAndVerifyAndroid(signal, display, clear, passwordField),
        withTextWarnings: (result, warnings) => this.withTextWarnings(result, warnings),
        requireFocusedAndroidInput: (signal, error, display) =>
          this.requireFocusedAndroidInput(signal, error, display),
        readFocusedText: (observation) => this.readFocusedText(observation),
        readFocusedTextSnapshot: (observation) => this.readFocusedTextSnapshot(observation),
      },
      this.imeSpanService,
      {
        pinImeUser: (signal) => this.pinImeUser(signal),
        readDefaultIme: () => this.readDefaultIme(),
        readCommitImeEnabled: () => this.readCommitImeEnabled(),
        pinnedImeCatalog: () => this.pinnedImeCatalog(),
        checkKeyboardProfileSupport: (profile) => this.checkKeyboardProfileSupport(profile),
        setRequestedKeyboardProfile: (profile) => this.setRequestedKeyboardProfile(profile),
        restoreKeyboardProfileIfNeeded: (requested, previous) =>
          this.restoreKeyboardProfileIfNeeded(requested, previous),
        activateCommitIme: (wasEnabled) => this.activateCommitIme(wasEnabled),
      },
    );
  }

  private createClearVerifier(): FocusedTextClearVerifier {
    return new FocusedTextClearVerifier({
      observer: { execute: (options) => this.observer.execute(options) },
      timer: this.timer,
      clearText: () => this.textClient.clear(),
    });
  }

  private createPasswordRouting(): PasswordRouting {
    return new PasswordRouting({
      platform: () => this.device.platform,
      observer: { execute: (options) => this.observer.execute(options) },
      targetLayer: () => this.targetLayer,
      resolveMode: (requestedMode) => this.resolveMode(requestedMode),
      supportsImePasswordCommit: () => this.textClient.supportsImePasswordCommit(),
      getEventAllKeyEventPlan: (grapheme) => this.getEventAllKeyEventPlan(grapheme),
      hasFocusedPasswordField: (hierarchy) => hasFocusedPasswordField(hierarchy),
    });
  }

  private createIosTyper(): IosTyper {
    return new IosTyper({
      session: this.session,
      observer: this.observer,
      timer: this.timer,
      targetLayer: () => this.targetLayer,
      clear: (signal, display) => this.clear(signal, display),
      insert: (text, options) =>
        this.iosSdkText.insert(
          text,
          { timeoutMs: options?.timeoutMs, signal: options?.abortSignal },
          () => this.textClient.insert(text, options),
        ),
      withTextWarnings: (result, warnings) => this.withTextWarnings(result, warnings),
      markPartialAfterMutation: (result) => markPartialAfterMutation(result),
    });
  }

  private createTextClient(adbFactory: AdbClientFactory): SendKeysTextClient {
    return createSendKeysTextClient(this.device, adbFactory);
  }

  private createEventAllTyper(): EventAllTyper {
    return new EventAllTyper({
      session: this.session,
      timer: this.timer,
      textClient: this.textClient,
      hasFocusedPasswordField: (hierarchy) => hasFocusedPasswordField(hierarchy),
      graphemeCodePoints: (graphemes) => graphemeCodePoints(graphemes),
      markPartialAfterPriorMutation: (result, mutated) =>
        markPartialAfterPriorMutation(result, mutated),
      insertText: (text, options, signal) => this.insertText(text, options, signal),
      requireFocusedAndroidInput: (signal, error, display) =>
        this.requireFocusedAndroidInput(signal, error, display),
      readPrecedingState: (needed) => this.readPrecedingState(needed),
      executeKeyEventPlanSafely: (plan, mutated, signal) =>
        this.executeKeyEventPlanSafely(plan, mutated, signal),
      withTextWarnings: (result, warnings) => this.withTextWarnings(result, warnings),
      verifyKeyEventLetterCase: (text, typed, mode, signal, display, before) =>
        this.verifyKeyEventLetterCase(text, typed, mode, signal, display, before),
      checkAbort: (signal, error) => this.checkAbort(signal, error),
      getEventAllKeyEventPlan: (grapheme) => this.getEventAllKeyEventPlan(grapheme),
      getAndroidApiLevel: (signal) => this.getAndroidApiLevel(signal),
      clearForReplace: (operation, signal, display) =>
        this.clearForReplace(operation, signal, display),
      readFocusedText: (observation) => this.readFocusedText(observation),
      readFreshObservation: (signal, display) => this.readFreshObservation(signal, display),
    });
  }

  private createKeyEventSupport(): KeyEventSupport {
    return new KeyEventSupport({
      adb: this.adb,
      timer: this.timer,
      session: this.session,
      observer: { execute: (options) => this.observer.execute(options) },
      getTargetLayer: () => this.targetLayer,
      getKeyEventPlan: (char, signal) => this.getKeyEventPlan(char, signal),
      supportsAndroidKeyCombination: (signal) => this.supportsAndroidKeyCombination(signal),
      getAndroidApiLevel: (signal) => this.getAndroidApiLevel(signal),
      executeKeyEventPlan: (plan, signal) => this.executeKeyEventPlan(plan, signal),
      keyEventFailureMessage: (error) => this.keyEventFailureMessage(error),
      readFocusedText: (observation) => this.readFocusedText(observation),
      readFreshObservation: (signal, display) => this.readFreshObservation(signal, display),
      withTextWarnings: (result, warnings) => this.withTextWarnings(result, warnings),
      checkAbort: (signal, error) => this.checkAbort(signal, error),
      clearAndVerifyAndroid: (signal, display) => this.clearAndVerifyAndroid(signal, display),
      markPartialAfterMutation: (result) => markPartialAfterMutation(result),
    });
  }

  withImeSpan(action: () => Promise<SendKeysCommandExecution>): Promise<SendKeysCommandExecution> {
    return this.imeSpanService.withImeSpan(action);
  }

  async type(
    command: SendKeysTypeCommand,
    signal?: AbortSignal,
    display?: string,
  ): Promise<SendKeysCommandResult> {
    return this.imeTraceContext.run({}, () => this.typeWithTraceContext(command, signal, display));
  }

  private async typeWithTraceContext(
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
      this.session.typingPasswordField = this.knownPrototypePasswordTarget();
      const routing = await this.resolveAutoPasswordMode(requestedMode, operation, signal, display);
      resolvedMode = routing.mode;
      baseResult.resolvedMode = this.reportedMode(resolvedMode);
      this.session.typingPasswordField = this.isPasswordRouting(routing.passwordField);
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
          ? await this.iosSdkText.tracked(() =>
              this.executeIosType(command.text, operation, signal, display),
            )
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
        ...this.imeTraceFields(),
        ...(result.resolvedMode ? { resolvedMode: result.resolvedMode } : {}),
        ...iosBackendFields(result.iosBackend),
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
        ...this.imeTraceFields(),
      };
    }
  }

  private imeTraceFields(): Pick<TextActionResult, "imeTrace"> {
    const lines = this.imeTraceContext.getStore()?.lines;
    return lines !== undefined ? { imeTrace: lines } : {};
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

  async withEnterReadBack(
    action: () => Promise<SendKeysCommandResult>,
    signal?: AbortSignal,
    display?: string,
  ): Promise<SendKeysCommandResult> {
    const read = async () =>
      this.clearVerifier.readEnterFieldState(
        await this.clearVerifier.readFreshObservation(signal, display),
      );
    let before: EnterFieldState | undefined;
    try {
      // Take the baseline before dispatch, never from the prior command's cached tree.
      before = await read();
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn("[SendKeys] Enter baseline read failed; dispatching without a read-back", error);
    }
    const result = await action();
    if (!result.success) {
      return result;
    }
    if (before?.kind !== "field" || before.snapshot === undefined) {
      // No readable focused field before the key (password field, unreadable node): the
      // newline cannot be confirmed either way, so keep the pre-guard behaviour.
      logger.warn("[SendKeys] Enter read-back skipped: focused field text was unreadable");
      return result;
    }
    const baseline = { text: before.snapshot.text, identity: before.identity };
    try {
      // The bug is a stale snapshot: the field still shows its pre-enter text after the key.
      // Unavailable observations never confirm; they are polled again and, if they stay
      // unavailable, reported as an unconfirmed newline (partial application).
      const { accepted: confirmed, last } = await readBackWithSettle(
        read,
        (state) => isEnterConfirmed(baseline, state),
        {
          timer: this.timer,
          beforeRead: () => this.checkAbort(signal),
          finish: (state, accepted) => ({ accepted, last: state }),
        },
      );
      if (confirmed) {
        return result;
      }
      throw new ActionableError(
        "Enter was dispatched but its newline could not be confirmed before the next a11y insert" +
          (last?.kind === "unavailable" ? " (fresh observations were unavailable). " : ". ") +
          "Observe the field before continuing; do not retry the sequence blindly. " +
          "For a single-line submit action, end the sequence at enter and re-observe the target.",
      );
    } catch (error) {
      this.checkAbort(signal, error);
      logger.warn("[SendKeys] Enter read-back failed after dispatch", error);
      return {
        ...result,
        success: false,
        partialApplication: true,
        retryable: false,
        error: toActionableError(
          error,
          "Enter read-back is unavailable after dispatch; observe the field and do not retry the sequence blindly",
        ).message,
      };
    }
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
      const key = command.key;
      const result =
        this.device.platform === "ios"
          ? await this.iosSdkText.tracked(() =>
              this.iosSdkText.ime(
                key,
                signal,
                () => this.textClient.ime(key, signal, onDispatch),
                onDispatch,
              ),
            )
          : await this.textClient.ime(key, signal, onDispatch);
      this.iosSdkText.focusMayHaveMoved();
      return {
        index: -1,
        action: "key",
        key: command.key,
        modifiers,
        ...("iosBackend" in result ? iosBackendFields(result.iosBackend) : {}),
        success: result.success,
        ...(result.retryable === false ? { retryable: false } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    }

    const result = await this.inputKey.press(command.key, undefined, undefined, modifiers);
    if (command.key === "tab") {
      this.iosSdkText.focusMayHaveMoved();
    }
    return {
      index: -1,
      action: "key",
      key: command.key,
      modifiers,
      success: result.success,
      ...inputKeyOutcomeFields(result),
    };
  }

  async clear(
    signal?: AbortSignal,
    display?: string,
    mode: SendKeysClearMode = "auto",
  ): Promise<TextActionResult> {
    signal?.throwIfAborted();
    this.resetCaretState();
    if (this.device.platform !== "android") {
      return this.device.platform === "ios"
        ? this.iosSdkText.tracked(() =>
            clearIosFieldWithVerification({
              clear: () => this.iosSdkText.clear(signal, () => this.textClient.clear(signal)),
              observer: this.observer,
              timer: this.timer,
              signal,
              display,
            }),
          )
        : this.textClient.clear();
    }
    if (mode === "a11y") {
      return this.clearAndroidWithAccessibility(signal, display);
    }
    return this.clearAndroidWithIme(signal, display);
  }

  /**
   * auto/ime clear (#10479): the IME clearField when CtrlProxy advertises `ime_clear_field_v1`,
   * activated and restored like IME typing (inside the call's IME span when there is one);
   * otherwise, or when the IME could not be activated (the prior keyboard already restored),
   * key-event deletes, which need no keyboard switch. Never the accessibility clear.
   */
  private async clearAndroidWithIme(
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    const supportsClearField = await this.textClient.supportsImeClearField();
    this.checkAbort(signal);
    if (!supportsClearField) {
      return this.clearImeFieldWithKeyEvents(signal, display);
    }
    const result = await this.executeAndroidImeCommit("", "insert", undefined, {
      signal,
      display,
      delivery: "clearField",
    });
    if (!result.imeActivationFailed) {
      return result;
    }
    logger.warn(
      `[SendKeys] IME unavailable for the clear; deleting with key events: ${result.error}`,
    );
    return this.clearImeFieldWithKeyEvents(signal, display);
  }

  /** Explicit `mode: "a11y"` clear: ACTION_SET_TEXT, then key-event deletes if it fails. */
  private async clearAndroidWithAccessibility(
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
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
    return this.eventOnlyTyper.clearEventOnlyForReplace(textLength, signal, display);
  }

  private clearAndVerifyAndroid(
    signal?: AbortSignal,
    display?: string,
    clear?: () => Promise<TextActionResult>,
    passwordField = false,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }> {
    return this.clearVerifier.clearAndVerifyAndroid(signal, display, clear, passwordField);
  }

  private readFreshObservation(signal?: AbortSignal, display?: string): Promise<ObserveResult> {
    return this.clearVerifier.readFreshObservation(signal, display);
  }

  private readFocusedTextSnapshot(
    observation: ObserveResult,
  ): { text: string; length: number } | undefined {
    return this.clearVerifier.readFocusedTextSnapshot(observation);
  }

  private resolveMode(requestedMode: SendKeysTypingMode): AndroidSendKeysTypingMode {
    return requestedMode === "auto" ? "ime" : requestedMode;
  }

  resetCaretState(): void {
    this.session.androidCaretUnsafe = false;
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
      this.session.androidCaretUnsafe = true;
    }
  }

  private reportedMode(mode: AndroidSendKeysTypingMode): ResolvedSendKeysTypingMode {
    return this.device.platform === "ios" ? "xcuiTypeText" : mode;
  }

  private resolveAutoPasswordMode(
    requestedMode: SendKeysTypingMode,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ) {
    return this.passwordRouting.resolveAutoPasswordMode(requestedMode, operation, signal, display);
  }

  private verifyPasswordRouting(
    routing: { verifyPasswordDeliverable: boolean },
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.passwordRouting.verifyPasswordRouting(routing, text, signal);
  }

  private executeIosType(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    return this.iosTyper.executeIosType(text, operation, signal, display);
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
        return this.a11yTyper.type({ text, operation, signal, display });
      case "eventLast":
        return this.eventLastTyper.type({ text, operation, signal, display });
      case "eventAll":
        return this.eventAllTyper.type({ text, operation, signal, focusedInputVerified, display });
      case "eventOnly":
        return this.eventOnlyTyper.type({ text, operation, signal, display });
      case "ime":
        return this.imeCommitTyper.type({
          text,
          operation,
          mode,
          keyboardProfile,
          autoImeFallback,
          routing,
        });
      case "imeKeyEvents":
        return this.imeCommitTyper.type({ text, operation, mode, keyboardProfile, routing });
    }
  }

  private async prepareTypingMode(mode: AndroidSendKeysTypingMode, signal?: AbortSignal) {
    // A non-IME typing mode ends the span BEFORE delivery. A later IME type may
    // reactivate; interleaved key/clear commands deliberately retain the active IME.
    if (mode !== "ime" && mode !== "imeKeyEvents") {
      await this.imeSpanService.restoreImeSpan();
      this.checkAbort(signal);
    }
  }

  private executeAndroidImeCommit(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    routing: ImeCommitRouting = {},
    mode: "ime" | "imeKeyEvents" = "ime",
  ): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode; imeActivationFailed?: boolean }
  > {
    return this.imeCommitTyper.executeAndroidImeCommit(
      text,
      operation,
      keyboardProfile,
      routing,
      mode,
    );
  }

  private verifySafeImeRecovery(
    snapshot: SendKeysImeRecoverySnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.imeRestore.verifySafeImeRecovery(snapshot, signal);
  }

  /**
   * IME-mode clear for a CtrlProxy without `ime_clear_field_v1`: key-event deletion sized from
   * the focused field, or an update hint when the length is unknown.
   */
  private clearImeFieldWithKeyEvents(
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    return this.imeCommitTyper.clearImeFieldWithKeyEvents(signal, display);
  }

  private readFocusedText(observation: ObserveResult): string | undefined {
    return this.clearVerifier.readFocusedText(observation);
  }

  private checkAbort(signal?: AbortSignal, error?: unknown): void {
    checkAbortCheckpoint(signal, error);
  }

  private pinImeUser(signal?: AbortSignal): ReturnType<ImeRestore["pinImeUser"]> {
    return this.imeRestore.pinImeUser(signal);
  }
  private readDefaultIme(): ReturnType<ImeRestore["readDefaultIme"]> {
    return this.imeRestore.readDefaultIme();
  }
  private readCommitImeEnabled(): ReturnType<ImeRestore["readCommitImeEnabled"]> {
    return this.imeRestore.readCommitImeEnabled();
  }
  private pinnedImeCatalog(): ReturnType<ImeRestore["pinnedImeCatalog"]> {
    return this.imeRestore.pinnedImeCatalog();
  }
  private checkKeyboardProfileSupport(profile?: KeyboardProfileId): Promise<TextActionResult> {
    return this.imeRestore.checkKeyboardProfileSupport(profile);
  }
  private setRequestedKeyboardProfile(
    profile?: KeyboardProfileId,
  ): ReturnType<ImeRestore["setRequestedKeyboardProfile"]> {
    return this.imeRestore.setRequestedKeyboardProfile(profile);
  }
  private restoreKeyboardProfileIfNeeded(
    requested?: KeyboardProfileId,
    previous?: string,
  ): Promise<void> {
    return this.imeRestore.restoreKeyboardProfileIfNeeded(requested, previous);
  }
  private activateCommitIme(wasEnabled: boolean): Promise<boolean> {
    return this.imeRestore.activateCommitIme(wasEnabled);
  }

  private restoreIme(
    priorImeId: string | null,
    wasEnabled: boolean,
    subtype: ImeSubtypeSnapshot,
  ): Promise<void> {
    return this.imeRestore.restoreIme(priorImeId, wasEnabled, subtype);
  }
  private get commitImeId(): string {
    return this.imeRestore.commitImeId;
  }

  /**
   * Some keyboards/fields change letter case after key events, e.g. a keyboard's sentence-start
   * shift capitalising the first letter in an empty field (#9888, #10404). Warn only on a
   * case-insensitive match; any other mismatch or an unreadable field is left alone.
   */
  private verifyKeyEventLetterCase(
    text: string,
    typed: TextActionResult,
    mode: "eventAll" | "eventOnly" | "eventLast",
    signal?: AbortSignal,
    display?: string,
    before = "",
  ): Promise<TextActionResult> {
    return this.keyEventSupport.verifyKeyEventLetterCase(
      text,
      typed,
      mode,
      signal,
      display,
      before,
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

  private async readPrecedingState(needed: boolean): Promise<InsertTextState | undefined> {
    return needed ? this.textClient.readInsertTextState?.() : undefined;
  }

  /** @internal Typed view of private execution paths for unit tests; not part of the public API. */
  get testHooks() {
    return { executeKeyEventPlan: this.executeKeyEventPlan.bind(this) };
  }

  private executeKeyEventPlanSafely(
    plan: KeyEventPlan,
    previouslyMutated: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult | undefined> {
    return this.keyEventSupport.executeKeyEventPlanSafely(plan, previouslyMutated, signal);
  }

  /**
   * A key-event failure can quote the adb command line, which names the key codes typed. For a
   * password field, log and report only the error class, never the message.
   */
  private keyEventFailureMessage(error: unknown): string {
    return this.keyEventSupport.keyEventFailureMessage(error);
  }

  /**
   * Clear before a replace and wait until it is visible, so a following insert or the preceding-state
   * baseline read does not plan from the pre-clear text (#9940). `unchangedWarning` is set when the
   * field still shows its pre-clear text: a mask or prefix at its cleared content, or a refused clear.
   */
  private clearForReplace(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }> {
    return this.keyEventSupport.clearForReplace(operation, signal, display);
  }

  private requireFocusedAndroidInput(
    signal?: AbortSignal,
    error: string = ANDROID_FOCUSED_INPUT_ERROR,
    display?: string,
  ): Promise<
    | { success: true; hierarchy: NonNullable<ObserveResult["viewHierarchy"]> }
    | { success: false; error: string }
  > {
    return this.keyEventSupport.requireFocusedAndroidInput(signal, error, display);
  }

  private getEventAllKeyEventPlan(grapheme: string): Promise<KeyEventPlan | null> {
    return this.keyEventSupport.getEventAllKeyEventPlan(grapheme);
  }
  private getKeyEventPlan(char: string, signal?: AbortSignal): Promise<KeyEventPlan | null> {
    return this.keyEventSupport.getKeyEventPlan(char, signal);
  }

  private supportsAndroidKeyCombination(signal?: AbortSignal): Promise<boolean> {
    return this.keyEventSupport.supportsAndroidKeyCombination(signal);
  }

  private getAndroidApiLevel(signal?: AbortSignal): Promise<number | null> {
    return this.keyEventSupport.getAndroidApiLevel(signal);
  }

  private executeKeyEventPlan(plan: KeyEventPlan, signal?: AbortSignal): Promise<void> {
    return this.keyEventSupport.executeKeyEventPlan(plan, signal);
  }
}
