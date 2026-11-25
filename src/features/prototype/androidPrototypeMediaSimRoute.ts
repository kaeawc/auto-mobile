import type { AndroidPrototypeTransport } from "./androidPrototypeTransport";
import type { PrototypeMediaSimRoute } from "./prototypeMediaSimulate";

/** Advertised by a CtrlProxy whose prototypes can register the `media` platform module. */
export const PROTOTYPE_PLATFORM_MEDIA_CAPABILITY = "prototype_platform_media_v1";

/**
 * Routes `prototype simulate` media events to Android CtrlProxy (#14257). The only Android media
 * module is the debug fake player, so a device that advertises the capability runs the fake engine;
 * a release CtrlProxy advertises none and the simulation is refused as unavailable.
 */
export function androidPrototypeMediaSimRoute(
  android: Pick<AndroidPrototypeTransport, "supportsCommand" | "simulatePlatformEvent">,
): PrototypeMediaSimRoute {
  return {
    async engine() {
      return (await android.supportsCommand(PROTOTYPE_PLATFORM_MEDIA_CAPABILITY))
        ? "fake"
        : undefined;
    },
    async deliver(id, request, timeoutMs) {
      const { event, ...data } = request;
      const reply = await android.simulatePlatformEvent(id, event, { ...data }, timeoutMs);
      if (reply.success && !reply.error) {
        return { success: true };
      }
      // CtrlProxy refuses an unknown player or status without the engine's code.
      return { success: false, ...(reply.error ? { error: reply.error } : {}) };
    },
  };
}
