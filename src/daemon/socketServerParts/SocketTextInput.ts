import {
  parseInputGestureParams,
  parseInputKeyParams,
  parseInputPressButtonParams,
  parseInputSwipeParams,
  parseInputTapParams,
  parseInputTypeTextParams,
  type InputGestureParams,
  type InputKeyParams,
  type InputPressButtonParams,
  type InputSwipeParams,
  type InputTapParams,
  type InputTypeTextParams,
} from "../inputRouteParams";

import { holdDispatchedRequest } from "../dispatchedRequestHold";

import { logger } from "../../utils/logger";

import { McpTimeoutError } from "../wire/McpTimeoutError";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DaemonRequest } from "../types";

import { InputText } from "../../features/action/InputText";
import { imeActionFailedAfterTextEntered } from "../../features/action/imeActionFailedAfterTextEntered";

import { deviceIncarnationToken } from "../../utils/deviceIncarnation";

import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../../features/observe/android";
import { IOSCtrlProxyClient } from "../../features/observe/ios";

import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";

import { ActionableError } from "../../models/ActionableError";

import type { AppendTextFailureSource, BootedDevice, ImeAction } from "../../models";

import { type InputRequestContext } from "../socketServer/inputDeviceGating";

import { InputTypeTextAppendError } from "../socketServer/inputTypeTextAppendError";
import {
  AppendTextInput,
  assertSocketInputNotAborted,
  AndroidAppendTextOptions,
  type AppendTextAttemptResult,
  type AppendTextRetry,
  type InputOperationBudget,
  type InputTypeTextExecutionOptions,
} from "./socketServerContracts";

import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<SocketServerRuntime, "timer" | "appendTextInputs" | "appendTextFactory">;
type Callbacks = Pick<
  SocketServerOperations,
  | "parseInputTypeTextParams"
  | "runInputRoute"
  | "resolveInputTargetDevice"
  | "runInputOperationWithTimeout"
  | "executeInputTypeText"
  | "indeterminateTextError"
  | "holdDispatchedInputRequest"
  | "createSocketInputAdbFactory"
  | "executeAndroidAppendText"
  | "runImeActionWithinBudget"
  | "validateAppendFrameContext"
  | "getAppendTextInput"
  | "retryAppendTextWithRebuiltHelper"
  | "evictDeviceInputCache"
