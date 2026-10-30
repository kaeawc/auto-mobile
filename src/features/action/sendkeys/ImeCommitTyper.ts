import type { TypingSession } from "./TypingSession";
import { ANDROID_TYPE_FOCUSED_INPUT_ERROR } from "./AndroidTypingConstants";
import type {
  SendKeysTextClient,
  SendKeysOperation,
  TextActionResult,
  ResolvedSendKeysTypingMode,
  SendKeysObserver,
  SendKeysPlatformDependencies,
} from "../SendKeys";
import type { KeyboardProfileId } from "../keyboardProfiles";
import type { AndroidImeCatalog, ImeSubtypeSnapshot } from "../AndroidImeCatalog";
import type { ObserveResult, BootedDevice } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { AndroidModeTyper, AndroidModeTypeRequest } from "./AndroidModeTyper";
import type { ImeCommitRouting, AndroidTypeOptions } from "./ImeTypes";
import type { ImeRestore, SendKeysImeRecoverySnapshot } from "./ImeRestore";
import type { EventOnlyTyper } from "./EventOnlyTyper";
import type { Timer } from "../../../utils/SystemTimer";
import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import { withAndroidImeLock, quarantineAndroidIme } from "../androidImeLock";
import { AUTO_MOBILE_IME_ID } from "../AndroidImeCatalog";
import { isDebugModeEnabled } from "../../../utils/debug";
import { getFocusedTextLength, hasFocusedTextInput } from "../ClearText";
import { IME_COMMIT_READ_BACK_SETTLE_MS } from "./AndroidTypingConstants";
import {
  focusedFieldIsPassword,
  withImeFailure,
  IME_INSERTED_TEXT_UNAVAILABLE_WARNING,
  verifyImeCommitResult,
  confirmImeCommitAfterSyncLoss,
  imeCommitExceptionResult,
  isRetryableImeRestartWithNothingCommitted,
} from "../imeFailureDiagnostics";
import { exponentialBackoff } from "../../../utils/Backoff";
import type { ImeSpanSnapshot } from "./ImeSpan";
import { KEY_EVENT_FORMAT_MARKERS } from "./AndroidTypingConstants";
/** Bounded resends after a restart that provably committed nothing (first focus of a field). */
const IME_RESTART_RETRIES = 2;
const IME_RESTART_BACKOFF = exponentialBackoff({ initialDelayMs: 100, maxDelayMs: 400 });
interface ImeCommitProgress {
  result: TextActionResult;
  safeToRestore: boolean;
}
/** The IME state read before a commit, which the commit must restore afterwards. */
interface CapturedImeState {
  prior: string | null;
  wasEnabled: boolean;
  priorSubtype: ImeSubtypeSnapshot;
}
interface ActiveImeCommitOptions extends CapturedImeState {
  text: string;
  operation: SendKeysOperation;
  keyboardProfile: KeyboardProfileId | undefined;
  routing?: ImeCommitRouting;
  mode?: "ime" | "imeKeyEvents";
}
const IME_CLEAR_FIELD_UNAVAILABLE_ERROR =
  "IME-mode clear needs the CtrlProxy ime_clear_field_v1 capability, and key-event deletion " +
  "could not size the focused text. Update the CtrlProxy APK, then retry.";
