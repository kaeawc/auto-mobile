import type { BootedDevice, Element } from "../../models";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient, type CtrlProxyActionResult } from "../observe/ios";
import type { DisplayFenceOption } from "./BaseVisualChange";
import { indeterminateTapError } from "./coordinateTapDispatch";
import { resolveVoiceOverActivateCtrlProxyTimeoutMs } from "./gestureTransportTimeout";

/** iOS VoiceOver tap activation, extracted from TapOnElement (#11833). */

type IosTapOptions = DisplayFenceOption & { signal?: AbortSignal };

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
    await coordinateTap({ displayFence: fence, signal });
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
    await coordinateTap({ displayFence: fence, signal });
  }
}

function confirmVoiceOverActivation(device: BootedDevice, result: CtrlProxyActionResult): void {
  if (result.dispatched && result.acknowledged !== true) {
    throw indeterminateTapError(result.error);
  }
  invalidateIosCacheOnSuccess(device, result);
}
