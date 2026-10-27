import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../src/features/bootAdmission/AndroidBootAdmissionGate";
import type {
  AndroidCapacitySample,
  AndroidCapacitySource,
} from "../../src/features/bootAdmission/AndroidCapacitySource";
import { InMemoryBootDurationHistory } from "../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimCapacityGate } from "../../src/features/iosSimFleet/CapacityGate";
import { IOS_SIM_MAX_BOOTED_ENV } from "../../src/features/iosSimFleet/capacityPolicy";
import { IosSimFleetCostCollector } from "../../src/features/iosSimFleet/FleetCostCollector";
import type { FleetHostSource } from "../../src/features/iosSimFleet/FleetHostSource";
import { FleetBootInstrumentation } from "../../src/features/iosSimFleet/IosBootInstrumentation";
import type { DeviceInfo, Platform } from "../../src/models";
import type { BootAdmission } from "../../src/models/BootAdmission";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import type { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { FakeTimer } from "../fakes/FakeTimer";

const GIB = 1024 ** 3;
const HOST = { totalMemoryBytes: 64 * GIB, cpuCount: 16 };
const BOOT_BUDGET_MS = 120_000;

/** One admission a boot took, and how often its slot was let go. */
export interface ObservedAdmission {
  readonly platform: Platform;
  /** Calls to the admission's `release`, the real one being idempotent. */
  releaseCalls: number;
  /** The real admission, for replaying a late release after the undo. */
  readonly release: () => void;
}

/**
 * The REAL boot admission gates and ledgers (#11181) over a fake fleet: every boot
 * `devices.startDevice` performs is admitted by the production gate. An iOS boot runs under the
 * real `FleetBootInstrumentation`, which releases when the boot call returns. The Android
 * launcher is faked here, so its hold/hand-off/release wiring below is this helper's own copy of
 * `AndroidEmulatorClient.spawnWithBootAdmission` (admission held across the spawn, handed off to
 * the serial once the emulator process exists, released when that process exits or the spawn
 * fails): `releaseCalls` on an Android admission counts what the callers under test triggered
 * through that copy, and the launcher's own wiring is pinned in
 * `AndroidEmulatorClient-bootAdmission.test.ts`. Capacity is sampled from the fake fleet's own
 * listing, so a device that is still listed is still counted.
 */
export class RealBootGatesOverFakeFleet {
  readonly admissions: ObservedAdmission[] = [];
  readonly android: AndroidBootAdmissionGate;
  readonly ios: IosSimCapacityGate;
  /** Emulator processes spawned and not yet exited, as the process table would show them. */
  private readonly liveEmulatorProcesses = new Set<HostChildProcess>();
  /** False models a host whose process table cannot be read. */
  processTableReadable = true;

  constructor(
    private readonly devices: FakeDeviceUtils,
    private readonly timer: FakeTimer,
    limit: number,
  ) {
    const androidSource: AndroidCapacitySource = {
      sample: async (): Promise<AndroidCapacitySample> => ({
        emulatorSerials: await this.listed("android"),
        emulatorProcessRssBytes: this.processTableReadable
          ? [...this.liveEmulatorProcesses].map(() => GIB)
          : undefined,
        host: { ...HOST },
        errors: this.processTableReadable ? [] : ["ps: unavailable"],
      }),
    };
    this.android = new AndroidBootAdmissionGate(androidSource, timer, {
      env: { [ANDROID_MAX_BOOTED_ENV]: String(limit) },
    });
    const iosSource: FleetHostSource = {
      readHostSnapshot: async () => ({
        takenAtMs: 0,
        resources: { ...HOST, memoryPressure: "normal", loadAverage1m: null },
        processes: [],
      }),
      readInventory: async () => {
        const booted = new Set(await this.listed("ios"));
        const images = await this.devices.listDeviceImages("ios");
        return images.map((image) => ({
          udid: image.deviceId!,
          name: image.name,
          state: booted.has(image.deviceId!) ? "Booted" : "Shutdown",
          runtime: "iOS-18",
          isAvailable: true,
        }));
      },
    };
    this.ios = new IosSimCapacityGate(
      new IosSimFleetCostCollector(iosSource, new InMemoryBootDurationHistory(), timer),
      timer,
      { env: { [IOS_SIM_MAX_BOOTED_ENV]: String(limit) } },
    );
    this.admitEveryBoot();
  }

  private async listed(platform: Platform): Promise<string[]> {
    return (await this.devices.getBootedDevices(platform)).map((device) => device.deviceId);
  }

  private observe(platform: Platform, release: () => void): ObservedAdmission {
    const observed: ObservedAdmission = { platform, releaseCalls: 0, release };
    this.admissions.push(observed);
    return observed;
  }

  private admitEveryBoot(): void {
    const { devices, timer } = this;
    const boot = devices.startDevice.bind(devices);
    const iosAdmitBoot = this.ios.admitBoot.bind(this.ios);
    this.ios.admitBoot = async (...request) => {
      const admission = await iosAdmitBoot(...request);
      const { releaseAdmission } = admission;
      if (!releaseAdmission) {
        return admission;
      }
      const observed = this.observe("ios", releaseAdmission);
      return {
        ...admission,
        releaseAdmission: (outcome) => {
          observed.releaseCalls++;
          releaseAdmission(outcome);
        },
      };
    };
    const iosBoots = new FleetBootInstrumentation({
      history: new InMemoryBootDurationHistory(),
      timer,
      gate: this.ios,
    });
    devices.startDevice = async (image: DeviceInfo, ...rest) => {
      if (image.platform === "ios") {
        return await iosBoots.run({ udid: image.deviceId!, timeoutMs: BOOT_BUDGET_MS }, () =>
          boot(image, ...rest),
        );
      }
      const admission = await this.android.admit({
        avdName: image.name,
        timeoutMs: BOOT_BUDGET_MS,
      });
      const observed = this.observe("android", admission.release);
      const release = (): void => {
        observed.releaseCalls++;
        admission.release();
      };
      try {
        const child = await boot(image, ...rest);
        if (!child) {
          release();
          return child;
        }
        this.liveEmulatorProcesses.add(child);
        child.once("exit", () => {
          this.liveEmulatorProcesses.delete(child);
          release();
        });
        admission.handOff(image.deviceId);
        return child;
      } catch (error) {
        release();
        throw error;
      }
    };
  }

  /** Whether one more cold boot of `platform` is admitted right now; the probe's slot is freed. */
  async admitsOneMoreBoot(platform: Platform): Promise<boolean> {
    try {
      if (platform === "android") {
        (await this.android.admit({ avdName: "probe", timeoutMs: BOOT_BUDGET_MS })).release();
        return true;
      }
      const observedBefore = this.admissions.length;
      const admission = await this.ios.admitBoot(undefined, { bootUdid: "probe-udid" });
      // The probe is not one of the fleet's boots.
      this.admissions.length = observedBefore;
      admission.releaseAdmission?.();
      return admission.decision.outcome !== "refuse";
    } catch (error) {
      if (error instanceof BootCapacityExhaustedError) {
        return false;
      }
      throw error;
    }
  }

  /** Hold one more slot of `platform`, as a second caller's boot would; undefined when refused. */
  async holdOneMoreBoot(platform: Platform): Promise<BootAdmission | undefined> {
    try {
      if (platform === "android") {
        return await this.android.admit({ avdName: "second-boot", timeoutMs: BOOT_BUDGET_MS });
      }
      const observedBefore = this.admissions.length;
      const admission = await this.ios.admitBoot(undefined, { bootUdid: "second-boot-udid" });
      this.admissions.length = observedBefore;
      return admission.releaseAdmission
        ? { release: admission.releaseAdmission, handOff: () => {} }
        : undefined;
    } catch (error) {
      if (error instanceof BootCapacityExhaustedError) {
        return undefined;
      }
      throw error;
    }
  }

  /** Booted devices and admitted boots in flight, as the gate of `platform` counts them. */
  async capacity(platform: Platform): Promise<{ booted: number; inFlight: number }> {
    const { booted, inFlight } = await (platform === "android"
      ? this.android.describeCapacity()
      : this.ios.describeCapacity());
    return { booted, inFlight };
  }
}
