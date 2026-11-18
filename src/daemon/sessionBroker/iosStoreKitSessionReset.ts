import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { iosCtrlProxyClientFor } from "../../features/observe/ios/iosCtrlProxyClientFor";
import type { StoreKitSender } from "../../features/storekit/StoreKitTest";
import {
  isStoreKitSessionAbsentError,
  type IosStoreKitSessionReset,
} from "./mutations/storeKitSession";

/** Bounds one clear so a wedged runner fails the step and keep-booted reset escalates. */
export const STOREKIT_RESET_TIMEOUT_MS = 10_000;

/**
 * Ends a bundle's StoreKit test session through the runner's `clear` action, which resets the
 * session to its default state, clears its transactions and drops it. A runner that has no session
 * for the bundle id (cleared already, or a runner restarted since) is already clean. Any other
 * outcome (no connection, an outdated runner, a timeout) cannot prove the session is gone, so it
 * throws and the keep-booted reset falls back to erasing the simulator.
 */
export class RunnerStoreKitSessionReset implements IosStoreKitSessionReset {
  constructor(
    private readonly senderFor: (device: BootedDevice) => StoreKitSender = iosCtrlProxyClientFor,
  ) {}

  async clear(deviceId: string, bundleId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const result = await this.senderFor({
      name: deviceId,
      platform: "ios",
      deviceId,
    }).requestStoreKit(
      { action: "clear", bundleId },
      { signal, timeoutMs: STOREKIT_RESET_TIMEOUT_MS },
    );
    signal.throwIfAborted();
    if (result.success || isStoreKitSessionAbsentError(result.error)) {
      return;
    }
    throw new ActionableError(
      `iOS StoreKit test session for ${bundleId} could not be cleared: ${result.error ?? "unknown runner failure"}`,
    );
  }
}
