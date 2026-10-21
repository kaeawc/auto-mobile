import type { BootedDevice } from "../../../../src/models/DeviceInfo";
import type {
  BootCapacityReserver,
  BootReservationOptions,
} from "../../../../src/devices/bootAdmission/BootSlotReservation";
import type {
  AndroidSnapshotIdentity,
  AndroidSnapshotResetPort,
  AndroidSnapshotStep,
} from "../../../../src/daemon/sessionBroker/androidSnapshotReset";
import type { VmSnapshotAction } from "../../../../src/utils/android-cmdline-tools/vmSnapshot";

export class FakeAndroidSnapshotPort implements AndroidSnapshotResetPort {
  currentIdentity: AndroidSnapshotIdentity = {
    avdName: "broker-avd",
    systemImage: "system-image-revision-1",
    emulatorVersion: "emulator-36.1",
    ctrlProxyVersion: "ctrlproxy-sha-1",
  };
  calls: string[] = [];
  failures = new Set<string>();
  contexts: AndroidSnapshotStep[] = [];
  onStep?: (action: string, step: AndroidSnapshotStep) => Promise<void>;
  capacity?: BootCapacityReserver;
  released = 0;
  markedGone = 0;

  async identity(
    _device: BootedDevice,
    step: AndroidSnapshotStep,
  ): Promise<AndroidSnapshotIdentity> {
    await this.record("identity", step);
    return { ...this.currentIdentity };
  }
  snapshot(
    action: VmSnapshotAction,
    _device: BootedDevice,
    step: AndroidSnapshotStep,
  ): Promise<void> {
    return this.record(action, step);
  }
  health(_device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    return this.record("health", step);
  }
  stop(_device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    return this.record("stop", step);
  }
  launchWiped(_device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    return this.record("launch", step);
  }
  ready(_device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    return this.record("ready", step);
  }
  waitForRestore(_device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    return this.record("restore ready", step);
  }
  async reserveBoot(options: BootReservationOptions) {
    this.calls.push("reserve");
    if (this.capacity) {
      return this.capacity.reserveBoot(options);
    }
    return {
      run: async <Result>(operation: () => Promise<Result>): Promise<Result> => operation(),
      release: () => {
        this.released++;
      },
      markReplacedDeviceGone: () => {
        this.markedGone++;
      },
    };
  }
  private async record(action: string, step: AndroidSnapshotStep): Promise<void> {
    step.signal.throwIfAborted();
    this.contexts.push(step);
    this.calls.push(action);
    await this.onStep?.(action, step);
    if (this.failures.has(action)) {
      throw new Error(`${action} failed`);
    }
  }
}
