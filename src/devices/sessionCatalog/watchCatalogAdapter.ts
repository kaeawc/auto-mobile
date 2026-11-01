import type {
  WatchCatalogDeviceType,
  WatchCatalogRuntime,
  WatchSessionDeviceCatalog,
} from "../sessionRequirements";
import { errorMessage } from "../../utils/describeUnknownError";
import type { WatchSimulatorCatalog } from "../../utils/ios-cmdline-tools/WatchSimulatorInventory";
import { watchOsVersionFromRuntimeId } from "../../utils/ios-cmdline-tools/simulatorRuntimeFamily";
import { logger as defaultLogger } from "../../utils/logger";
import { nativeCatalogRevision } from "./revision";

const WATCH_CATALOG_SOURCE = "simctl-watch-catalog";

/** The watch catalog read; `WatchSimulatorInventory` implements it. */
export interface WatchNativeCatalogReader {
  readCatalog(signal?: AbortSignal): Promise<WatchSimulatorCatalog>;
}

export interface WatchCatalogReadOptions {
  signal?: AbortSignal;
  logger?: Pick<typeof defaultLogger, "warn">;
}

/** Projects the installed watchOS runtimes and Apple Watch device types, sorted by identifier. */
export function adaptWatchSessionDeviceCatalog(
  native: WatchSimulatorCatalog,
): WatchSessionDeviceCatalog {
  const runtimes: WatchCatalogRuntime[] = native.runtimes
    .map((runtime) => {
      const osVersion = runtime.version.trim() || watchOsVersionFromRuntimeId(runtime.identifier);
      return {
        runtime: runtime.identifier,
        ...(osVersion ? { osVersion } : {}),
        installed: runtime.isAvailable === true,
      };
    })
    .sort((a, b) => a.runtime.localeCompare(b.runtime));
  const deviceTypes: WatchCatalogDeviceType[] = native.deviceTypes
    .map((deviceType) => ({ deviceType: deviceType.identifier, name: deviceType.name }))
    .sort((a, b) => a.deviceType.localeCompare(b.deviceType));
  return {
    platform: "watchos",
    provenance: {
      source: WATCH_CATALOG_SOURCE,
      revision: nativeCatalogRevision(WATCH_CATALOG_SOURCE, { runtimes, deviceTypes }),
      state: "ready",
    },
    runtimes,
    deviceTypes,
  };
}

/**
 * Reads the host's watch catalog. No reader means the host cannot run Apple Watch simulators
 * (not macOS): the catalog is `not-installed`, a permanent answer. A failed read is `unavailable`,
 * a transient one; neither is ever reported as an empty catalog.
 */
export async function readWatchSessionDeviceCatalog(
  reader: WatchNativeCatalogReader | undefined,
  options: WatchCatalogReadOptions = {},
): Promise<WatchSessionDeviceCatalog> {
  if (!reader) {
    return {
      platform: "watchos",
      provenance: {
        source: WATCH_CATALOG_SOURCE,
        revision: "not-installed",
        state: "not-installed",
        message: "Apple Watch simulators exist only on macOS hosts with Xcode's simctl.",
      },
      runtimes: [],
      deviceTypes: [],
    };
  }
  try {
    return adaptWatchSessionDeviceCatalog(await reader.readCatalog(options.signal));
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const message = `Unable to read the Apple Watch simulator catalog: ${errorMessage(error)}`;
    (options.logger ?? defaultLogger).warn(message, error);
    return {
      platform: "watchos",
      provenance: {
        source: WATCH_CATALOG_SOURCE,
        revision: "unavailable",
        state: "unavailable",
        message,
      },
      runtimes: [],
      deviceTypes: [],
    };
  }
}
