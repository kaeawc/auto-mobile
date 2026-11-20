import path from "node:path";
import { ActionableError, toActionableError } from "../../../../models/ActionableError";
import { getAbortSignal } from "../../../../utils/AbortContext";
import { withDeviceReadinessLock } from "../../../../utils/deviceReadinessLock";
import type { ClearAppDataResult } from "../../../../models";
import type { FileSystem } from "../../../../utils/filesystem/DefaultFileSystem";
import { getIosInstalledAppBundleId } from "../../../../utils/ios-cmdline-tools/iosInstalledApp";
import { SimulatorIosPermissionsBackend } from "../../../../utils/ios-cmdline-tools/IosPermissionsBackend";
import type { SimCtlClient } from "../../../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../../../utils/logger";
import type { DataContainerWriter, PrototypeSimctl } from "../../ios/iosPrototypeInstaller";
import { prototypeJsonSchema, type PrototypeJson } from "../../prototypeJson";
import { PROTOTYPE_PERMISSION_MAP, PROTOTYPE_PERMISSION_NAMES } from "../../prototypePermissionMap";
import type { DisposableAppInstallation, DisposableAppInstaller } from "../DisposableAppManager";
import {
  assertDisposableAppId,
  DISPOSABLE_APP_ID_PREFIX,
  isDisposableAppId,
} from "../disposableAppId";
import type { DisposableAppPermissionGrants } from "../disposableAppPermissions";
import {
  IOS_DISPOSABLE_APP_SIGNER,
  IOS_DISPOSABLE_APP_SPEC,
  requireDisposableAppSimulator,
} from "./iosDisposableAppIdentity";

const PRIVACY_SERVICES = new Map<string, string | null>(
  PROTOTYPE_PERMISSION_NAMES.map((name) => [
    name,
    PROTOTYPE_PERMISSION_MAP[name].ios.simctlService,
  ]),
);

interface IosDisposableAppInstallerDependencies {
  simctl: PrototypeSimctl;
  commands: Pick<SimCtlClient, "executeCommandArgs" | "listAppsOrThrow">;
  files: Pick<FileSystem, "readFile">;
  clearStorage(deviceId: string, appId: string): Promise<ClearAppDataResult>;
  data: DataContainerWriter;
}

export class IosDisposableAppInstaller implements DisposableAppInstaller {
  constructor(private readonly deps: IosDisposableAppInstallerDependencies) {}

  async install(deviceId: string, appId: string, artifactPath: string): Promise<void> {
    assertDisposableAppId(appId);
    requireDisposableAppSimulator(deviceId);
    try {
      // Parse the bundled spec first, so a bad artifact never replaces the installed app.
      await this.readSpec(artifactPath);
      await this.deps.simctl.install(deviceId, artifactPath);
    } catch (error) {
      throw toActionableError(error, `Cannot install iOS disposable app ${appId}`);
    }
  }

  /** Writes the bundled spec as the saved Viewer layout after the host recorded the install. */
  async seedStorage(deviceId: string, appId: string, artifactPath: string): Promise<void> {
    assertDisposableAppId(appId);
    requireDisposableAppSimulator(deviceId);
    try {
      const spec = await this.readSpec(artifactPath);
      const container = await this.dataContainer(deviceId, appId);
      await this.deps.data.write(container, spec);
    } catch (error) {
      throw toActionableError(error, `Cannot seed storage for iOS disposable app ${appId}`);
    }
  }

  async resetStorage(deviceId: string, appId: string): Promise<void> {
    assertDisposableAppId(appId);
    requireDisposableAppSimulator(deviceId);
    try {
      const apps = await this.deps.commands.listAppsOrThrow(deviceId);
      const bundlePath = apps.find((app) => getIosInstalledAppBundleId(app) === appId)?.Path;
      const bundle = typeof bundlePath === "string" ? bundlePath.trim() : "";
      if (!path.isAbsolute(bundle)) {
        throw new ActionableError(`Simulator did not return a bundle path for ${appId}.`);
      }
      const spec = await this.readSpec(bundle);
      const result = await this.deps.clearStorage(deviceId, appId);
      if (!result.success) {
        throw new ActionableError(result.error ?? `Could not clear data for ${appId}.`);
      }
      const container = await this.dataContainer(deviceId, appId);
      await this.deps.data.write(container, spec);
    } catch (error) {
      throw toActionableError(error, `Cannot clear data for iOS disposable app ${appId}`);
    }
  }

  async applyPermissions(
    deviceId: string,
    appId: string,
    grants: DisposableAppPermissionGrants,
  ): Promise<void> {
    assertDisposableAppId(appId);
    requireDisposableAppSimulator(deviceId);
    if (grants.granted.length === 0 && grants.denied.length === 0) {
      return;
    }
    // Coordinate with the app permissions tool, which also mutates the device's shared TCC state.
    await withDeviceReadinessLock(
      `ios-privacy:${deviceId}`,
      () => this.updatePrivacy(deviceId, appId, grants),
      { signal: getAbortSignal() },
    );
  }

  async uninstall(deviceId: string, appId: string): Promise<void> {
    assertDisposableAppId(appId);
    requireDisposableAppSimulator(deviceId);
    await this.deps.simctl.uninstall(deviceId, appId);
  }

  async installedIds(deviceId: string, prefix: string): Promise<string[]> {
    // The manager's reserved prefix has no slug, so it is valid for listing only.
    if (prefix !== DISPOSABLE_APP_ID_PREFIX) {
      assertDisposableAppId(prefix);
    }
    requireDisposableAppSimulator(deviceId);
    const apps = await this.deps.simctl.listApps(deviceId);
    return apps
      .map((app) => app.bundleId)
      .filter((id) => isDisposableAppId(id) && id.startsWith(prefix));
  }

  async inspect(deviceId: string, appId: string): Promise<DisposableAppInstallation> {
    assertDisposableAppId(appId);
    requireDisposableAppSimulator(deviceId);
    const apps = await this.deps.simctl.listApps(deviceId);
    return apps.some((app) => app.bundleId === appId)
      ? { installed: true, signer: IOS_DISPOSABLE_APP_SIGNER }
      : { installed: false };
  }

  private async updatePrivacy(
    deviceId: string,
    appId: string,
    grants: DisposableAppPermissionGrants,
  ): Promise<void> {
    const backend = new SimulatorIosPermissionsBackend({ deviceId, simctl: this.deps.commands });
    for (const [action, names] of [
      ["grant", grants.granted],
      ["revoke", grants.denied],
    ] as const) {
      for (const name of names) {
        const service = PRIVACY_SERVICES.get(name);
        if (!service) {
          logger.debug(
            `Skipping iOS disposable app permission "${name}": no simctl privacy service.`,
          );
          continue;
        }
        await backend.setPrivacy({ action, permission: service, appId });
      }
    }
  }

  private async readSpec(bundle: string): Promise<PrototypeJson> {
    const spec = await this.deps.files.readFile(path.join(bundle, IOS_DISPOSABLE_APP_SPEC));
    return prototypeJsonSchema.parse(JSON.parse(spec));
  }

  private async dataContainer(deviceId: string, appId: string): Promise<string> {
    const container = await this.deps.simctl.getDataContainer(deviceId, appId);
    if (!path.isAbsolute(container)) {
      throw new ActionableError(`Simulator did not return a data container path for ${appId}.`);
    }
    return container;
  }
}
