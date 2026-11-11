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
  type AndroidAutoProjectionResult,
  type AndroidAutoProvisioningStep,
} from "./AndroidAutoProjectionProvisioner";
import { ScriptedAndroidAutoSettingsUi } from "./AndroidAutoSettingsUi";
import { InspectingAndroidAutoSignerCheck } from "./AndroidAutoSignerCheck";
import {
  resolveAndroidAutoProvisionInputs,
  resolveDesktopHeadUnitInputs,
  type AndroidAutoHostFiles,
  type AndroidAutoInputEnvironment,
  type AndroidAutoProvisionInputs,
  type DesktopHeadUnitInputs,
  type ProvisionAndroidAutoOptions,
  type StartDeviceAndroidAutoOptions,
} from "./androidAutoProvisionInputs";
import {
  createDefaultDhuSpawner,
  SpawningDesktopHeadUnitLauncher,
  type DesktopHeadUnitConsole,
} from "./DesktopHeadUnit";

/** What `provisionDevice` and `startDevice` report under `androidAuto`. */
export interface AndroidAutoProvisionReport {
  steps: AndroidAutoProvisioningStep[];
  /** The head unit this daemon runs for the phone: whether it holds its connection, and its config. */
  desktopHeadUnit: { running: boolean; configPath: string };
}

/** How a DHU stop treats the phone's host port 5277 redirect. */
export interface DesktopHeadUnitStopOptions {
  deviceStopped?: boolean;
  releaseRedirect?: boolean;
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
  /** Throws an actionable error naming a missing DHU binary or config. */
  resolveHeadUnitInputs(options: StartDeviceAndroidAutoOptions): Promise<DesktopHeadUnitInputs>;
  /**
   * startDevice's head unit for a phone already provisioned for projection: the same run as
   * `apply`, with no APKs, so a phone still on the Android Auto stub is refused, not installed.
   */
  startHeadUnit(
    device: BootedDevice,
    options: StartDeviceAndroidAutoOptions,
    signal?: AbortSignal,
  ): Promise<AndroidAutoProvisionReport>;
  /**
   * Stops the DHU this daemon spawned for `deviceId` (bounded; never rejects) and forgets it.
   * DHUs this daemon did not spawn are never touched. `deviceStopped` means the emulator itself
   * is going away, so its host port redirect is forgotten too. `releaseRedirect` means the
   * emulator keeps running but its session ended, so the redirect this daemon added is removed.
   * Returns true when an owned DHU stopped, false when absent or stopping failed.
   */
  stopDesktopHeadUnit(deviceId: string, options?: DesktopHeadUnitStopOptions): Promise<boolean>;
}

/** The projection run, narrowed to the calls the applier makes. */
export type AndroidAutoProvisionRunner = Pick<
  AndroidAutoProjectionProvisioner,
  "provision" | "stopDesktopHeadUnit"
>;

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
    return report(result);
  }

  resolveHeadUnitInputs(options: StartDeviceAndroidAutoOptions): Promise<DesktopHeadUnitInputs> {
    return resolveDesktopHeadUnitInputs(options, this.environment);
  }

  async startHeadUnit(
    device: BootedDevice,
    options: StartDeviceAndroidAutoOptions,
    signal?: AbortSignal,
  ): Promise<AndroidAutoProvisionReport> {
    const inputs = await this.resolveHeadUnitInputs(options);
    const result = await this.provisioner.provision({
      deviceId: device.deviceId,
      androidAutoApks: [],
      dhu: inputs.dhu,
      acceptAndroidAutoTerms: inputs.acceptAndroidAutoTerms,
      signal,
    });
    return report(result);
  }

  stopDesktopHeadUnit(deviceId: string, options?: DesktopHeadUnitStopOptions): Promise<boolean> {
    return this.provisioner.stopDesktopHeadUnit(deviceId, options);
  }
}

function report(result: AndroidAutoProjectionResult): AndroidAutoProvisionReport {
  return {
    steps: result.steps,
    desktopHeadUnit: { running: result.session.isRunning(), configPath: result.configPath },
  };
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
let defaultProvisioner: AndroidAutoProjectionProvisioner | undefined;

/**
 * The process-wide applier. One provisioner per host, because every projection dials host
 * port 5277 and the provisioner is what tracks which DHU holds it.
 */
export function defaultAndroidAutoProjectionApplier(): AndroidAutoProjectionApplier {
  if (!defaultApplier) {
    defaultProvisioner = createDefaultAndroidAutoProjectionProvisioner();
    defaultApplier = new DefaultAndroidAutoProjectionApplier(
      { env: process.env, platform: process.platform, files: nodeAndroidAutoHostFiles },
      defaultProvisioner,
    );
  }
  return defaultApplier;
}

/** What session-end cleanup asks of the host's provisioner: whether it holds 5277 for a phone. */
export type AndroidAutoHostPortHolder = Pick<
  AndroidAutoProjectionProvisioner,
  "holdsHostPortFor" | "stopDesktopHeadUnit"
>;

/** The process-wide provisioner only when something already projected, like the applier below. */
export function existingDefaultAndroidAutoHostPortHolder(): AndroidAutoHostPortHolder | undefined {
  return defaultProvisioner;
}

/**
 * The console of the DHU this daemon runs for `deviceId` (#17842), or undefined when the daemon
 * started none. Never creates the provisioner, and never starts or stops a DHU.
 */
export function existingDesktopHeadUnitConsole(
  deviceId: string,
): DesktopHeadUnitConsole | undefined {
  return defaultProvisioner?.desktopHeadUnitConsole(deviceId);
}

/**
 * The process-wide applier only when something already created it. Teardown uses this: a daemon
 * that never projected has no DHU to stop, so it must not build a provisioner just to look.
 */
export function existingDefaultAndroidAutoProjectionApplier():
  | AndroidAutoProjectionApplier
  | undefined {
  return defaultApplier;
}
