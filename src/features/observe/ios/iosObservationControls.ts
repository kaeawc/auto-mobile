import { logger } from "../../../utils/logger";
import { serializeIosRequest } from "./serializeIosRequest";
import type { XCTestHierarchy } from "./types";
interface IosObservationControlsContext {
  onPushUpdateCallbacks: Set<(hierarchy: XCTestHierarchy) => void>;
  isCommandSupported: (messageType: string) => boolean;
  sendMessage: (message: string) => boolean;
}

export function notifyPushUpdateListeners(
  context: Pick<IosObservationControlsContext, "onPushUpdateCallbacks">,
  hierarchy: XCTestHierarchy,
): void {
  for (const callback of context.onPushUpdateCallbacks) {
    try {
      callback(hierarchy);
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Push update callback error: ${error}`);
    }
  }
}

export function refreshObservationStreamHierarchyCadence(
  context: Pick<IosObservationControlsContext, "isCommandSupported" | "sendMessage">,
  intervalMs: number,
): void {
  if (!context.isCommandSupported("set_hierarchy_poll_interval")) {
    logger.info(
      "[IOSCtrlProxyClient] Skipping hierarchy cadence sync; runner does not advertise set_hierarchy_poll_interval",
    );
    return;
  }

  context.sendMessage(
    serializeIosRequest({
      type: "set_hierarchy_poll_interval",
      intervalMs,
    }),
  );
}
