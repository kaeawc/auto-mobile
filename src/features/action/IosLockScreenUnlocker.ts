import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { PressButton } from "./PressButton";
import { SwipeOn } from "./swipeon/SwipeOn";
import type { IosScreenUnlocker } from "./WakeAndUnlock";

/**
 * iOS wake + swipe-dismiss, over the existing gesture primitives.
 *
 * iOS simulators cannot set a device passcode, so there is no secure bouncer:
 * "unlock" is waking the display (home button) and swiping the non-secure lock
 * screen up. No PIN is involved — WakeAndUnlock ignores it on iOS (issue #4360).
 */
export class IosLockScreenUnlocker implements IosScreenUnlocker {
  private readonly device: BootedDevice;

  constructor(device: BootedDevice) {
    this.device = device;
  }

  async wakeAndDismiss(): Promise<{ success: boolean; error?: string }> {
    try {
      // Wake the display so the lock screen is present and interactable.
      await new PressButton(this.device).execute("home");
      // A full-screen upward swipe dismisses the (non-secure) lock screen.
      const swipe = await new SwipeOn(this.device).execute({ direction: "up", autoTarget: false });
      return {
        success: swipe.success !== false,
        error:
          swipe.success === false
            ? (swipe.warning ?? "iOS lock-screen swipe did not report success")
            : undefined,
      };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`[IosLockScreenUnlocker] wake+dismiss failed: ${message}`);
      return { success: false, error: message };
    }
  }
}
