import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

/**
 * Why a device's adb transport is believed to be back. `transport_refusal`: a command that adb
 * refused with a missing/offline device later succeeded. `adb_reconnect`: an `adb -s <serial>
 * reconnect` recovery was dispatched successfully (the device may still be coming back).
 * `ctrl_proxy_reconnect`: the CtrlProxy websocket, which rides an adb forward, (re)connected.
 */
export type AdbTransportRecoveryReason =
  | "transport_refusal"
  | "adb_reconnect"
  | "ctrl_proxy_reconnect";

export type AdbTransportRecoveredListener = (
  deviceId: string,
  reason: AdbTransportRecoveryReason,
) => void;

/**
 * Process-local fanout for "this device's adb transport recovered". Device-scoped state that adb
 * drops with the transport (e.g. `adb reverse` mappings, #17168) subscribes to re-apply itself.
 * Listeners must not block: they schedule their own work.
 */
export class AdbTransportRecoveredSignal {
  private readonly listeners = new Set<AdbTransportRecoveredListener>();

  subscribe(listener: AdbTransportRecoveredListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(deviceId: string, reason: AdbTransportRecoveryReason): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(deviceId, reason);
      } catch (error) {
        // A failed consumer must not fail the adb command or recovery that reported the event.
        logger.warn(
          `[adbTransportRecovered] listener failed for ${deviceId} (${reason}): ${errorMessage(error)}`,
          error,
        );
      }
    }
  }
}

/** The process's one signal: AdbClient, offline recovery and CtrlProxy report into it. */
export const adbTransportRecoveredSignal = new AdbTransportRecoveredSignal();

/** Reports a recovered transport on the process signal; a client with no device reports nothing. */
export function notifyAdbTransportRecovered(
  deviceId: string | undefined,
  reason: AdbTransportRecoveryReason,
): void {
  if (deviceId !== undefined) {
    adbTransportRecoveredSignal.notify(deviceId, reason);
  }
}
