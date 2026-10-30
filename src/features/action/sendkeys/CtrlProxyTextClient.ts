import { resolveTextCtrlProxyTimeoutMs, getTextRequestDeadlineMs } from "../textTransportTimeout";
import type { BootedDevice } from "../../../models";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../../observe/android";
import { imeCommitUnitFields } from "../../observe/android/CtrlProxyText";
import { IOSCtrlProxyClient } from "../../observe/ios";
import { withImeActionApproximationWarning } from "../imeActionApproximationWarning";
import type { SendKeysTextClient } from "../SendKeys";

export function createSendKeysTextClient(
  device: BootedDevice,
  adbFactory: AdbClientFactory,
): SendKeysTextClient {
  if (device.platform === "android") {
    const client = AndroidCtrlProxyClient.getInstance(device, adbFactory);
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
        withImeActionApproximationWarning(
          await client.requestImeAction(action, 5000, undefined, signal, onDispatch),
        ),
      supportsImeCommit: async () =>
        (await client.supportsCommand("request_commit_text")) &&
        (await client.supportsCommand("request_cancel_ime_commit")),
      supportsImeKeyEvents: async () => client.supportsCommand("ime_key_events_v1"),
      supportsImeClearField: async () => client.supportsCommand("ime_clear_field_v1"),
      supportsImePasswordCommit: async () => client.supportsCommand("ime_password_commit_v1"),
      supportsImeInsertedText: async () => client.supportsCommand("ime_inserted_text_v1"),
      supportsImeTrace: async () => client.supportsCommand("ime_commit_trace_v1"),
      supportsKeyboardProfiles: async () => client.supportsCommand("request_set_keyboard_profile"),
      setKeyboardProfile: async (id) => client.setKeyboardProfile(id),
      commitViaIme: async (text, priorImeId, signal, delivery, trace) => {
        const result = await client.commitViaIme(
          text,
          priorImeId ?? undefined,
          undefined,
          undefined,
          { signal, delivery, trace },
        );
        return {
          success: result.success,
          ...(result.error ? { error: result.error } : {}),
          ...(result.partialApplication ? { partialApplication: true } : {}),
          ...(result.sessionUnsafe ? { sessionUnsafe: true } : {}),
          ...(result.transportFailure ? { imeFailureStage: "transport" as const } : {}),
          ...imeCommitUnitFields(result),
          ...(result.insertedText !== undefined ? { insertedText: result.insertedText } : {}),
          ...(result.editorConsumed === true ? { editorConsumed: true } : {}),
          ...(result.trace !== undefined ? { imeTrace: result.trace } : {}),
        };
      },
    };
  }

  const client = IOSCtrlProxyClient.getInstance(device);
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
    clear: async (signal) => {
      const deadlineMs = getTextRequestDeadlineMs();
      return client.requestClearText(undefined, 5000, undefined, {
        abortSignal: signal,
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
      });
    },
    ime: async (action, signal, onDispatch) =>
      client.requestImeAction(action, 5000, undefined, signal, onDispatch),
    supportsImeCommit: async () => false,
    supportsImeKeyEvents: async () => false,
    supportsImeClearField: async () => false,
    supportsImePasswordCommit: async () => false,
    supportsImeInsertedText: async () => false,
    supportsKeyboardProfiles: async () => false,
    setKeyboardProfile: async () => ({
      success: false,
      error: "Keyboard profiles are Android-only",
    }),
    commitViaIme: async () => ({ success: false, error: "IME commit is Android-only" }),
  };
}
