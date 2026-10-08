import path from "node:path";

/**
 * Identity of the signed Network Extension app built by
 * `scripts/ios/build-network-filter-probe.sh` (#6298, #10588). These values
 * mirror `ios/network-filter/Packaging/*-Info.plist` and
 * `NetworkFilterCore/ProbeSigning.swift`.
 */
export const NETWORK_FILTER_APP_NAME = "AutoMobile Network Identity Probe.app";
export const NETWORK_FILTER_APP_IDENTIFIER = "dev.jasonpearson.automobile.networkfilter";
export const NETWORK_FILTER_PROVIDER_IDENTIFIER =
  "dev.jasonpearson.automobile.networkfilter.provider";
export const NETWORK_FILTER_CONTROLLER_RELATIVE_PATH = path.posix.join(
  "Contents",
  "MacOS",
  "network-filter-controller",
);
export const NETWORK_FILTER_PROVIDER_RELATIVE_PATH = path.posix.join(
  "Contents",
  "Library",
  "SystemExtensions",
  `${NETWORK_FILTER_PROVIDER_IDENTIFIER}.systemextension`,
);

/** SystemExtensions only activates an extension whose containing app is here. */
export const NETWORK_FILTER_INSTALL_DIR = "/Applications";

/** Local-build override: a path to a signed `.app` used instead of the release download. */
export const NETWORK_FILTER_APP_PATH_ENV = "AUTOMOBILE_NETWORK_FILTER_APP_PATH";

/**
 * Optional pinned Apple Team ID. When set, the app and its provider must be
 * signed by exactly this team. AutoMobile ships no canonical Team ID (see
 * `IOS_HELPER_TEAM_ID_ENV`), so without a pin the installer requires a
 * Developer ID team shared by the app and its provider.
 */
export const NETWORK_FILTER_TEAM_ID_ENV = "AUTOMOBILE_NETWORK_FILTER_TEAM_ID";

/** The explicit, opt-in command that installs and activates the app. */
export const NETWORK_FILTER_INSTALL_COMMAND = "auto-mobile --ios-network-filter install";

export const NETWORK_FILTER_APPROVAL_STEPS =
  "Open System Settings > General > Login Items & Extensions > Network Extensions " +
  "(macOS 13 and 14: System Settings > Privacy & Security, then Allow) and enable " +
  '"AutoMobile Network Identity Probe". Allow the content filter when macOS asks, then run ' +
  `\`${NETWORK_FILTER_INSTALL_COMMAND}\` again. AutoMobile never approves the extension for you.`;

export const NETWORK_FILTER_RESTART_STEPS =
  "Restart macOS to finish installing the Network Extension, then run " +
  `\`${NETWORK_FILTER_INSTALL_COMMAND}\` again.`;

/** Final states reported by the install command (#10588). */
export type NetworkFilterInstallState =
  | "ready"
  | "approval_required"
  | "restart_required"
  | "unavailable"
  | "failed";

export function installedAppPath(installDir: string = NETWORK_FILTER_INSTALL_DIR): string {
  return path.join(installDir, NETWORK_FILTER_APP_NAME);
}

export function controllerPath(appPath: string): string {
  return path.join(appPath, NETWORK_FILTER_CONTROLLER_RELATIVE_PATH);
}

export function providerPath(appPath: string): string {
  return path.join(appPath, NETWORK_FILTER_PROVIDER_RELATIVE_PATH);
}
