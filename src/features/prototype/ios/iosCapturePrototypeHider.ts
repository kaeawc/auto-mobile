/**
 * Resolves the iOS prototype agent that can hide itself around a host screenshot (#9305).
 *
 * Observe asks the same question twice: before capturing, whether to request the hide at all, and
 * during the capture, to wrap it. Both read the live agent connection, so an agent that went away
 * in between is noticed by the capture instead of silently shown in the image.
 */
import {
  IosPrototypeTransport,
  SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
} from "./iosPrototypeTransport";
import type { PrototypeAgentConnections } from "./iosPrototypeTransport";
import { prototypeAgentRegistry } from "./prototypeAgentInjection";

/** The part of the prototype transport a screenshot capture needs. */
export type IosCapturePrototypeHider = Pick<
  IosPrototypeTransport,
  "supportsCapability" | "captureWithPrototypeHidden"
>;

/** The hider for a device's connected agent, or undefined when none is connected. */
export type IosCapturePrototypeHiderResolver = (
  deviceId: string,
) => IosCapturePrototypeHider | undefined;

export function prototypeHiderFromConnections(
  connections: PrototypeAgentConnections,
): IosCapturePrototypeHiderResolver {
  return (deviceId) => {
    const agent = connections.get(deviceId);
    return agent === undefined ? undefined : new IosPrototypeTransport(agent);
  };
}

export const defaultIosCapturePrototypeHider: IosCapturePrototypeHiderResolver =
  prototypeHiderFromConnections(prototypeAgentRegistry);

/** Whether the device has a connected agent advertising `screenshot_hide_prototype_v1`. */
export function iosAgentHidesPrototypeForCapture(
  deviceId: string,
  resolve: IosCapturePrototypeHiderResolver = defaultIosCapturePrototypeHider,
): boolean {
  return resolve(deviceId)?.supportsCapability(SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY) === true;
}
