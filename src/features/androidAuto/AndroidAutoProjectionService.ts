import { promises as fs, type Stats } from "node:fs";
import type { BootedDevice } from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { exponentialBackoff } from "../../utils/Backoff";
import { BunPortAvailabilityChecker } from "../../utils/BunPortAvailabilityChecker";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { sortedReaddir } from "../../utils/io";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { openLocalApkByteSource } from "../observe/AdbPullApkFetcher";
import { InspectPackageSigning } from "../observe/InspectPackageSigning";
import { AdbAndroidAutoScreenDriver } from "./AdbAndroidAutoScreenDriver";
import { AdbAndroidAutoPhone } from "./AndroidAutoPhone";
import {
  AndroidAutoProjectionProvisioner,
  type AndroidAutoProvisioningStep,
} from "./AndroidAutoProjectionProvisioner";
import { ScriptedAndroidAutoSettingsUi } from "./AndroidAutoSettingsUi";
import { InspectingAndroidAutoSignerCheck } from "./AndroidAutoSignerCheck";
import {
  resolveAndroidAutoProvisionInputs,
  type AndroidAutoHostFiles,
  type AndroidAutoInputEnvironment,
  type AndroidAutoProvisionInputs,
  type ProvisionAndroidAutoOptions,
} from "./androidAutoProvisionInputs";
import { createDefaultDhuSpawner, SpawningDesktopHeadUnitLauncher } from "./DesktopHeadUnit";

/** What `provisionDevice` reports under `androidAuto`. */
export interface AndroidAutoProvisionReport {
  steps: AndroidAutoProvisioningStep[];
  desktopHeadUnit: { running: boolean };
}

/** The provisionDevice seam: check host inputs before boot, project once the device is ready. */
export interface AndroidAutoProjectionApplier {
  /** Throws an actionable error naming every missing host input (APK directory, DHU, config). */
  resolveInputs(options: ProvisionAndroidAutoOptions): Promise<AndroidAutoProvisionInputs>;
  apply(
    device: BootedDevice,
    options: ProvisionAndroidAutoOptions,
    signal?: AbortSignal,
  ): Promise<AndroidAutoProvisionReport>;
}

/** The projection run, narrowed to the one call the applier makes. */
export type AndroidAutoProvisionRunner = Pick<AndroidAutoProjectionProvisioner, "provision">;

export class DefaultAndroidAutoProjectionApplier implements AndroidAutoProjectionApplier {
  constructor(
    private readonly environment: AndroidAutoInputEnvironment,
    private readonly provisioner: AndroidAutoProvisionRunner,
  ) {}

  resolveInputs(options: ProvisionAndroidAutoOptions): Promise<AndroidAutoProvisionInputs> {
    return resolveAndroidAutoProvisionInputs(options, this.environment);
  }

  async apply(
    device: BootedDevice,
    options: ProvisionAndroidAutoOptions,
    signal?: AbortSignal,
  ): Promise<AndroidAutoProvisionReport> {
    const inputs = await this.resolveInputs(options);
    const result = await this.provisioner.provision({
      deviceId: device.deviceId,
      androidAutoApks: inputs.androidAutoApks,
      dhu: inputs.dhu,
      acceptAndroidAutoTerms: inputs.acceptAndroidAutoTerms,
      signal,
    });
    return { steps: result.steps, desktopHeadUnit: { running: result.session.isRunning() } };
  }
}

async function statMatches(target: string, matches: (stat: Stats) => boolean): Promise<boolean> {
  try {
    return matches(await fs.stat(target));
  } catch (error) {
    // A missing path is the answer being asked for; the caller reports it as missing.
    logger.debug(`[AndroidAuto] stat ${target} failed: ${errorMessage(error)}`);
    return false;
  }
}

export const nodeAndroidAutoHostFiles: AndroidAutoHostFiles = {
  isDirectory: (target) => statMatches(target, (stat) => stat.isDirectory()),
  isFile: (target) => statMatches(target, (stat) => stat.isFile()),
  list: (directory) => sortedReaddir(directory),
};

/** A provisioner wired to adb, `uiautomator dump`, the host DHU and the host port checker. */
export function createDefaultAndroidAutoProjectionProvisioner(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  timer: Timer = defaultTimer,
): AndroidAutoProjectionProvisioner {
  return new AndroidAutoProjectionProvisioner({
    forDevice: (deviceId) => {
      const device: BootedDevice = { deviceId, platform: "android", name: deviceId };
      const adb = adbFactory.create(device);
      const phone = new AdbAndroidAutoPhone(adb);
      return {
        phone,
        ui: new ScriptedAndroidAutoSettingsUi(
          phone,
          new AdbAndroidAutoScreenDriver(adb, deviceId, timer),
        ),
        signerCheck: new InspectingAndroidAutoSignerCheck(
          new InspectPackageSigning(device, adbFactory),
          openLocalApkByteSource,
        ),
      };
    },
    dhu: new SpawningDesktopHeadUnitLauncher(createDefaultDhuSpawner(), timer),
    hostPorts: new BunPortAvailabilityChecker(),
    timer,
    recoveryBackoff: exponentialBackoff({ initialDelayMs: 1_000, maxDelayMs: 4_000 }),
  });
}

let defaultApplier: AndroidAutoProjectionApplier | undefined;

/**
 * The process-wide applier. One provisioner per host, because every projection dials host
 * port 5277 and the provisioner is what tracks which DHU holds it.
 */
export function defaultAndroidAutoProjectionApplier(): AndroidAutoProjectionApplier {
  defaultApplier ??= new DefaultAndroidAutoProjectionApplier(
    { env: process.env, platform: process.platform, files: nodeAndroidAutoHostFiles },
    createDefaultAndroidAutoProjectionProvisioner(),
  );
  return defaultApplier;
}
