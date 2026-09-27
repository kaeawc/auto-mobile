import type { BootedDevice, ImeAction, ObserveResult } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { AndroidCtrlProxyManager } from "../../utils/CtrlProxyManager";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { clearTextWithKeyEvents, getFocusedTextLength, hasFocusedTextInput } from "./ClearText";
import { InputKey, type InputKeyModifier, type InputKeyName } from "./InputKey";
import type { KeyboardProfileId } from "./keyboardProfiles";
import { TapOnElement } from "./TapOnElement";
import { FieldTypeDetector } from "./FieldTypeDetector";
import { DefaultElementParser } from "../utility/ElementParser";
import { quarantineAndroidIme, withAndroidImeLock } from "./androidImeLock";
import {
  ANDROID_KEYCOMBINATION_MIN_API_LEVEL,
  asciiKeyEventNeedsKeyCombination,
  buildAsciiKeyEventPlan,
  type KeyEventPlan,
} from "./asciiKeyEvents";
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

export interface SendKeysCommandResult {
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
  error?: string;
  retryable?: boolean;
}

export interface SendKeysResult {
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
  type(command: SendKeysTypeCommand, signal?: AbortSignal): Promise<SendKeysCommandResult>;
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
  ): Promise<{ success: boolean; error?: string }>;
}

export interface SendKeysObserver {
  execute(options?: {
    signal?: AbortSignal;
    skipWaitForFresh?: boolean;
    minTimestamp?: number;
  }): Promise<ObserveResult>;
}

export interface SendKeysTimestampProvider {
  now(): Promise<number>;
}

export interface SendKeysDependencies {
  executor?: SendKeysCommandExecutor;
  focuser?: SendKeysTargetFocuser;
  observer?: SendKeysObserver;
  timestampProvider?: SendKeysTimestampProvider;
  timer?: Timer;
}

export type TextActionResult = {
  success: boolean;
  error?: string;
  partialApplication?: boolean;
  sessionUnsafe?: boolean;
};

export interface SendKeysTextClient {
  replace(text: string): Promise<TextActionResult>;
  insert(text: string): Promise<TextActionResult>;
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

type DefaultImeReadResult =
  | { success: true; imeId: string | null }
  | { success: false; error: string };

export interface SendKeysInputKey {
  press(
    key: InputKeyName,
    timeoutMs?: number,
    frameContext?: string,
    modifiers?: readonly InputKeyModifier[],
  ): Promise<{ success: boolean; error?: string }>;
}

export interface SendKeysPlatformDependencies {
  textClient?: SendKeysTextClient;
  inputKey?: SendKeysInputKey;
}

export class DefaultSendKeysCommandExecutor implements SendKeysCommandExecutor {
  private readonly adb: AdbExecutor;
  private readonly textClient: SendKeysTextClient;
  private readonly inputKey: SendKeysInputKey;
  private readonly observer: SendKeysObserver;
  private androidKeyCombinationSupported: boolean | undefined;

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
    this.inputKey = dependencies.inputKey ?? new InputKey(device, adbFactory);
    this.textClient = dependencies.textClient ?? this.createTextClient(adbFactory);
  }

