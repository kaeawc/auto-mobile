import {
  observeAndroidPosture,
  readAndroidStates,
  setEmulatorPosture,
} from "../../features/device/postureCommands";
import {
  AdbAndroidHingeAngleConsole,
  type AndroidHingeAngleConsole,
} from "../../features/device/AndroidHingeAngleConsole";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";

const OPENED_HINGE_ANGLE_DEGREES = 180;

export interface AndroidFoldPostureRestore {
  /** Runs inside the baseline reset's deadline, using its cancellation signal. */
  restore(device: BootedDevice, signal: AbortSignal): Promise<void>;
}

/**
 * Returns a released fold emulator to the `opened` posture and default hinge angle, proving both
 * the committed `device_state` and the hinge read-back so the next session never starts folded.
 */
export class AdbAndroidFoldPostureRestore implements AndroidFoldPostureRestore {
  constructor(
    private readonly adb: Pick<AdbClientFactory, "create">,
    private readonly hinge: AndroidHingeAngleConsole = new AdbAndroidHingeAngleConsole(),
    private readonly timer: Timer = defaultTimer,
  ) {}

  async restore(device: BootedDevice, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      if (!device.deviceId.startsWith("emulator-")) {
        throw new ActionableError("Fold posture baseline reset requires an Android emulator");
      }
      const adb = this.adb.create(device);
      const operation = { signal, assertCurrent: () => signal.throwIfAborted() };
      // Clear rear-display overrides as well as restoring the emulator posture.
      const fallback = await setEmulatorPosture(adb, "opened", undefined, {
        supportsRearDisplay: true,
        operation,
      });
      if (fallback) {
        throw new ActionableError(
          "Emulator refused unfolded posture; cannot prove opened baseline",
        );
      }
      const result = await this.hinge.setHingeAngle(adb, OPENED_HINGE_ANGLE_DEGREES, { signal });
      if (!result.ok) {
        throw new ActionableError(
          `Cannot restore hinge angle to ${OPENED_HINGE_ANGLE_DEGREES}: ${result.reason}`,
        );
      }
      const actual = await this.hinge.getHingeAngle(adb, { signal });
      if (!actual.ok || actual.degrees !== OPENED_HINGE_ANGLE_DEGREES) {
        throw new ActionableError(
          `Hinge angle read-back did not confirm ${OPENED_HINGE_ANGLE_DEGREES} degrees`,
        );
      }
      const states = await readAndroidStates(adb, operation);
      await observeAndroidPosture(
        adb,
        "opened",
        { states },
        {
          timer: this.timer,
          observe: () => {
            throw new ActionableError("The device exposes no committed posture state to read back");
          },
          operation,
        },
      );
      signal.throwIfAborted();
    } catch (error) {
      throw new ActionableError(
        `Cannot restore Android device '${device.deviceId}' to opened posture (${OPENED_HINGE_ANGLE_DEGREES} degrees): ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}
