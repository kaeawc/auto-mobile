import type { BootedDevice, ImeAction, ObserveResult } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { clearTextWithKeyEvents, getFocusedTextLength, hasFocusedTextInput } from "./ClearText";
import { InputKey, type InputKeyModifier, type InputKeyName } from "./InputKey";
import { TapOnElement } from "./TapOnElement";
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
] as const;
export type SendKeysTypingMode = (typeof SEND_KEYS_TYPING_MODES)[number];
export type ResolvedSendKeysTypingMode = Exclude<SendKeysTypingMode, "auto">;

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
  error?: string;
}

export interface SendKeysResult {
  success: boolean;
  completedCommands: number;
  failedIndex?: number;
  commands: SendKeysCommandResult[];
  observation: ObserveResult;
  error?: string;
}

interface SendKeysFailure {
  index: number;
  error: string;
}

export interface SendKeysCommandExecutor {
  type(command: SendKeysTypeCommand, signal?: AbortSignal): Promise<SendKeysCommandResult>;
  key(command: SendKeysKeyCommand, signal?: AbortSignal): Promise<SendKeysCommandResult>;
  clear(signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
}

export interface SendKeysTargetFocuser {
  focus(
    selector: SendKeysSelector,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface SendKeysObserver {
  execute(options?: { signal?: AbortSignal; skipWaitForFresh?: boolean }): Promise<ObserveResult>;
}

export interface SendKeysDependencies {
  executor?: SendKeysCommandExecutor;
  focuser?: SendKeysTargetFocuser;
  observer?: SendKeysObserver;
}

export type TextActionResult = { success: boolean; error?: string };

export interface SendKeysTextClient {
  replace(text: string): Promise<TextActionResult>;
  insert(text: string): Promise<TextActionResult>;
  clear(): Promise<TextActionResult>;
  ime(action: ImeAction): Promise<TextActionResult>;
}

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
    const resolvedMode = this.resolveMode(operation, requestedMode);
    const baseResult = {
      index: -1,
      action: "type" as const,
      textLength: Array.from(command.text).length,
      operation,
      requestedMode,
      resolvedMode,
    };

    try {
      const result: TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode } =
        this.device.platform === "ios"
          ? await this.executeIosType(command.text, operation, resolvedMode, signal)
          : await this.executeAndroidType(command.text, operation, resolvedMode, signal);
      return {
        ...baseResult,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
        ...(result.resolvedMode ? { resolvedMode: result.resolvedMode } : {}),
      };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[SendKeys] Text command failed", error);
      return { ...baseResult, success: false, error: errorMessage(error) };
    }
  }

