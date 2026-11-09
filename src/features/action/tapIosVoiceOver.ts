import type { BootedDevice, Element } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { IOSCtrlProxyClient, type CtrlProxyActionResult } from "../observe/ios";
import type { DisplayFenceOption } from "./BaseVisualChange";
import { IndeterminateTapError, indeterminateTapError } from "./coordinateTapDispatch";
import { isRunnerGestureOutcomeUnknown } from "../observe/ios/runnerErrorCodes";
import { resolveVoiceOverActivateCtrlProxyTimeoutMs } from "./gestureTransportTimeout";

/** iOS VoiceOver tap activation, extracted from TapOnElement (#11833). */

type IosTapOptions = DisplayFenceOption & { signal?: AbortSignal };

/**
 * A tap timeout while VoiceOver is on. Still an `IndeterminateTapError`: the tap may have run, so
 * callers keep the no-retry contract; the message adds the VoiceOver remedy.
 */
export class VoiceOverTapTimeoutError extends IndeterminateTapError {}

function isIndeterminateTapTimeout(error: unknown): error is IndeterminateTapError {
  return (
    error instanceof IndeterminateTapError &&
    !(error instanceof VoiceOverTapTimeoutError) &&
    (/timed out|timeout/i.test(error.message) ||
      isRunnerGestureOutcomeUnknown({ error: error.message }))
  );
}

function voiceOverTapTimeoutError(error: IndeterminateTapError): VoiceOverTapTimeoutError {
  return new VoiceOverTapTimeoutError(
    `${error.message} With VoiceOver on, synthetic touches and activation requests can be held ` +
      "or swallowed, so the tap may not have run. Verify with observe; turn VoiceOver off " +
      "using the accessibility tool ({voiceover:false}), then retry if needed.",
    { cause: error },
  );
}

/** Add VoiceOver recovery guidance without losing the no-retry indeterminate contract. */
export async function withVoiceOverTimeoutContext(
  coordinateTap: () => Promise<void>,
): Promise<void> {
  try {
    await coordinateTap();
  } catch (error) {
    if (isIndeterminateTapTimeout(error)) {
      throw voiceOverTapTimeoutError(error);
    }
    throw error;
  }
}

/**
 * Like {@link withVoiceOverTimeoutContext} for a tap that did not probe VoiceOver up
 * front: only a timeout pays for the probe, and only a confirmed-on state adds the guidance.
 */
export async function withVoiceOverTimeoutContextIfOn(
  tap: () => Promise<void>,
  isVoiceOverOn: () => Promise<boolean>,
): Promise<void> {
  try {
    await tap();
  } catch (error) {
    if (isIndeterminateTapTimeout(error) && (await probeVoiceOverAfterTimeout(isVoiceOverOn))) {
      throw voiceOverTapTimeoutError(error);
    }
    throw error;
  }
}

async function probeVoiceOverAfterTimeout(isVoiceOverOn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await isVoiceOverOn();
  } catch (error) {
    // The tap's own timeout is the error the caller needs; an unreadable state adds nothing.
    logger.warn(`VoiceOver probe after a tap timeout failed: ${errorMessage(error)}`, error);
    return false;
  }
}

/** Drop the cached iOS hierarchy once an action succeeded, so the next read is fresh. */
export function invalidateIosCacheOnSuccess(
  device: BootedDevice,
  result: { success: boolean },
): void {
  if (result.success) {
    IOSCtrlProxyClient.getExistingInstance(device.deviceId)?.invalidateCache();
  }
}

/**
 * Execute an iOS tap through a VoiceOver accessibility action. Falls back to `coordinateTap`
 * when no label is resolvable or the activation is confirmed not performed.
 */
export async function tapViaVoiceOver({
  device,
  action,
  element,
  point,
  durationMs,
  fenceOptions,
  coordinateTap,
}: {
  device: BootedDevice;
  action: string;
  element: Element;
  point: { x: number; y: number };
  durationMs: number;
  fenceOptions: IosTapOptions;
  coordinateTap: (options: IosTapOptions) => Promise<void>;
}): Promise<void> {
  const { displayFence: fence, signal } = fenceOptions;
  // Resolve accessibility label: ios-accessibility-label > content-desc > text > fallback
  const label =
    (element["ios-accessibility-label"] as string | undefined) ??
    (typeof element["content-desc"] === "string" && element["content-desc"]
      ? element["content-desc"]
      : undefined) ??
    (typeof element.text === "string" && element.text ? element.text : undefined);

  if (!label) {
    logger.info("[TapOnElement] VoiceOver: no label available, falling back to coordinate tap");
    await withVoiceOverTimeoutContext(() => coordinateTap({ displayFence: fence, signal }));
    return;
  }

  const voiceOverAction: "activate" | "long_press" =
    action === "longPress" ? "long_press" : "activate";

  const client = IOSCtrlProxyClient.getInstance(device);
  const result = await client.requestVoiceOverActivate(
    label,
    voiceOverAction,
    resolveVoiceOverActivateCtrlProxyTimeoutMs(voiceOverAction, durationMs),
    {
      bounds: element.bounds,
      duration: action === "longPress" ? durationMs : undefined,
    },
  );

  confirmVoiceOverActivation(device, result);

  if (!result.success) {
    logger.warn(
      `[TapOnElement] VoiceOver action failed for label "${label}": ${result.error ?? "unknown error"}, ` +
        `falling back to coordinate tap at (${point.x}, ${point.y})`,
    );
    await withVoiceOverTimeoutContext(() => coordinateTap({ displayFence: fence, signal }));
  }
}

function confirmVoiceOverActivation(device: BootedDevice, result: CtrlProxyActionResult): void {
  if (result.dispatched && result.acknowledged !== true) {
    throw indeterminateTapError(result.error);
  }
  invalidateIosCacheOnSuccess(device, result);
}