  async type(command: SendKeysTypeCommand, signal?: AbortSignal): Promise<SendKeysCommandResult> {
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
        return { ...baseResult, success: false, error: validationError };
      }
      resolvedMode = await this.resolveAutoPasswordMode(requestedMode, operation, signal);
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
              signal,
              this.isAutoPasswordInsert(requestedMode, resolvedMode),
            );
      return {
        ...baseResult,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
        ...(result.partialApplication ? { partialApplication: true } : {}),
        ...(result.resolvedMode ? { resolvedMode: result.resolvedMode } : {}),
      };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[SendKeys] Text command failed", error);
      return { ...baseResult, success: false, error: errorMessage(error) };
    }
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
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async clear(signal?: AbortSignal): Promise<TextActionResult> {
    signal?.throwIfAborted();
    const clearResult = await this.textClient.clear();
    if (clearResult.success || this.device.platform !== "android") {
      return clearResult;
    }
    logger.warn(`[SendKeys] Android accessibility clear failed: ${clearResult.error}`);
    const focusResult = await this.requireFocusedAndroidInput(signal);
    if (!focusResult.success) {
      return focusResult;
    }
    const textLength = getFocusedTextLength(focusResult.hierarchy);
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
  ): Promise<AndroidSendKeysTypingMode> {
    if (this.device.platform !== "android" || requestedMode !== "auto") {
      return this.resolveMode(requestedMode);
    }
    return (await this.isFocusedAndroidPasswordField(signal))
      ? operation === "insert"
        ? "eventAll"
        : "a11y"
      : "ime";
  }

  private async isFocusedAndroidPasswordField(signal?: AbortSignal): Promise<boolean> {
    const observation = await this.observer.execute({ signal, skipWaitForFresh: false });
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
    signal?: AbortSignal,
    focusedInputVerified = false,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    switch (mode) {
      case "a11y":
        return operation === "replace"
          ? this.textClient.replace(text)
          : this.textClient.insert(text);
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
          signal,
        );
      case "imeKeyEvents":
        return this.executeAndroidImeCommit(
          text,
          operation,
          keyboardProfile,
          signal,
          "imeKeyEvents",
        );
    }
  }

  private async executeAndroidImeOrFallback(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    autoImeFallback: AndroidSendKeysTypingMode | undefined,
    signal?: AbortSignal,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    if (!autoImeFallback || (await this.textClient.supportsImeCommit())) {
      return this.executeAndroidImeCommit(text, operation, keyboardProfile, signal);
    }
    const fallback = await this.executeAndroidType(
      text,
      operation,
      autoImeFallback,
      keyboardProfile,
      undefined,
      signal,
    );
    return { ...fallback, resolvedMode: autoImeFallback };
  }

  private async executeAndroidImeCommit(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    signal?: AbortSignal,
    mode: "ime" | "imeKeyEvents" = "ime",
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    signal?.throwIfAborted();
    // Serialize the whole capture→activate→commit→restore section per device so a
    // second call cannot borrow/restore the IME while this one is mid-flight (#7464).
    return withAndroidImeLock(
      this.device.deviceId,
      () => this.runAndroidImeCommit(text, operation, keyboardProfile, signal, mode),
      signal,
    );
  }

  private async runAndroidImeCommit(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    signal?: AbortSignal,
    mode: "ime" | "imeKeyEvents" = "ime",
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    signal?.throwIfAborted();
    if (!(await this.textClient.supportsImeCommit())) {
      const error =
        "IME commit is not available: the installed control-proxy build does not advertise request_commit_text (re-cut/update the APK).";
      logger.warn(`[SendKeys] ${error}`);
      return { success: false, error };
    }
    if (mode === "imeKeyEvents" && !(await this.textClient.supportsImeKeyEvents())) {
      return {
        success: false,
        error: "IME key events are unavailable: update the control-proxy APK.",
      };
    }

    const profileSupport = await this.checkKeyboardProfileSupport(keyboardProfile);
    if (!profileSupport.success) {
      return { ...profileSupport, resolvedMode: mode };
    }

    const priorResult = await this.readDefaultIme();
    if (!priorResult.success) {
      return priorResult;
    }
    const prior = priorResult.imeId;
    const enabledResult = await this.readCommitImeEnabled();
    if (!enabledResult.success) {
      return enabledResult;
    }
    const wasEnabled = enabledResult.enabled;

    return this.commitWithActiveIme(
      text,
      operation,
      keyboardProfile,
      prior,
      wasEnabled,
      signal,
      mode,
    );
  }

  private async commitWithActiveIme(
    text: string,
    operation: SendKeysOperation,
    keyboardProfile: KeyboardProfileId | undefined,
    prior: string | null,
    wasEnabled: boolean,
    signal?: AbortSignal,
    mode: "ime" | "imeKeyEvents" = "ime",
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const profileResult = await this.setRequestedKeyboardProfile(keyboardProfile);
    if (!profileResult.success) {
      return { ...profileResult, resolvedMode: mode };
    }
    const previousProfileId = profileResult.previousProfileId;

    if (!(await this.activateCommitIme(wasEnabled))) {
      await this.restoreIme(prior, wasEnabled);
      await this.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
      return { success: false, error: "Failed to activate the IME for text commit." };
    }

    let safeToRestore = true;
    try {
      if (operation === "replace") {
        const clearResult = await this.textClient.clear();
        if (!clearResult.success) {
          return { ...clearResult, resolvedMode: mode };
        }
      }
      const result = await this.textClient.commitViaIme(
        text,
        prior,
        signal,
        mode === "imeKeyEvents" ? "keyEvents" : "commit",
      );
      safeToRestore = this.canRestoreAfterImeCommit(result);
      return {
        ...(operation === "replace" ? markPartialAfterMutation(result) : result),
        resolvedMode: mode,
      };
    } finally {
      if (safeToRestore) {
        await this.restoreKeyboardProfileIfNeeded(keyboardProfile, previousProfileId);
        await this.restoreIme(prior, wasEnabled);
      }
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
        return { success: false, error: `Failed to list enabled IMEs: ${result.stderr.trim()}` };
      }
      return {
        success: true,
        enabled: result.stdout.split(/\r?\n/).some((id) => id.trim() === this.commitImeId),
      };
    } catch (error) {
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

  private async restoreIme(priorImeId: string | null, wasEnabled: boolean): Promise<void> {
    if (priorImeId !== null) {
      try {
        const result = await this.adb.executeCommand(`shell ime set ${priorImeId}`);
        if (result.stderr.trim()) {
          logger.warn(`[SendKeys] Failed to restore the prior IME: ${result.stderr.trim()}`);
        }
      } catch (error) {
        // Restoration is best-effort so it cannot mask the text-commit result.
        logger.warn("[SendKeys] Failed to restore the prior IME", error);
      }
    }
    if (!wasEnabled) {
      await this.disableCommitIme();
    }
  }

  private get commitImeId(): string {
    return `${AndroidCtrlProxyManager.PACKAGE}/.ime.CtrlProxyIme`;
  }

  private async disableCommitIme(): Promise<void> {
    // This removes the companion from the keyboard picker; activateCommitIme re-enables it next time.
    try {
      const result = await this.adb.executeCommand(`shell ime disable ${this.commitImeId}`);
      if (result.stderr.trim()) {
        logger.warn(`[SendKeys] Failed to disable the text-commit IME: ${result.stderr.trim()}`);
      }
    } catch (error) {
      // Disabling is best-effort so it cannot mask the text-commit result.
      logger.warn("[SendKeys] Failed to disable the text-commit IME", error);
    }
  }

  private async executeAndroidEventLast(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const chars = Array.from(text);
    const split = await this.findLastKeyEvent(chars);
    if (!split) {
      const result =
        operation === "replace"
          ? await this.textClient.replace(text)
          : await this.textClient.insert(text);
      return { ...result, resolvedMode: "a11y" };
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

    const eventFailure = await this.executeKeyEventPlanSafely(
      split.plan,
      operation === "replace" || prefix.length > 0,
      signal,
    );
    if (eventFailure) {
      return eventFailure;
    }
    const suffixResult = suffix ? await this.textClient.insert(suffix) : { success: true };
    return markPartialAfterMutation(suffixResult);
  }

  private async findLastKeyEvent(
    chars: string[],
  ): Promise<{ index: number; plan: KeyEventPlan } | undefined> {
    for (let index = chars.length - 1; index >= 0; index--) {
      const char = chars[index];
      if (!char || /\s/.test(char)) {
        continue;
      }
      const plan = await this.getKeyEventPlan(char);
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
    return prefix ? this.textClient.insert(prefix) : { success: true };
  }

  private async executeAndroidEventAll(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    focusedInputVerified = false,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const chars = Array.from(text);
    if (!(await this.hasAndroidKeyEvent(chars))) {
      const result =
        operation === "replace"
          ? await this.textClient.replace(text)
          : await this.textClient.insert(text);
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
    return this.executeAndroidEventAllCharacters(chars, operation === "replace", signal);
  }

  private async executeAndroidEventAllCharacters(
    chars: string[],
    previouslyMutated: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    let mutated = previouslyMutated;
    for (let index = 0; index < chars.length; index++) {
      signal?.throwIfAborted();
      const plan = await this.getKeyEventPlan(chars[index] ?? "");
      if (plan) {
        const eventFailure = await this.executeKeyEventPlanSafely(plan, mutated, signal);
        if (eventFailure) {
          return eventFailure;
        }
        mutated = true;
        continue;
      }

      let unsupportedRun = chars[index] ?? "";
      while (index + 1 < chars.length && !(await this.getKeyEventPlan(chars[index + 1] ?? ""))) {
        index++;
        unsupportedRun += chars[index] ?? "";
      }
      const insertResult = await this.textClient.insert(unsupportedRun);
      if (!insertResult.success) {
        return markPartialAfterPriorMutation(insertResult, mutated);
      }
      mutated = true;
    }
    return { success: true };
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

  private async hasAndroidKeyEvent(chars: string[]): Promise<boolean> {
    for (const char of chars) {
      if (await this.getKeyEventPlan(char)) {
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
      const plan = await this.getKeyEventPlan(char);
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
      const textLength = getFocusedTextLength(focusResult.hierarchy);
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
      await clearTextWithKeyEvents(this.adb, count, signal, () => {
        deleted = true;
      });
      return { success: true };
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
    const observation = await this.observer.execute({ signal, skipWaitForFresh: false });
    const hierarchy = observation.viewHierarchy;
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      return {
        success: false,
        error: "Android event delivery requires a focused editable field",
      };
    }
    return { success: true, hierarchy };
  }

  private async getKeyEventPlan(char: string): Promise<KeyEventPlan | null> {
    let supportsKeyCombination = false;
    if (asciiKeyEventNeedsKeyCombination(char)) {
      supportsKeyCombination = await this.supportsAndroidKeyCombination();
    }
    return buildAsciiKeyEventPlan(char, supportsKeyCombination);
  }

  private async supportsAndroidKeyCombination(): Promise<boolean> {
    if (this.androidKeyCombinationSupported !== undefined) {
      return this.androidKeyCombinationSupported;
    }
    const apiLevel = await readAndroidDeviceApiLevel(this.adb);
    this.androidKeyCombinationSupported =
      apiLevel !== null && apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL;
    return this.androidKeyCombinationSupported;
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
        replace: async (text) => client.requestSetText(text),
        insert: async (text) => client.requestInsertText(text),
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
  private readonly observer: SendKeysObserver;
  private readonly timestampProvider: SendKeysTimestampProvider;
  private readonly timer: Timer;

  constructor(
    private readonly device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    dependencies: SendKeysDependencies = {},
  ) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.observer = dependencies.observer ?? new RealObserveScreen(device, adbFactory);
    this.timestampProvider =
      dependencies.timestampProvider ??
      (device.platform === "android"
        ? { now: async () => adbFactory.create(device).getDeviceTimestampMs() }
        : { now: async () => defaultTimer.now() });
    this.executor =
      dependencies.executor ??
      new DefaultSendKeysCommandExecutor(device, adbFactory, this.observer);
    this.focuser =
      dependencies.focuser ??
      ({
        focus: async (selector, signal) => {
          const result = await new TapOnElement(device).execute(
            { ...selector, action: "focus" },
            undefined,
            signal,
          );
          return { success: result.success, error: result.error };
        },
      } satisfies SendKeysTargetFocuser);
  }

  async execute(
    commands: SendKeysCommand[],
    selector?: SendKeysSelector,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<SendKeysResult> {
    const semanticKey =
      commands.length === 1 && commands[0]?.action === "key" && isSemanticKey(commands[0].key)
        ? commands[0].key
        : undefined;
    if (this.device.platform === "ios" && semanticKey) {
      return this.executeBoundedIosIme(commands, selector, progress, signal, semanticKey);
    }
    return this.executeUnbounded(commands, selector, progress, signal);
  }

  private async executeBoundedIosIme(
    commands: SendKeysCommand[],
    selector: SendKeysSelector | undefined,
    progress: ProgressCallback | undefined,
    signal: AbortSignal | undefined,
    key: SendKeysSemanticKey,
  ): Promise<SendKeysResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    let dispatched = false;
    let actionResult: SendKeysCommandResult | undefined;
    let deadlineHandle: ReturnType<Timer["setTimeout"]> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      deadlineHandle = this.timer.setTimeout(() => resolve("deadline"), 5000);
    });
    const interaction = this.executeUnbounded(
      commands,
      selector,
      progress,
      controller.signal,
      () => {
        dispatched = true;
      },
      (result) => {
        actionResult = result;
      },
    );
    try {
      const outcome = await Promise.race([interaction, deadline]);
      if (outcome !== "deadline") {
        return outcome;
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
      if (deadlineHandle !== undefined) {
        this.timer.clearTimeout(deadlineHandle);
      }
      signal?.removeEventListener("abort", abort);
    }
  }

  private async executeUnbounded(
    commands: SendKeysCommand[],
    selector?: SendKeysSelector,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    onDispatch?: () => void,
    onCommandResult?: (result: SendKeysCommandResult) => void,
  ): Promise<SendKeysResult> {
    signal?.throwIfAborted();
    const preflight = this.preflightCommands(commands);
    // Accept hierarchy updates emitted while focus or command delivery is completing.
    const actionStartTimestamp = preflight ? undefined : await this.timestampProvider.now();
    const focusFailure = preflight ? undefined : await this.focusTarget(selector, signal);
    signal?.throwIfAborted();
    const execution =
      preflight ??
      (focusFailure
        ? { results: [], failure: focusFailure }
        : await this.executeCommands(commands, progress, signal, onDispatch, onCommandResult));
    const minTimestamp = preflight || focusFailure ? undefined : actionStartTimestamp;
    signal?.throwIfAborted();
    await progress?.(commands.length, commands.length, "Observing final keyboard input state");
    const observation = await this.observer.execute({
      signal,
      skipWaitForFresh: false,
      minTimestamp,
    });
    return this.buildResult(execution.results, execution.failure, observation);
  }

  private preflightCommands(
    commands: SendKeysCommand[],
  ): { results: SendKeysCommandResult[]; failure: SendKeysFailure } | undefined {
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
  ): Promise<SendKeysFailure | undefined> {
    if (!selector) {
      return undefined;
    }
    signal?.throwIfAborted();
    const result = await this.focuser.focus(selector, signal);
    return result.success
      ? undefined
      : {
          index: 0,
          error: result.error ?? "Failed to focus the target element before sending keys",
        };
  }

  private async executeCommands(
    commands: SendKeysCommand[],
    progress?: ProgressCallback,
    signal?: AbortSignal,
    onDispatch?: () => void,
    onCommandResult?: (result: SendKeysCommandResult) => void,
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
        result = await this.executeCommand(command, signal, onDispatch);
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn(`[SendKeys] ${command.action} command ${index} failed`, error);
        result = {
          index,
          action: command.action,
          success: false,
          error: errorMessage(error),
        };
      }
      result.index = index;
      onCommandResult?.(result);
      results.push(result);
      if (!result.success) {
        return {
          results,
          failure: { index, error: result.error ?? `sendKeys command ${index} failed` },
        };
      }
    }
    return { results };
  }

  private buildResult(
    results: SendKeysCommandResult[],
    failure: SendKeysFailure | undefined,
    observation: ObserveResult,
  ): SendKeysResult {
    if (failure) {
      return {
        success: false,
        completedCommands: results.filter((result) => result.success).length,
        failedIndex: failure.index,
        commands: results,
        observation,
        error: failure.error,
      };
    }

    return {
      success: true,
      completedCommands: results.length,
      commands: results,
      observation,
    };
  }

  private executeCommand(
    command: SendKeysCommand,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<SendKeysCommandResult> {
    switch (command.action) {
      case "type":
        return this.executor.type(command, signal);
      case "key":
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