  async key(command: SendKeysKeyCommand, signal?: AbortSignal): Promise<SendKeysCommandResult> {
    signal?.throwIfAborted();
    const modifiers = command.modifiers ?? [];
    if (isSemanticKey(command.key)) {
      const result = await this.textClient.ime(command.key);
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

  clear(signal?: AbortSignal): Promise<TextActionResult> {
    signal?.throwIfAborted();
    return this.textClient.clear();
  }

  private resolveMode(
    operation: SendKeysOperation,
    requestedMode: SendKeysTypingMode,
  ): ResolvedSendKeysTypingMode {
    if (requestedMode !== "auto") {
      return requestedMode;
    }
    return operation === "insert" ? "eventAll" : "a11y";
  }

  private async executeIosType(
    text: string,
    operation: SendKeysOperation,
    mode: ResolvedSendKeysTypingMode,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    signal?.throwIfAborted();
    if (operation === "replace") {
      const clearResult = await this.textClient.clear();
      if (!clearResult.success) {
        return clearResult;
      }
    }

    // XCUITest's typeText emits keyboard input and replaces the active selection.
    // That gives iOS equivalent behavior for every delivery mode even though the
    // runner does not expose Android's ACTION_SET_TEXT/event split.
    const result = await this.textClient.insert(text);
    if (!result.success) {
      return result;
    }
    return { success: true };
  }

  private async executeAndroidType(
    text: string,
    operation: SendKeysOperation,
    mode: ResolvedSendKeysTypingMode,
    signal?: AbortSignal,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    switch (mode) {
      case "a11y":
        return operation === "replace"
          ? this.textClient.replace(text)
          : this.textClient.insert(text);
      case "eventLast":
        return this.executeAndroidEventLast(text, operation, signal);
      case "eventAll":
        return this.executeAndroidEventAll(text, operation, signal);
      case "eventOnly":
        return this.executeAndroidEventOnly(text, operation, signal);
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

    const prefix = chars.slice(0, split.index).join("");
    const suffix = chars.slice(split.index + 1).join("");
    const initialResult = await this.prepareEventLastPrefix(prefix, operation);
    if (!initialResult.success) {
      return initialResult;
    }

    await this.executeKeyEventPlan(split.plan, signal);
    return suffix ? this.textClient.insert(suffix) : { success: true };
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
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const chars = Array.from(text);
    if (!(await this.hasAndroidKeyEvent(chars))) {
      const result =
        operation === "replace"
          ? await this.textClient.replace(text)
          : await this.textClient.insert(text);
      return { ...result, resolvedMode: "a11y" };
    }

    const clearResult = await this.clearForReplace(operation);
    if (!clearResult.success) {
      return clearResult;
    }
    return this.executeAndroidEventAllCharacters(chars, signal);
  }

  private async executeAndroidEventAllCharacters(
    chars: string[],
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    for (let index = 0; index < chars.length; index++) {
      signal?.throwIfAborted();
      const plan = await this.getKeyEventPlan(chars[index] ?? "");
      if (plan) {
        await this.executeKeyEventPlan(plan, signal);
        continue;
      }

      let unsupportedRun = chars[index] ?? "";
      while (index + 1 < chars.length && !(await this.getKeyEventPlan(chars[index + 1] ?? ""))) {
        index++;
        unsupportedRun += chars[index] ?? "";
      }
      const insertResult = await this.textClient.insert(unsupportedRun);
      if (!insertResult.success) {
        return insertResult;
      }
    }
    return { success: true };
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

    if (operation === "replace") {
      const clearResult = await this.clearWithKeyEvents(signal);
      if (!clearResult.success) {
        return clearResult;
      }
    }

    for (const plan of plans) {
      await this.executeKeyEventPlan(plan, signal);
    }
    return { success: true };
  }

  private async clearWithKeyEvents(signal?: AbortSignal): Promise<TextActionResult> {
    const observation = await this.observer.execute({ signal, skipWaitForFresh: false });
    const hierarchy = observation.viewHierarchy;
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      return { success: false, error: "eventOnly replace requires a focused editable field" };
    }
    await clearTextWithKeyEvents(this.adb, getFocusedTextLength(hierarchy), signal);
    return { success: true };
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
      ime: async (action) => client.requestImeAction(action),
    };
  }
}

export class SendKeys {
  private readonly executor: SendKeysCommandExecutor;
  private readonly focuser: SendKeysTargetFocuser;
  private readonly observer: SendKeysObserver;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    dependencies: SendKeysDependencies = {},
  ) {
    this.observer = dependencies.observer ?? new RealObserveScreen(device, adbFactory);
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
    const focusFailure = await this.focusTarget(selector, signal);
    const execution = focusFailure
      ? { results: [], failure: focusFailure }
      : await this.executeCommands(commands, progress, signal);
    await progress?.(commands.length, commands.length, "Observing final keyboard input state");
    const observation = await this.observer.execute({ signal });
    return this.buildResult(execution.results, execution.failure, observation);
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
        result = await this.executeCommand(command, signal);
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
  ): Promise<SendKeysCommandResult> {
    switch (command.action) {
      case "type":
        return this.executor.type(command, signal);
      case "key":
        return this.executor.key(command, signal);
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
