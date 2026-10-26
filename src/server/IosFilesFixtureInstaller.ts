import type { BootedDevice } from "../models";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { getIosInstalledAppBundleId } from "../utils/ios-cmdline-tools/iosInstalledApp";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { DefaultHostCommandExecutor } from "../utils/HostCommandExecutor";
import { getTempDir } from "../utils/tempDir";
import {
  IOS_FILES_FIXTURE_BUNDLE_ID,
  requireIosFilesSimulator,
} from "./IosSimulatorUserFilesProvider";
import {
  SwiftcIosFilesFixtureBuilder,
  type IosFilesFixtureBuilder,
} from "./IosFilesFixtureBuilder";
import { IosFilesFixtureUnavailableError } from "./IosFilesFixtureUnavailableError";

export type IosFilesFixtureInstallOutcome = "current" | "installed" | "updated";

/** Installs the managed Files fixture app on iOS Simulators. */
export interface IosFilesFixtureInstaller {
  /** Installs or updates the fixture; resolves `current` when nothing had to change. */
  ensureInstalled(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<IosFilesFixtureInstallOutcome>;
  /** Read-only: whether a fixture app is installed. Undefined when the listing failed. */
  isInstalled(device: BootedDevice, signal?: AbortSignal): Promise<boolean | undefined>;
}

export type IosFilesFixtureSimctl = Pick<SimCtlClient, "listAppsOrThrow" | "installApp">;

const INSTALL_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;

/** Single-flight per simulator so concurrent writes share one build and one install. */
export class SimctlIosFilesFixtureInstaller implements IosFilesFixtureInstaller {
  private readonly inFlight = new Map<string, Promise<IosFilesFixtureInstallOutcome>>();

  constructor(
    private readonly builder: IosFilesFixtureBuilder,
    private readonly simctlFactory: (device: BootedDevice) => IosFilesFixtureSimctl = (device) =>
      new SimCtlClient(device),
  ) {}

  ensureInstalled(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<IosFilesFixtureInstallOutcome> {
    requireIosFilesSimulator(device);
    const running = this.inFlight.get(device.deviceId);
    if (running) {
      return running;
    }
    const started = this.install(device, signal).finally(() => {
      this.inFlight.delete(device.deviceId);
    });
    this.inFlight.set(device.deviceId, started);
    return started;
  }

  async isInstalled(device: BootedDevice, signal?: AbortSignal): Promise<boolean | undefined> {
    try {
      return (await this.findInstalled(device, signal)) !== undefined;
    } catch (error) {
      // The capability resource reports an unverified prerequisite instead of failing.
      logger.warn(`iOS Files fixture install probe failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  private async install(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<IosFilesFixtureInstallOutcome> {
    const [expectedVersion, installed] = await Promise.all([
      this.builder.version(signal),
      this.listInstalled(device, signal),
    ]);
    if (installed && installed.version === expectedVersion) {
      return "current";
    }
    const appPath = await this.builder.ensureBuilt(signal);
    try {
      // Installing over an existing bundle keeps its data container, so staged namespaces survive.
      await this.simctlFactory(device).installApp(appPath, device.deviceId, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new IosFilesFixtureUnavailableError(
        "install_failed",
        `Failed to install the managed iOS Files fixture app (${IOS_FILES_FIXTURE_BUNDLE_ID}) on ${device.deviceId}: ${errorMessage(error)}. Confirm the simulator is booted and retry.`,
        { cause: error },
      );
    }
    return installed ? "updated" : "installed";
  }

  private async listInstalled(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<{ version: string | undefined } | undefined> {
    try {
      return await this.findInstalled(device, signal);
    } catch (error) {
      throw new IosFilesFixtureUnavailableError(
        "install_failed",
        `Unable to list installed apps on ${device.deviceId} to check the managed iOS Files fixture: ${errorMessage(error)}. Confirm the simulator is booted and retry.`,
        { cause: error },
      );
    }
  }

  private async findInstalled(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<{ version: string | undefined } | undefined> {
    const apps = await this.simctlFactory(device).listAppsOrThrow(device.deviceId, {
      signal,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const record = apps.find(
      (app) => getIosInstalledAppBundleId(app) === IOS_FILES_FIXTURE_BUNDLE_ID,
    );
    if (!record) {
      return undefined;
    }
    const version = record["CFBundleVersion"];
    return { version: typeof version === "string" ? version.trim() : undefined };
  }
}

let defaultInstaller: IosFilesFixtureInstaller | undefined;

/** Process-wide installer shared by `putAppFile` and the storage-capability probe. Construction does no I/O. */
export function getIosFilesFixtureInstaller(): IosFilesFixtureInstaller {
  defaultInstaller ??= new SimctlIosFilesFixtureInstaller(
    new SwiftcIosFilesFixtureBuilder({
      host: new DefaultHostCommandExecutor(),
      cacheRoot: () => getTempDir("ios-files-fixture"),
    }),
  );
  return defaultInstaller;
}
