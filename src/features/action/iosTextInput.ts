import {
  explainIosIndeterminateText,
  readIosTypedTextField,
  verifyIosTypedText,
} from "./iosTypedTextVerification";
import type { IosTypedTextObserver } from "./iosTypedTextVerification";
import { resolveTextCtrlProxyTimeoutMs, getTextRequestDeadlineMs } from "./textTransportTimeout";
import { errorMessage } from "../../utils/describeUnknownError";
import { imeActionFailedAfterTextEntered } from "./imeActionFailedAfterTextEntered";
import { assertInputNotAborted } from "./assertInputNotAborted";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient } from "../observe/ios";
import type { Timer } from "../../utils/SystemTimer";
import type { BootedDevice, ImeAction, SendTextResult } from "../../models";

export interface IosTextInputDeps {
  device: BootedDevice;
  observeScreen: IosTypedTextObserver;
  timer: Timer;
}

async function executeIosImeAfterType(
  client: Pick<IOSCtrlProxyClient, "requestImeAction">,
  imeAction?: ImeAction,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!imeAction) {
    return undefined;
  }
  let imeError: string | undefined;
  try {
    const imeResult = await client.requestImeAction(imeAction);
    assertInputNotAborted(signal);
    if (!imeResult.success) {
      imeError = imeResult.error || "unknown error";
    }
  } catch (error) {
    assertInputNotAborted(signal);
    imeError = errorMessage(error) || "unknown error";
  }
  if (imeError === undefined) {
    return undefined;
  }
  logger.warn(`[InputText] CtrlProxy iOS IME action '${imeAction}' failed: ${imeError}`);
  return imeActionFailedAfterTextEntered(imeAction, imeError);
}

/**
 * Execute iOS-specific text input through the CtrlProxy setText transport.
 */
export async function executeIosTextInput(
  { device, observeScreen, timer }: IosTextInputDeps,
  text: string,
  imeAction?: ImeAction,
  signal?: AbortSignal,
): Promise<SendTextResult & { method?: "a11y"; retryable?: false }> {
  assertInputNotAborted(signal);
  const startMs = Date.now();
  logger.debug(`[InputText] iOS begin textLength=${text.length} imeAction=${imeAction ?? "none"}`);

  const client = IOSCtrlProxyClient.getInstance(device);
  const before = await readIosTypedTextField(observeScreen, timer, signal);
  assertInputNotAborted(signal);
  const deadlineMs = getTextRequestDeadlineMs();
  const result = await client.requestSetText(text, {
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    timeoutMs: resolveTextCtrlProxyTimeoutMs(
      text,
      deadlineMs === undefined ? undefined : deadlineMs - timer.now(),
    ),
    abortSignal: signal,
  });
  if (!result.success) {
    assertInputNotAborted(signal, result);
    logger.error(
      `[InputText] CtrlProxy iOS setText failed: ${result.error} totalMs=${Date.now() - startMs}`,
    );
    return {
      success: false,
      text,
      error: await explainIosIndeterminateText(result.error, text, before, {
        observer: observeScreen,
        timer,
        signal,
      }),
      ...(result.retryable === false ? { retryable: false as const } : {}),
      method: "a11y",
    };
  }

  logger.debug(`[InputText] iOS setText ok totalMs=${Date.now() - startMs}`);

  const verification = await verifyIosTypedText(text, before, observeScreen, timer, signal);
  if (!verification.success) {
    return { success: false, text, error: verification.error, method: "a11y" };
  }

  const imeError = await executeIosImeAfterType(client, imeAction, signal);
  if (imeError !== undefined) {
    return { success: false, text, method: "a11y", error: imeError };
  }

  return {
    success: true,
    text,
    imeAction,
    method: "a11y",
    ...(verification.warning ? { warnings: [verification.warning] } : {}),
  };
}
