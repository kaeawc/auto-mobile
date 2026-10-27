import { logger } from "../../../utils/logger";
import {
  resolveOwnAppDataContainer,
  SimulatorContainerUnresolvedError,
  type SimulatorContainerOwnershipOptions,
} from "../../../utils/ios-cmdline-tools/simulatorOwnContainer";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../utils/deviceTimeouts";
import type { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import type { InstalledPrototype, PrototypeSimctl } from "./iosPrototypeInstaller";
export { DefaultInstallerFileSystem } from "./DefaultInstallerFileSystem";
export { DefaultDataContainerWriter } from "./DefaultDataContainerWriter";

type SimctlInstallerClient = Pick<
  SimCtlClient,
  "installApp" | "uninstallApp" | "listAppsOrThrow" | "executeCommandArgs"
>;

export class DefaultPrototypeSimctl implements PrototypeSimctl {
  constructor(
    private readonly client: SimctlInstallerClient,
    private readonly ownership: SimulatorContainerOwnershipOptions = {},
  ) {}
  install(udid: string, appPath: string): Promise<void> {
    return this.client.installApp(appPath, udid, { timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS });
  }
  uninstall(udid: string, bundleId: string): Promise<void> {
    return this.client.uninstallApp(bundleId, udid);
  }
  async getDataContainer(udid: string, bundleId: string): Promise<string> {
    try {
      return await resolveOwnAppDataContainer({
        ...this.ownership,
        deviceId: udid,
        bundleId,
        run: (args) => this.client.executeCommandArgs(args),
      });
    } catch (error) {
      if (error instanceof SimulatorContainerUnresolvedError) {
        // The installer owns the existing actionable empty-container message.
        logger.debug("Simulator returned an empty prototype data container path");
        return "";
      }
      throw error;
    }
  }
  async listApps(udid: string): Promise<InstalledPrototype[]> {
    const apps: unknown[] = await this.client.listAppsOrThrow(udid);
    return apps.flatMap((app) => {
      if (
        !app ||
        typeof app !== "object" ||
        !("bundleId" in app) ||
        typeof app.bundleId !== "string"
      ) {
        return [];
      }
      const name =
        "CFBundleDisplayName" in app
          ? app.CFBundleDisplayName
          : "CFBundleName" in app
            ? app.CFBundleName
            : undefined;
      return [
        { bundleId: app.bundleId, ...(typeof name === "string" ? { displayName: name } : {}) },
      ];
    });
  }
}
