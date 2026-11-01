import {
  readAndroidSessionDeviceCatalog,
  readIosSessionDeviceCatalog,
  readWatchSessionDeviceCatalog,
} from "../../devices/sessionCatalog";
import { WatchSimulatorInventory } from "../../utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  listDevices,
  listInstalledSystemImages,
} from "../../utils/android-cmdline-tools/avdmanager";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { SessionCatalogPlatform } from "./brokerOptions";
import type { SessionDeviceCatalog } from "../../devices/sessionRequirements";
import type { SessionBrokerHostConfig } from "./hostConfig";

export function nativeCatalogReader(config: SessionBrokerHostConfig) {
  const ios = new SimCtlClient(null);
  // Apple Watch simulators exist only where simctl does; elsewhere the catalog is not installed.
  const watches = process.platform === "darwin" ? new WatchSimulatorInventory(ios) : undefined;
  return (
    platform: SessionCatalogPlatform,
    signal?: AbortSignal,
  ): Promise<SessionDeviceCatalog> => {
    if (platform === "watchos") {
      return readWatchSessionDeviceCatalog(watches, { signal });
    }
    if (platform === "ios") {
      return readIosSessionDeviceCatalog(ios, {
        signal,
        classifications: config.iosClassifications,
      });
    }
    return readAndroidSessionDeviceCatalog(
      {
        listDevices: (signal) => listDevices(undefined, signal),
        listInstalledSystemImages: (filter, signal) =>
          listInstalledSystemImages(filter, undefined, signal),
      },
      { profileArchetypes: config.androidProfileArchetypes },
      { signal },
    );
  };
}
