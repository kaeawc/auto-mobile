/**
 * {@link RemoteCtrlProxyInstaller} over `AndroidCtrlProxyManager` (#14468). A remote serial can
 * name a different device than last time, so the manager's serial-scoped state is dropped before
 * every install, and the install is forced because remote sessions start wiped.
 */
import { AndroidCtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import type { CtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import type { BootedDevice } from "../../models";
import type { ProxySetupResult } from "../../utils/interfaces/ProxyManager";
import type { RemoteCtrlProxyInstaller } from "./androidRemoteDeviceConnectSetup";

export interface AndroidCtrlProxyRemoteInstallerDependencies {
  /** Drops every cached CtrlProxy readiness entry and the manager instance for `serial`. */
  invalidate(serial: string): void;
  /** The manager for `device`; resolved after {@link invalidate}, so it starts clean. */
  managerFor(device: BootedDevice): Pick<CtrlProxyManager, "setup">;
}

const MANAGER_DEPENDENCIES: AndroidCtrlProxyRemoteInstallerDependencies = {
  invalidate: (serial) => AndroidCtrlProxyManager.invalidateForDeviceIncarnation(serial),
  managerFor: (device) => AndroidCtrlProxyManager.getInstance(device),
};

export class AndroidCtrlProxyRemoteInstaller implements RemoteCtrlProxyInstaller {
  constructor(
    private readonly deps: AndroidCtrlProxyRemoteInstallerDependencies = MANAGER_DEPENDENCIES,
  ) {}

  forgetDevice(serial: string): void {
    this.deps.invalidate(serial);
  }

  install(device: BootedDevice): Promise<ProxySetupResult> {
    return this.deps.managerFor(device).setup(true);
  }
}
