import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { iosCtrlProxyClientFor } from "../../features/observe/ios/iosCtrlProxyClientFor";
import type { StoreKitSender } from "../../features/storekit/StoreKitTest";
import {
  defaultStoreKitClearedSessions,
  type StoreKitClearedSessions,
} from "../../features/storekit/StoreKitClearedSessions";
import {
  isStoreKitSessionAbsentError,
  type IosStoreKitSessionReset,
} from "./mutations/storeKitSession";

/** Bounds one clear so a wedged runner fails the step and keep-booted reset escalates. */
export const STOREKIT_RESET_TIMEOUT_MS = 10_000;

/**
 * Ends a bundle's StoreKit test session through the runner's `clear` action, which resets the
 * session to its default state, clears its transactions and drops it. A runner with no session for
 * the bundle id is clean only when this daemon saw a confirmed clear with no state-changing action
 * since; otherwise the runner may have restarted while the simulator keeps the StoreKit state
 * (#18574). That case, and any other outcome (no connection, an outdated runner, a timeout),
 * cannot prove the state is gone, so it throws and the keep-booted reset erases the simulator.
 */
export class RunnerStoreKitSessionReset implements IosStoreKitSessionReset {
  constructor(
    private readonly senderFor: (device: BootedDevice) => StoreKitSender = iosCtrlProxyClientFor,
    private readonly clearedSessions: StoreKitClearedSessions = defaultStoreKitClearedSessions,
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
    if (result.success) {
      this.clearedSessions.markCleared(deviceId, bundleId);
      return;
    }
    if (
      isStoreKitSessionAbsentError(result.error) &&
      this.clearedSessions.isCleared(deviceId, bundleId)
    ) {
      return;
    }
    if (isStoreKitSessionAbsentError(result.error)) {
      throw new ActionableError(
        `iOS StoreKit test session for ${bundleId} is not on the runner and no confirmed clear followed its last change, so the simulator may still hold its StoreKit state`,
      );
    }
    throw new ActionableError(
      `iOS StoreKit test session for ${bundleId} could not be cleared: ${result.error ?? "unknown runner failure"}`,
    );
  }
}