export interface ImeCommitTyperHost {
  session: TypingSession;
  executeAndroidImeCommit: ImeCommitTyper["executeAndroidImeCommit"];
  clearImeFieldWithKeyEvents: ImeCommitTyper["clearImeFieldWithKeyEvents"];
  markPartialAfterMutation(result: TextActionResult): TextActionResult;
  textClient: Pick<
    SendKeysTextClient,
    | "supportsImeCommit"
    | "supportsImeKeyEvents"
    | "supportsImeClearField"
    | "supportsImeInsertedText"
    | "supportsImeTrace"
    | "commitViaIme"
  >;
  device: Pick<BootedDevice, "deviceId">;
  observer: Pick<SendKeysObserver, "execute">;
  timer: Timer;
  imeTraceContext: Pick<AsyncLocalStorage<{ lines?: string[] }>, "getStore">;
  eventOnlyTyper: Pick<EventOnlyTyper, "clearEventOnlyForReplace">;
  getTargetLayer(): HierarchyLayer | undefined;
  isSendKeysBudgetExhausted(signal?: AbortSignal): boolean;
  executeAndroidType(
    options: AndroidTypeOptions,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }>;
  verifySafeImeRecovery(
    snapshot: SendKeysImeRecoverySnapshot,
    signal?: AbortSignal,
  ): Promise<boolean>;
  checkAbort(signal?: AbortSignal, error?: unknown): void;
  restoreIme(
    priorImeId: string | null,
    wasEnabled: boolean,
    subtype: ImeSubtypeSnapshot,
  ): Promise<void>;
  clearAndVerifyAndroid(
    signal?: AbortSignal,
    display?: string,
    clear?: () => Promise<TextActionResult>,
    passwordField?: boolean,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }>;
  withTextWarnings(result: TextActionResult, warnings: Array<string | undefined>): TextActionResult;
  requireFocusedAndroidInput(
    signal?: AbortSignal,
    error?: string,
    display?: string,
  ): Promise<
    | { success: true; hierarchy: NonNullable<ObserveResult["viewHierarchy"]> }
    | { success: false; error: string }
  >;
  readFocusedText(observation: ObserveResult): string | undefined;
  readFocusedTextSnapshot(observation: ObserveResult): { text: string; length: number } | undefined;
}
export interface ImeCommitRestoration extends Pick<
  ImeRestore,
  | "pinImeUser"
  | "readDefaultIme"
  | "readCommitImeEnabled"
  | "checkKeyboardProfileSupport"
  | "setRequestedKeyboardProfile"
  | "restoreKeyboardProfileIfNeeded"
  | "activateCommitIme"
