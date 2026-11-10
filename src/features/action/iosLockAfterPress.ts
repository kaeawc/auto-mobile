import type { BootedDevice } from "../../models";
import type { IosLockStateInvalidator } from "../observe/ios/CachedIosLockStateProbe";
import { getIosLockStateCache } from "../observe/ios/IosLockStateCacheRegistry";

/**
 * Drops the cached iOS lock state after any iOS button press, including failures. A successful
 * power press always leaves the device locked, so it also marks a pending lock transition: the
 * press acknowledges before SpringBoard publishes the new lockstate (#17770).
 */
export function invalidateIosLockAfterPress(
  invalidator: IosLockStateInvalidator | undefined,
  device: Pick<BootedDevice, "platform" | "deviceId">,
  button: string,
  pressed: { success: boolean } | undefined,
): void {
  if (device.platform !== "ios") {
    return;
  }
  const expectLocked = pressed?.success === true && button.toLowerCase() === "power";
  (invalidator ?? getIosLockStateCache()).invalidate(
    device.deviceId,
    expectLocked ? { expectLocked: true } : undefined,
  );
}