>;
/** Socket Text Input over shared connection state and explicit callbacks. */
export class SocketTextInput {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  async handleInputTypeText(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.callbacks.parseInputTypeTextParams(request.params);
    let confirmedAppendCharsSent: number | undefined;
    const recordConfirmedAppendCharsSent = (charsSent: number): void => {
      confirmedAppendCharsSent = charsSent;
    };
    const { targetDevice, result: inputResult } = await this.callbacks.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/typeText",
        origin: "UnixSocketServer.handleInputTypeText",
        args,
        bypassAndroidDeviceListCache: args.append,
        // A same-serial emulator may reconnect while this request waits behind an
        // earlier input. Re-read its ADB transport inside the keyed callback so the
        // append-helper lookup cannot reuse a capability from that older instance.
        reresolve: async (device) =>
          args.append && args.platform === "android"
            ? await this.callbacks.resolveInputTargetDevice(
                args.platform,
                device.deviceId,
                socketSessionId,
                {
                  action: "input/typeText",
                  bypassAndroidDeviceListCache: true,
                  requester: input?.requester,
                },
              )
            : device,
        checksFrame: true,
        dispatch: async ({
          executionDevice: executionTargetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          totalTimeoutMs,
        }) => {
          const imeAction: ImeAction | undefined = args.submit ? "done" : undefined;
          let dispatched = false;
          const onDispatch = () => {
            input?.onDispatch?.();
            dispatched = true;
            dispatching?.();
          };
          try {
            return await this.callbacks.runInputOperationWithTimeout(
              {
                toolName: request.method,
                origin: "UnixSocketServer.handleInputTypeText",
                totalTimeoutMs,
                remainingTimeoutMs,
              },
              () =>
                this.callbacks.executeInputTypeText(
                  args.platform,
                  executionTargetDevice,
                  args.text,
                  {
                    imeAction,
                    timeoutMs: remainingTimeoutMs,
                    append: args.append,
                    frameContext: args.frameContext,
                    onConfirmedAppendCharsSent: recordConfirmedAppendCharsSent,
                    signal,
                    dispatching: onDispatch,
                  },
                ),
              (timeoutError) =>
                args.append && confirmedAppendCharsSent !== undefined
                  ? new InputTypeTextAppendError(timeoutError.message, confirmedAppendCharsSent)
                  : undefined,
            );
          } catch (error) {
            if (dispatched && signal?.aborted) {
              throw this.callbacks.indeterminateTextError(
                error,
                signal.reason,
                confirmedAppendCharsSent,
              );
            }
            throw error;
          }
        },
      },
    );
    if (!inputResult.success) {
      if (args.append && inputResult.charsSent !== undefined) {
        throw new InputTypeTextAppendError(
          inputResult.error ?? `input/typeText failed on ${args.platform}`,
          inputResult.charsSent,
        );
      }
      throw new Error(inputResult.error ?? `input/typeText failed on ${args.platform}`);
    }
    return {
      action: "input/typeText",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      textLength: args.text.length,
      submitted: args.submit,
    };
  }
  indeterminateTextError(error: unknown, reason: unknown, confirmedCharsSent?: number): Error {
    const message = `Text input outcome is indeterminate: the request was dispatched but no result was confirmed when cancellation arrived (${errorMessage(reason)}). Do not retry automatically. Observe before retrying.`;
    // A confirmed append prefix remains useful even when submit was cancelled.
    const charsSent =
      confirmedCharsSent ??
      (error instanceof InputTypeTextAppendError ? error.charsSent : undefined);
    const failure =
      charsSent === undefined
        ? new ActionableError(message, { cause: error })
        : new InputTypeTextAppendError(message, charsSent);
    return Object.assign(failure, { requestDispatched: true });
  }
  holdDispatchedInputRequest<T>(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
    { onDispatch, label = "Text input request" }: { onDispatch?: () => void; label?: string } = {},
  ): Promise<T> {
    return holdDispatchedRequest({
      timer: this.state.timer,
      signal,
      timeoutMs,
      label,
      send,
      onDispatch,
    });
  }
  /** Hold only ADB input writes; preserve the executor's other methods and receiver. */
  createSocketInputAdbFactory(optionsForHold: {
    deadline: () => number;
    onDispatch?: () => void;
    label: string;
  }): AdbClientFactory {
    return {
      create: (target, retry) => {
        const adb = defaultAdbClientFactory.create(target, retry);
        return new Proxy(adb, {
          get: (executor, property, receiver) => {
            if (property === "execute") {
              return (
                args: Parameters<typeof adb.execute>[0],
                options: Parameters<typeof adb.execute>[1] = {},
              ) => {
                // Capability probes are reads, not text dispatch. They still cancel immediately.
                if (args[0] !== "shell" || args[1] !== "input") {
                  return adb.execute(args, options);
                }
                return this.callbacks.holdDispatchedInputRequest(
                  options.signal,
                  Math.min(
                    options.timeoutMs ?? Infinity,
                    optionsForHold.deadline() - this.state.timer.now(),
                  ),
                  (fenced, dispatched) =>
                    adb.execute(args, {
                      ...options,
                      signal: fenced,
                      beforeDispatch: async (remaining) => {
                        await options.beforeDispatch?.(remaining);
                        fenced?.throwIfAborted();
                        dispatched();
                      },
                    }),
                  { onDispatch: optionsForHold.onDispatch, label: optionsForHold.label },
                );
              };
            }
            const value = Reflect.get(executor, property, receiver);
            return typeof value === "function" ? value.bind(executor) : value;
          },
        });
      },
    };
  }
  createSocketAppendTextInput(device: BootedDevice): AppendTextInput {
    // InputText checks the original signal between commands. Fence only each ADB
    // execute, so abort cannot release the key early or type the remaining suffix.
    // The executor contract is large; a proxy preserves every existing method and
    // its receiver rather than adding a second generic executor implementation.
    let deadline = 0;
    let onDispatch: (() => void) | undefined;
    const factory = this.callbacks.createSocketInputAdbFactory({
      deadline: () => deadline,
      onDispatch: () => onDispatch?.(),
      label: "Text input request",
    });
    const input = new InputText(device, factory, { timer: this.state.timer });
    return {
      appendText: (text, options = {}) => {
        deadline = this.state.timer.now() + (options.timeoutMs ?? 0);
        // Latch dispatch only after the original validation and final abort check,
        // not inside InputText's earlier asynchronous beforeDispatch callback.
        onDispatch = options.onDispatch;
        return input.appendText(text, {
          timeoutMs: options.timeoutMs,
          beforeKeyEvents: options.beforeKeyEvents,
          signal: options.signal,
        });
      },
    };
  }
  async executeInputTypeText(
    platform: "android" | "ios",
    targetDevice: BootedDevice,
    text: string,
    options: InputTypeTextExecutionOptions,
  ): Promise<{
    success: boolean;
    error?: string;
    charsSent?: number;
  }> {
    const {
      imeAction,
      timeoutMs,
      append = false,
      frameContext,
      onConfirmedAppendCharsSent,
      signal,
      dispatching,
    } = options;
    // Charge set-text and the optional submit/IME action against a single
    // shared budget. Otherwise submit:true would hand each request the full
    // timeout, letting the combined operation run up to 2x the caller's
    // budget while the per-device queue stays held until it settles.
    let dispatched = false;
    const onDispatch = () => {
      if (!dispatched) {
        dispatched = true;
        dispatching?.();
      }
    };
    const deadline = this.state.timer.now() + timeoutMs;
    const target =
      platform === "android"
        ? {
            platform,
            client: AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory),
          }
        : { platform, client: IOSCtrlProxyClient.getInstance(targetDevice) };
    const { client } = target;
    // Append emits real key events on Android. iOS invokes its focused-field insert
    // primitive, falling back on runners that predate that command to untargeted
    // requestSetText, which is the same XCUITest typeText-at-caret operation.
    //
    // The budget is threaded in for the same reason the replace path gets it: this
    // runs while the per-device queue is held, and the outer race only *reports* a
    // timeout — it still waits for the operation to settle before releasing the
    // queue. An unbounded adb subprocess here would therefore wedge every later
    // input for this device, not just this one request.
    let appendCharsSent: number | undefined;
    if (append && target.platform === "android") {
      const textResult = await this.callbacks.executeAndroidAppendText({
        targetDevice,
        text,
        deadline,
        totalTimeoutMs: timeoutMs,
        frameContext,
        client: target.client,
        signal,
        onDispatch,
      });
      if (textResult.charsSent !== undefined) {
        onConfirmedAppendCharsSent?.(textResult.charsSent);
      }
      assertSocketInputNotAborted(signal);
      if (!textResult.success) {
        return {
          success: false,
          error: textResult.error,
          ...(textResult.charsSent !== undefined ? { charsSent: textResult.charsSent } : {}),
        };
      }
      appendCharsSent = textResult.charsSent;
    } else {
      // Outside the Android append branch, an append request is an iOS one.
      const iosAppendClient = append && target.platform === "ios" ? target.client : null;
      const textResult = await this.callbacks.holdDispatchedInputRequest(
        signal,
        deadline - this.state.timer.now(),
        (fenced, dispatched) =>
          iosAppendClient
            ? iosAppendClient.requestAppendText(text, timeoutMs, undefined, frameContext, {
                abortSignal: fenced,
                onDispatch: dispatched,
              })
            : client.requestSetText(text, {
                timeoutMs,
                frameContext,
                abortSignal: fenced,
                onDispatch: dispatched,
              }),
        { onDispatch },
      );
      assertSocketInputNotAborted(signal);
      if (!textResult.success) {
        return { success: false, error: textResult.error };
      }
    }
    return await this.callbacks.runImeActionWithinBudget(client, imeAction, deadline, {
      totalTimeoutMs: timeoutMs,
      appendCharsSent,
      signal,
      onDispatch,
    });
  }
  async executeAndroidAppendText(options: AndroidAppendTextOptions): Promise<{
    success: boolean;
    error?: string;
    charsSent?: number;
  }> {
    const {
      targetDevice,
      text,
      deadline,
      totalTimeoutMs,
      frameContext,
      client,
      signal,
      onDispatch,
    } = options;
    const appendTimeoutMs = deadline - this.state.timer.now();
    if (appendTimeoutMs <= 0) {
      return {
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before append key events`,
      };
    }
    const beforeKeyEvent =
      frameContext === undefined
        ? undefined
        : () =>
            this.callbacks.validateAppendFrameContext(
              client,
              frameContext,
              deadline,
              totalTimeoutMs,
            );
    const cached = this.callbacks.getAppendTextInput(targetDevice);
    const run = async (
      input: AppendTextInput,
      pending: string,
      timeoutMs: number,
      validate: typeof beforeKeyEvent,
    ) =>
      await input.appendText(pending, {
        timeoutMs,
        beforeKeyEvents: validate,
        signal,
        onDispatch,
      });
    const result = await run(cached.input, text, appendTimeoutMs, beforeKeyEvent);
    if (
      result.success ||
      !cached.fromCache ||
      signal?.aborted ||
      // A verdict from the RUNNER is not evidence about the helper. The helper
      // worked; the device-side answer was "no" (a stale `frameContext`, say).
      // Rebuilding and replaying would type the whole string into a UI the
      // runner explicitly refused, so the verdict is surfaced exactly as it came
      // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
      result.failureSource === "runner"
    ) {
      return result;
    }
    return await this.callbacks.retryAppendTextWithRebuiltHelper(targetDevice, text, result, {
      deadline,
      beforeKeyEvent,
      run,
    });
  }
  /**
   * Self-heal, for HELPER failures only: without an ADB transport id there is
   * nothing that proves a cached helper still belongs to the device now on this
   * serial, and a restart faster than one discovery interval leaves the pool
   * incarnation unchanged. A helper failure is the first evidence either way, so
   * drop the helper and give a freshly built one exactly one attempt before
   * surfacing the error. A RUNNER verdict never reaches here.
   */
  async retryAppendTextWithRebuiltHelper(
    targetDevice: BootedDevice,
    text: string,
    result: AppendTextAttemptResult,
    retryWith: AppendTextRetry,
  ): Promise<{
    success: boolean;
    error?: string;
    charsSent?: number;
  }> {
    const { deadline, beforeKeyEvent, run } = retryWith;
    // The retry resumes from the UNCONFIRMED SUFFIX only. `charsSent` is the
    // exact prefix the failed helper landed on the device, so replaying the whole
    // string would duplicate it ("AB" after "A" becomes "AAB", issue #3351). An
    // ABSENT `charsSent` means the helper cannot say whether its in-flight key
    // event landed (an adb timeout kills the host child, not Android's handling
    // of the event), which makes every replay unsafe: surface the failure.
    const confirmed = result.charsSent;
    if (confirmed === undefined) {
      return result;
    }
    const pending = text.slice(confirmed);
    if (pending.length === 0) {
      return result;
    }
    this.callbacks.evictDeviceInputCache(targetDevice.deviceId);
    const retryTimeoutMs = deadline - this.state.timer.now();
    if (retryTimeoutMs <= 0) {
      return result;
    }
    // The validator travels with the retry only when NOTHING was confirmed:
    // there, no key event landed, the original validation was never spent, and
    // the rebuilt helper is starting the same append over. Once a prefix IS
    // confirmed this is a RESUME of the same logical append -- the original call
    // already validated `frameContext` before its first key event, and the
    // confirmed prefix has since emitted TYPE_VIEW_TEXT_CHANGED, which advances
    // the runner's frame epoch, so re-validating would reject a suffix that is
    // safe to type ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    const retry = await run(
      this.callbacks.getAppendTextInput(targetDevice).input,
      pending,
      retryTimeoutMs,
      confirmed === 0 ? beforeKeyEvent : undefined,
    );
    // Progress accumulates across both helpers so the caller's retry boundary
    // stays an index into the ORIGINAL text; an ambiguous retry poisons the
    // whole count, so it reports no boundary at all.
    return retry.charsSent === undefined
      ? { success: retry.success, ...(retry.error !== undefined ? { error: retry.error } : {}) }
      : { ...retry, charsSent: confirmed + retry.charsSent };
  }
  async validateAppendFrameContext(
    client: Pick<AndroidCtrlProxy, "validateFrameContext">,
    frameContext: string,
    deadline: number,
    totalTimeoutMs: number,
  ): Promise<{
    success: boolean;
    error?: string;
    failureSource?: AppendTextFailureSource;
  }> {
    const validationTimeoutMs = deadline - this.state.timer.now();
    if (validationTimeoutMs <= 0) {
      return {
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before append frame context validation`,
      };
    }
    const validation = await client.validateFrameContext(frameContext, validationTimeoutMs);
    return validation.success
      ? { success: true }
      : {
          success: false,
          error:
            validation.error ??
            "Frame context is stale or unavailable; observe a fresh frame before retrying",
          // The runner answered, and the answer is "no". That is a verdict about
          // the DEVICE, so the caller must not treat it as a stale helper and
          // replay the text through a rebuilt one (#6863 review).
          failureSource: "runner",
        };
  }
  async runImeActionWithinBudget(
    client: Pick<AndroidCtrlProxyClient | IOSCtrlProxyClient, "requestImeAction">,
    imeAction: ImeAction | undefined,
    deadline: number,
    options: {
      totalTimeoutMs: number;
      appendCharsSent?: number;
      signal?: AbortSignal;
      onDispatch?: () => void;
    },
  ): Promise<{
    success: boolean;
    error?: string;
    charsSent?: number;
  }> {
    const { totalTimeoutMs, appendCharsSent, signal, onDispatch } = options;
    const withAppendProgress = (result: { success: boolean; error?: string }) =>
      appendCharsSent !== undefined ? { ...result, charsSent: appendCharsSent } : result;
    if (!imeAction) {
      return withAppendProgress({ success: true });
    }
    assertSocketInputNotAborted(signal);
    const remainingTimeoutMs = deadline - this.state.timer.now();
    if (remainingTimeoutMs <= 0) {
      // Defensive: in practice the outer deadline race fires first, so
      // this path is only reached if set-text spends the entire budget before
      // the submit action starts.
      return withAppendProgress({
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before submit`,
      });
    }
    try {
      const result = await this.callbacks.holdDispatchedInputRequest(
        signal,
        remainingTimeoutMs,
        (fenced, dispatched) =>
          client.requestImeAction(imeAction, remainingTimeoutMs, undefined, fenced, dispatched),
        { onDispatch },
      );
      assertSocketInputNotAborted(signal);
      if (!result.success) {
        const message = imeActionFailedAfterTextEntered(imeAction, result.error || "unknown error");
        logger.warn(`[input/typeText] ${message}`);
        return withAppendProgress({ ...result, error: message });
      }
      return withAppendProgress(result);
    } catch (error) {
      const message = imeActionFailedAfterTextEntered(
        imeAction,
        errorMessage(error) || "unknown error",
      );
      logger.warn(`[input/typeText] ${message}`, error);
      if (signal?.aborted) {
        // Cancellation reasons are shared with the owner; preserve them untouched.
        throw error;
      }
      if (appendCharsSent === undefined) {
        // Preserve runner error identity, class, and structured failure metadata.
        if (error instanceof Error) {
          error.message = message;
          throw error;
        }
        throw new ActionableError(message, { cause: error });
      }
      return {
        success: false,
        error: message,
        charsSent: appendCharsSent,
      };
    }
  }
  async runInputOperationWithTimeout<T>(
    budget: InputOperationBudget,
    operation: () => Promise<T>,
    timeoutError?: (timeout: McpTimeoutError) => Error | undefined,
  ): Promise<T> {
    const { toolName, origin, totalTimeoutMs, remainingTimeoutMs } = budget;
    let timedOut = false;
    const operationPromise = operation();
    try {
      return await raceWithDeadline(operationPromise, {
        timer: this.state.timer,
        timeoutMs: remainingTimeoutMs,
        label: "Input operation",
        timeoutError: () => {
          timedOut = true;
          const error = new McpTimeoutError({
            toolName,
            timeoutMs: totalTimeoutMs,
            origin,
            detail: `operation exceeded remaining budget ${remainingTimeoutMs}ms`,
          });
          return timeoutError?.(error) ?? error;
        },
      });
    } finally {
      if (timedOut) {
        // Hold the per-device queue until the in-flight CtrlProxy request
        // settles so a following same-device input cannot interleave its text
        // write with this one. This defers delivery of the timeout error until
        // the operation ends; the wait normally tracks the caller's budget
        // (executeInputTypeText bounds set-text + IME to it) but can exceed it
        // if a CtrlProxy request ignores its own timeout or blocks in an
        // unbounded connect phase. This serialization-over-responsiveness
        // trade-off matches input/tap and input/swipe.
        await operationPromise.catch(() => undefined);
      }
    }
  }
  parseInputTapParams(params: unknown): InputTapParams {
    return parseInputTapParams(params);
  }
  parseInputSwipeParams(params: unknown): InputSwipeParams {
    return parseInputSwipeParams(params);
  }
  parseInputTypeTextParams(params: unknown): InputTypeTextParams {
    return parseInputTypeTextParams(params);
  }
  parseInputPressButtonParams(params: unknown): InputPressButtonParams {
    return parseInputPressButtonParams(params);
  }
  parseInputKeyParams(params: unknown): InputKeyParams {
    return parseInputKeyParams(params);
  }
  parseInputGestureParams(params: unknown, method: string): InputGestureParams {
    return parseInputGestureParams(params, method);
  }
  /**
   * Drop the cached append helper after a device lifecycle change (issue #3351).
   *
   * The cache is keyed by deviceId and otherwise lives until the 5-minute idle
   * close. If an emulator is replaced under a reused serial (`emulator-5554`)
   * before then, the next device would inherit the previous one's cached API-level
   * capability — an API 31+ / pre-31 mismatch that mis-handles SHIFT and uppercase.
   * The device pool calls this after it adds a device, rediscovers it during a
   * refresh, or binds it after startDevice. Direct socket discovery also rebuilds
   * a helper when ADB reports a changed transport id for the same serial. The
   * confirmed-disconnect monitor remains a backstop.
   * Idempotent; safe for an unknown id.
   */
  evictDeviceInputCache(deviceId: string): void {
    if (this.state.appendTextInputs.delete(deviceId)) {
      logger.debug(`[UnixSocketServer] Evicted cached append helper for device ${deviceId}`);
    }
  }
  /**
   * Cached-per-device accessor for the append helper; see
   * {@link appendTextInputs}. Keyed on the pool's connection epoch so a
   * same-serial reincarnation cannot inherit the previous device's probed API
   * level. `fromCache` tells the caller whether a failure is worth retrying
   * against a freshly built helper.
   */
  getAppendTextInput(device: BootedDevice): {
    input: AppendTextInput;
    fromCache: boolean;
  } {
    const incarnationToken = deviceIncarnationToken(device.deviceId);
    const existing = this.state.appendTextInputs.get(device.deviceId);
    if (existing && existing.incarnationToken === incarnationToken) {
      return { input: existing.input, fromCache: true };
    }
    if (existing) {
      logger.debug(
        `[UnixSocketServer] Rebuilding cached append helper for ${device.deviceId}: ` +
          `pool incarnation changed from ${existing.incarnationToken} to ${incarnationToken}`,
      );
    }
    const created = this.state.appendTextFactory(device);
    this.state.appendTextInputs.set(device.deviceId, { input: created, incarnationToken });
    return { input: created, fromCache: false };
  }
}
