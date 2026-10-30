import { Daemon } from "../../src/daemon/daemon";
import type { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { listActiveVideoRecordings } from "../../src/daemon/videoRecordingManager";
import type { AdbTransportRestartLookup } from "../../src/utils/android-cmdline-tools/AdbTransportRestartRegistry";

/** The slice of the device manager the daemon's disconnect monitor probes. */
export type DisconnectMonitorDeviceManager = Pick<
  MultiPlatformDeviceManager,
  | "getBootedDevicesDetailed"
  | "getAndroidOfflineDeviceIds"
  | "getAndroidListedDeviceStates"
  | "recoverAndroidOfflineDevices"
>;

/**
 * The real `Daemon`, with the disconnect monitor's entry point and bookkeeping readable by the
 * lifecycle scenarios. The members are `protected` on `Daemon`; a subclass is the typed seam, so
 * no scenario reaches into private state through a cast.
 */
export class ScenarioDaemon extends Daemon {
  /** Start the daemon's real 5 s disconnect poll over `deviceManager`. */
  override startDeviceDisconnectMonitor(
    deviceManager?: DisconnectMonitorDeviceManager,
    listRecordings?: typeof listActiveVideoRecordings,
    transportRestarts?: AdbTransportRestartLookup,
  ): void {
    super.startDeviceDisconnectMonitor(deviceManager, listRecordings, transportRestarts);
  }

  /** Device ids the monitor holds a transitional (offline/unauthorized/booting) episode for. */
  offlineEpisodeDeviceIds(): string[] {
    return [...this.deviceLoss.offlineEpisodes.keys()];
  }

  /** Devices the monitor is counting absent misses for. */
  disconnectMisses(): Map<string, number> {
    const misses = this.deviceLoss.misses;
    return new Map(
      [...misses.deviceIds()].flatMap((deviceId): Array<[string, number]> => {
        const count = misses.get(deviceId);
        return count === undefined ? [] : [[deviceId, count]];
      }),
    );
  }
}
