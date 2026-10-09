/**
 * Resolves the iOS overlay agent that can hide itself around a host screenshot (#9305).
 *
 * Observe asks the same question twice: before capturing, whether to request the hide at all, and
 * during the capture, to wrap it. Both read the live agent connection, so an agent that went away
 * in between is noticed by the capture instead of silently shown in the image.
 */
import { IosOverlayTransport, SCREENSHOT_HIDE_OVERLAY_CAPABILITY } from "./iosOverlayTransport";
import type { OverlayAgentConnections } from "./iosOverlayTransport";
import { overlayAgentRegistry } from "./overlayAgentInjection";

/** The part of the overlay transport a screenshot capture needs. */
export type IosCaptureOverlayHider = Pick<
  IosOverlayTransport,
  "supportsCapability" | "captureWithOverlayHidden"
>;

/** The hider for a device's connected agent, or undefined when none is connected. */
export type IosCaptureOverlayHiderResolver = (
  deviceId: string,
) => IosCaptureOverlayHider | undefined;

export function overlayHiderFromConnections(
  connections: OverlayAgentConnections,
): IosCaptureOverlayHiderResolver {
  return (deviceId) => {
    const agent = connections.get(deviceId);
    return agent === undefined ? undefined : new IosOverlayTransport(agent);
  };
}

export const defaultIosCaptureOverlayHider: IosCaptureOverlayHiderResolver =
  overlayHiderFromConnections(overlayAgentRegistry);

/** Whether the device has a connected agent advertising `screenshot_hide_overlay_v1`. */
export function iosAgentHidesOverlayForCapture(
  deviceId: string,
  resolve: IosCaptureOverlayHiderResolver = defaultIosCaptureOverlayHider,
): boolean {
  return resolve(deviceId)?.supportsCapability(SCREENSHOT_HIDE_OVERLAY_CAPABILITY) === true;
}