> {
  pinnedImeCatalog(): Pick<AndroidImeCatalog, "readSubtype">;
}
export class ImeCommitTyper implements AndroidModeTyper {
  constructor(
    private readonly host: ImeCommitTyperHost,
    private readonly imeSpanService: Pick<
      NonNullable<SendKeysPlatformDependencies["imeSpanService"]>,
      "imeSpan" | "acquireImeSpan"
    >,
    private readonly restoration: ImeCommitRestoration,
  ) {}
  type({
    text,
    operation,
    keyboardProfile,
    autoImeFallback,
    routing = {},
    mode,
  }: AndroidModeTypeRequest): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode; imeActivationFailed?: boolean }
  > {
    return mode === "imeKeyEvents"
      ? this.host.executeAndroidImeCommit(text, operation, keyboardProfile, routing, mode)
      : this.executeAndroidImeOrFallback(
          text,
          operation,
          keyboardProfile,
          autoImeFallback,
          routing,
        );
  }

  private async executeAndroidImeOrFallback(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    autoImeFallback: AndroidTypeOptions["autoImeFallback"],
    routing: ImeCommitRouting = {},
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const { signal } = routing;
    if (!autoImeFallback) {
      return this.host.executeAndroidImeCommit(text, operation, keyboardProfile, routing);
    }
    if (await this.host.textClient.supportsImeCommit()) {
      const result = await this.host.executeAndroidImeCommit(
        text,
        operation,
        keyboardProfile,
        routing,
      );
      if (!result.imeActivationFailed) {
        return result;
      }
    }
    try {
      const fallback = await this.host.executeAndroidType({
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

  async executeAndroidImeCommit(
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
    if (this.imeSpanService.imeSpan) {
      this.imeSpanService.imeSpan.lastType = {
        text,
        focusedFieldClass: routing.focusedFieldClass,
        passwordField: routing.passwordField,
      };
      await this.imeSpanService.acquireImeSpan(this.imeSpanService.imeSpan, signal);
      return this.runAndroidImeCommit(text, operation, keyboardProfile, routing, mode);
    }
    // Serialize the whole capture→activate→commit→restore section per device so a
    // second call cannot borrow/restore the IME while this one is mid-flight (#7464).
    return withAndroidImeLock(
      this.host.device.deviceId,
      async () => {
        try {
          return await this.runAndroidImeCommit(text, operation, keyboardProfile, routing, mode);
        } finally {
          this.host.session.imeUserId = undefined;
        }
      },
      signal,
      { recoverQuarantined: (snapshot) => this.host.verifySafeImeRecovery(snapshot, signal) },
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
    this.host.checkAbort(signal);
    if (!(await this.host.textClient.supportsImeCommit())) {
      this.host.checkAbort(signal);
      const error =
        "IME commit is not available: the installed control-proxy build does not advertise request_commit_text (re-cut/update the APK).";
      logger.warn(`[SendKeys] ${error}`);
      return withImeFailure({ success: false, error }, text, "unsupportedCapability", {
        focusedFieldClass: routing.focusedFieldClass,
      });
    }
    this.host.checkAbort(signal);
    if (mode === "imeKeyEvents" && !(await this.host.textClient.supportsImeKeyEvents())) {
      this.host.checkAbort(signal);
      return withImeFailure(
        { success: false, error: "IME key events are unavailable: update the control-proxy APK." },
        text,
        "unsupportedCapability",
        { focusedFieldClass: routing.focusedFieldClass },
      );
    }
    this.host.checkAbort(signal);
    if (mode === "imeKeyEvents" && this.host.session.androidCaretUnsafe) {
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

    const profileSupport = await this.restoration.checkKeyboardProfileSupport(keyboardProfile);
    this.host.checkAbort(signal);
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
    if (this.imeSpanService.imeSpan?.snapshot) {
      return { success: true, snapshot: this.imeSpanService.imeSpan.snapshot };
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
  ): Promise<({ success: true } & CapturedImeState) | { success: false; error: string }> {
    const pinned = await this.restoration.pinImeUser(signal);
    this.host.checkAbort(signal);
    if (!pinned.success) {
      return pinned;
    }
    const priorResult = await this.restoration.readDefaultIme();
    this.host.checkAbort(signal);
    if (!priorResult.success) {
      return priorResult;
    }
    const prior = priorResult.imeId;
    const enabledResult = await this.restoration.readCommitImeEnabled();
    this.host.checkAbort(signal);
    if (!enabledResult.success) {
      return enabledResult;
    }
    const priorSubtype = await this.restoration
      .pinnedImeCatalog()
      .readSubtype(prior ?? AUTO_MOBILE_IME_ID, signal);
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
    this.host.checkAbort(signal);
    const profileResult = await this.restoration.setRequestedKeyboardProfile(keyboardProfile);
    if (!profileResult.success) {
      return withImeFailure({ ...profileResult, resolvedMode: mode }, text, "activationBinding", {
        focusedFieldClass: routing.focusedFieldClass,
      });
    }
    const previousProfileId = profileResult.previousProfileId;
    if (signal?.aborted) {
      await this.restoration.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      this.host.checkAbort(signal);
    }

    if (!(await this.activateCommitImeForSpan(options))) {
      let restoreFailure: string | undefined;
      try {
        await this.host.restoreIme(prior, wasEnabled, priorSubtype);
      } catch (error) {
        restoreFailure = errorMessage(error);
      } finally {
        await this.restoration.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
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

    const captured = { prior, wasEnabled, priorSubtype };
    const { outcome, failure, safeToRestore } = await this.performImeCommit(
      text,
      operation,
      routing,
      mode,
      captured,
    );
    if (safeToRestore) {
      await this.restoration.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      return this.restoreAfterImeCommit(captured, outcome, failure, mode);
    }
    if (failure !== undefined) {
      throw failure;
    }
    return outcome!;
  }

  private async activateCommitImeForSpan(options: ActiveImeCommitOptions): Promise<boolean> {
    if (this.imeSpanService.imeSpan?.snapshot) {
      return true;
    }
    const activated = await this.restoration.activateCommitIme(options.wasEnabled);
    if (activated && this.imeSpanService.imeSpan) {
      const { prior, wasEnabled, priorSubtype } = options;
      this.imeSpanService.imeSpan.snapshot = { prior, wasEnabled, priorSubtype };
    }
    return activated;
  }

  private async requestImeCommit(
    text: string,
    priorImeId: string | null,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents" | "clearField",
  ): Promise<TextActionResult> {
    let trace = false;
    if (isDebugModeEnabled()) {
      try {
        trace = (await this.host.textClient.supportsImeTrace?.()) === true;
      } catch (error) {
        // Capability probing is optional; delivery can proceed without diagnostics.
        logger.debug("[SendKeys] IME trace capability unavailable", error);
      }
    }
    let result = await this.host.textClient.commitViaIme(
      text,
      priorImeId,
      signal,
      delivery,
      trace ? true : undefined,
    );
    for (
      let attempt = 1;
      attempt <= IME_RESTART_RETRIES && isRetryableImeRestartWithNothingCommitted(result);
      attempt++
    ) {
      logger.warn(`[SendKeys] IME editor restarted before any text landed; retry ${attempt}`);
      await this.host.timer.sleep(IME_RESTART_BACKOFF.delayForAttempt(attempt));
      this.host.checkAbort(signal);
      result = await this.host.textClient.commitViaIme(
        text,
        priorImeId,
        signal,
        delivery,
        trace ? true : undefined,
      );
    }
    const traceState = this.host.imeTraceContext.getStore();
    if (trace && traceState && result.imeTrace !== undefined) {
      traceState.lines = [...new Set([...(traceState.lines ?? []), ...result.imeTrace])].slice(
        -512,
      );
    }
    return result;
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
    const supportsClearField = await this.host.textClient.supportsImeClearField();
    this.host.checkAbort(routing.signal);
    if (!supportsClearField) {
      // IME mode never uses the accessibility clear: it breaks a rich-text editor's live
      // formatting until the editor resets (#10408). Delete with key events instead.
      const cleared = await this.host.clearImeFieldWithKeyEvents(routing.signal, routing.display);
      if (routing.delivery === "clearField") {
        progress.result = cleared;
      }
      return cleared.success && routing.delivery !== "clearField" ? {} : { outcome: cleared };
    }
    const { result, unchangedWarning } = await this.host.clearAndVerifyAndroid(
      routing.signal,
      routing.display,
      async () => {
        const cleared = await this.requestImeCommit("", null, routing.signal, "clearField");
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
      return { outcome: this.host.withTextWarnings(result, [unchangedWarning]) };
    }
    return { warning: unchangedWarning };
  }

  /**
   * IME-mode clear for a CtrlProxy without `ime_clear_field_v1`: key-event deletion sized from
   * the focused field, or an update hint when the length is unknown.
   */
  async clearImeFieldWithKeyEvents(
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    const focusResult = await this.host.requireFocusedAndroidInput(signal, undefined, display);
    if (!focusResult.success) {
      return focusResult;
    }
    const textLength = getFocusedTextLength(focusResult.hierarchy, undefined, true);
    if (textLength === undefined) {
      return { success: false, error: IME_CLEAR_FIELD_UNAVAILABLE_ERROR };
    }
    logger.info("[SendKeys] CtrlProxy lacks ime_clear_field_v1; clearing with key events");
    return this.host.eventOnlyTyper.clearEventOnlyForReplace(textLength, signal, display);
  }

  private async imeInsertedTextWarning(
    result: TextActionResult,
    text: string,
    routing: ImeCommitRouting,
    mode: "ime" | "imeKeyEvents",
  ): Promise<string | undefined> {
    if (
      !result.success ||
      mode !== "ime" ||
      text.length === 0 ||
      routing.passwordField ||
      this.host.session.typingPasswordField ||
      result.insertedText !== undefined
    ) {
      return undefined;
    }
    let supported = true;
    try {
      supported = await this.host.textClient.supportsImeInsertedText();
    } catch (error) {
      this.host.checkAbort(routing.signal, error);
      // An optional capability probe cannot invalidate an acknowledged, verified commit.
      logger.warn(
        `[SendKeys] IME inserted-text capability probe failed: ${errorMessage(error)}`,
        error,
      );
    }
    this.host.checkAbort(routing.signal);
    if (supported) {
      return undefined;
    }
    logger.warn(IME_INSERTED_TEXT_UNAVAILABLE_WARNING);
    return IME_INSERTED_TEXT_UNAVAILABLE_WARNING;
  }

  private async performImeCommit(
    text: string,
    operation: SendKeysOperation,
    routing: ImeCommitRouting,
    mode: "ime" | "imeKeyEvents",
    captured: CapturedImeState,
  ): Promise<{
    outcome?: TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode };
    failure?: unknown;
    safeToRestore: boolean;
  }> {
    const { signal } = routing;
    const { prior } = captured;
    const priorSubtype = { ...captured.priorSubtype, wasEnabled: captured.wasEnabled };
    const progress: ImeCommitProgress = { result: { success: false }, safeToRestore: true };
    try {
      this.host.checkAbort(signal);
      const cleared = await this.prepareImeCommitClear(
        operation,
        routing,
        prior,
        priorSubtype,
        progress,
      );
      this.host.checkAbort(signal);
      if (cleared.outcome) {
        return {
          outcome: { ...cleared.outcome, resolvedMode: mode },
          safeToRestore: progress.safeToRestore,
        };
      }
      const clearWarning = cleared.warning;
      const result = await this.requestImeCommit(
        text,
        this.imeSpanService.imeSpan ? null : prior,
        signal,
        mode === "imeKeyEvents" ? "keyEvents" : "commit",
      );
      progress.safeToRestore = this.canRestoreAfterImeCommit(result, prior, priorSubtype);
      progress.result = result;
      const syncConfirmed = await this.confirmImeCommitAfterSyncLoss(
        result,
        text,
        routing,
        operation,
      );
      // Identity means the sync-loss read-back did not apply or could not confirm the text.
      if (syncConfirmed !== result) {
        return {
          outcome: {
            ...this.host.withTextWarnings(syncConfirmed, [
              clearWarning,
              await this.imeInsertedTextWarning(syncConfirmed, text, routing, mode),
            ]),
            resolvedMode: mode,
          },
          safeToRestore: progress.safeToRestore,
        };
      }
      if (result.success && mode === "ime" && text.length > 0) {
        const verifiedResult = await this.verifyImeCommit(result, text, routing, operation);
        return {
          outcome: {
            ...this.host.withTextWarnings(this.describeImeCommitFailure(verifiedResult), [
              clearWarning,
              await this.imeInsertedTextWarning(verifiedResult, text, routing, mode),
            ]),
            resolvedMode: mode,
          },
          safeToRestore: progress.safeToRestore,
        };
      }
      return {
        outcome: {
          ...this.host.withTextWarnings(
            this.describeImeCommitFailure(
              withImeFailure(
                operation === "replace" ? this.host.markPartialAfterMutation(result) : result,
                text,
                "commit",
                this.imeCommitDiagnosticContext(result, routing),
              ),
            ),
            [clearWarning],
          ),
          resolvedMode: mode,
        },
        safeToRestore: progress.safeToRestore,
      };
    } catch (error) {
      if (progress.result.success && this.host.isSendKeysBudgetExhausted(signal)) {
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

  private imeCommitDiagnosticContext(result: TextActionResult, routing: ImeCommitRouting) {
    return {
      focusedFieldClass: routing.focusedFieldClass,
      observedText: routing.passwordField ? undefined : result.insertedText,
    };
  }

  private verifyImeCommit(
    result: TextActionResult,
    text: string,
    routing: ImeCommitRouting,
    operation: SendKeysOperation,
  ): Promise<TextActionResult> {
    // Successful prototype delivery is compared once against the platform's authoritative source.
    return this.host.getTargetLayer() === "prototype" && result.success
      ? Promise.resolve(result)
      : verifyImeCommitResult(result, text, this.imeReadBack(text, routing, operation));
  }

  /** The device dispatched every unit but lost its sync barrier: re-read the editor (#10799). */
  private confirmImeCommitAfterSyncLoss(
    result: TextActionResult,
    text: string,
    routing: ImeCommitRouting,
    operation: SendKeysOperation,
  ): Promise<TextActionResult> {
    return confirmImeCommitAfterSyncLoss(result, text, this.imeReadBack(text, routing, operation));
  }

  private imeReadBack(
    text: string,
    routing: ImeCommitRouting,
    operation: SendKeysOperation,
  ): Parameters<typeof verifyImeCommitResult>[2] {
    const { signal, display } = routing;
    return {
      timer: this.host.timer,
      settleMs: IME_COMMIT_READ_BACK_SETTLE_MS,
      observe: () =>
        this.host.observer.execute({
          signal,
          freshness: "fresh",
          skipScreenshot: true,
          // Reuse focused-element extraction without device-state collection or audits.
          hierarchyOnly: true,
          ...(display === undefined ? {} : { display }),
        }),
      checkAbort: (error) => this.host.checkAbort(signal, error),
      lacksRequiredFocus: (observation) => this.imeReadBackLacksRequiredFocus(observation, routing),
      focusedText: (observation) => this.readImeCommitText(observation, operation, text),
      focusError: ANDROID_TYPE_FOCUSED_INPUT_ERROR,
      passwordField: routing.passwordField,
      // Explicit modes skip the pre-type observe; the read-back still shows a password field.
      isPasswordField: (observation) => {
        const password = focusedFieldIsPassword(observation);
        this.host.session.typingPasswordField || (this.host.session.typingPasswordField = password);
        return password;
      },
    };
  }

  private imeReadBackLacksRequiredFocus(
    observation: ObserveResult,
    routing: ImeCommitRouting,
  ): boolean {
    // Auto-submit/navigation can remove focus after a legitimate commit. A passed
    // pre-check makes that read-back unverifiable, like an unreadable field.
    return (
      this.host.getTargetLayer() !== "prototype" &&
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
    const text = this.host.readFocusedText(observation);
    if (!text || this.host.readFocusedTextSnapshot(observation)?.length !== 0) {
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

  private async restoreAfterImeCommit(
    { prior, wasEnabled, priorSubtype }: CapturedImeState,
    outcome: (TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }) | undefined,
    failure: unknown,
    mode: "ime" | "imeKeyEvents",
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    try {
      if (!this.imeSpanService.imeSpan) {
        await this.host.restoreIme(prior, wasEnabled, priorSubtype);
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

  private canRestoreAfterImeCommit(
    result: TextActionResult,
    prior: string | null,
    subtype: ImeSubtypeSnapshot & { wasEnabled: boolean },
  ): boolean {
    if (result.sessionUnsafe) {
      if (this.imeSpanService.imeSpan) {
        this.imeSpanService.imeSpan.safeToRestore = false;
      }
      const snapshot: SendKeysImeRecoverySnapshot | undefined =
        prior === null
          ? undefined
          : {
              imeId: prior,
              subtypeId: subtype.id,
              wasEnabled: subtype.wasEnabled,
              userId: this.host.session.imeUserId,
            };
      quarantineAndroidIme(this.host.device.deviceId, snapshot);
      return false;
    }
    return true;
  }
}
