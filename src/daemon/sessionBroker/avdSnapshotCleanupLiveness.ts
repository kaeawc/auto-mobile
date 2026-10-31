import { isUnknownEmulatorName } from "../../utils/android-cmdline-tools/emulatorReadinessEvaluation";
import { ActionableError } from "../../models/ActionableError";
import {
  emulatorProcessArguments,
  isEmulatorQemuProcess,
  type EmulatorProcessTableSource,
} from "../../utils/android-cmdline-tools/EmulatorProcessStop";
import { lookupLiveEmulatorSerial } from "../../utils/android-cmdline-tools/lookupLiveEmulatorSerial";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { AvdSnapshotCleanupLiveness } from "./AvdSnapshotCleanup";

/** Fail-closed process and checked emulator discovery; neither failure means "not running". */
export class ProcessTableAvdSnapshotCleanupLiveness implements AvdSnapshotCleanupLiveness {
  constructor(
    private readonly processTable: EmulatorProcessTableSource,
    private readonly listDevicesChecked: () => Promise<BootedDevice[]>,
  ) {}

  async hasLiveProcess(avdName: string): Promise<boolean> {
    const result = await this.processTable.read({});
    if (!result.value || result.error || result.failure) {
      throw new ActionableError(
        `Cannot verify AVD processes; retry cleanup after process discovery recovers: ${result.error ?? result.failure?.detail ?? "Process table unavailable"}`,
      );
    }
    const names = result.value
      .filter(isEmulatorQemuProcess)
      .map(({ command }) => emulatorProcessArguments(command).avdName);
    if (names.includes(undefined)) {
      throw new ActionableError(
        "Cannot identify a running emulator's AVD; stop it or restore process discovery before retrying cleanup",
      );
    }
    return names.some((name) => name?.toLowerCase() === avdName.toLowerCase());
  }

  findLiveEmulatorSerial(avdName: string): Promise<string | null> {
    return lookupLiveEmulatorSerial(avdName, async () => {
      const devices = await this.listDevicesChecked();
      if (
        devices.some(
          (device) => !device.name || isUnknownEmulatorName(device.name, device.deviceId),
        )
      ) {
        throw new ActionableError(
          "Cannot identify a discovered emulator's AVD; retry cleanup after emulator discovery recovers",
        );
      }
      return devices;
    });
  }
}
