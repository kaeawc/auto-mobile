import type { BootedDevice } from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  parseAndroidCommittedStateIdentifier,
  parseAndroidDeviceStates,
} from "../../utils/android-cmdline-tools/AndroidDisplayInventory";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { RequestedPosture } from "../device/postureCommands";
import { SetPosture } from "../device/SetPosture";
import type { PostureControl } from "./DisplayProfile";

/** Posture through `setPosture`, read back from the committed `device_state`. */
export class SetPostureControl implements PostureControl {
  constructor(
    private readonly device: BootedDevice,
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ) {}

  async read(): Promise<RequestedPosture | undefined> {
    const adb = this.adbFactory.create(this.device);
    try {
      const states = parseAndroidDeviceStates(
        (await adb.executeCommand("shell cmd device_state print-states")).stdout,
      );
      const identifier = parseAndroidCommittedStateIdentifier(
        (await adb.executeCommand("shell cmd device_state state")).stdout,
      );
      const posture = states.find((state) => state.identifier === identifier)?.posture;
      return posture === undefined || posture === "unknown" ? undefined : posture;
    } catch (error) {
      // A device without the device_state service has no posture to restore.
      logger.debug(`Could not read posture on ${this.device.deviceId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async set(posture: RequestedPosture, signal?: AbortSignal) {
    const result = await new SetPosture(this.device, { adbFactory: this.adbFactory }).execute(
      posture,
      undefined,
      signal,
    );
    return "status" in result && result.status === "unsupported"
      ? { status: "unsupported" as const, detail: result.message }
      : { status: "applied" as const };
  }
}
