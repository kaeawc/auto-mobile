import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice, DeviceInfo } from "../../models";
import type { ListInstalledApps } from "../observe/ListInstalledApps";

/** Narrow surface the installed-app resource sync needs from `ListInstalledApps`. */
export type InstalledAppsLister = Pick<
  ListInstalledApps,
  "executeDetailedResult" | "executeIosDetailedResult"
>;

export interface AppResourceDependencies {
  listInstalledAppsFactory?: (device: BootedDevice) => InstalledAppsLister;
}

/**
 * What the device lifecycle tools need from the MCP server tier: refreshing the resources a
 * device change invalidates, and stopping video recordings a device shutdown would orphan. The
 * features tier owns this interface; the server implements it (`server/deviceLifecycleHost`) and
 * registers it with {@link registerDeviceLifecycleServerHost} when the lifecycle tools load.
 */
export interface DeviceLifecycleServerHost {
  notifyBootedDeviceResourcesUpdated(): Promise<void>;
  notifyDeviceImageResourcesUpdated(): Promise<void>;
  notifyInstalledAppResourceListChanged(): Promise<void>;
  syncInstalledAppResourceRegistry(deps?: AppResourceDependencies): Promise<boolean>;
  syncInstalledAppResources(deps?: AppResourceDependencies): Promise<void>;
  listActiveVideoRecordings(filter: {
    deviceId?: string;
    platform?: "android" | "ios";
  }): Promise<ReadonlyArray<{ readonly recordingId: string }>>;
  stopVideoRecording(recordingId?: string): Promise<unknown>;
  stopSegmentedVideoRecordingsForDevice(
    device: Pick<DeviceInfo, "platform" | "name" | "deviceId">,
  ): Promise<void>;
}

let registered: DeviceLifecycleServerHost | undefined;

/** Returns the previously registered host so callers (tests) can restore it. */
export function registerDeviceLifecycleServerHost(
  host: DeviceLifecycleServerHost | undefined,
): DeviceLifecycleServerHost | undefined {
  const previous = registered;
  registered = host;
  return previous;
}

function current(): DeviceLifecycleServerHost {
  if (!registered) {
    throw new ActionableError(
      "No device lifecycle server host is registered; the MCP device tools have not been loaded.",
    );
  }
  return registered;
}

/** Resolves the registered host on every call, so it works for code that loaded first. */
export const deviceLifecycleServerHost: DeviceLifecycleServerHost = {
  notifyBootedDeviceResourcesUpdated: async () => current().notifyBootedDeviceResourcesUpdated(),
  notifyDeviceImageResourcesUpdated: async () => current().notifyDeviceImageResourcesUpdated(),
  notifyInstalledAppResourceListChanged: async () =>
    current().notifyInstalledAppResourceListChanged(),
  syncInstalledAppResourceRegistry: async (deps) =>
    current().syncInstalledAppResourceRegistry(deps),
  syncInstalledAppResources: async (deps) => current().syncInstalledAppResources(deps),
  listActiveVideoRecordings: async (filter) => current().listActiveVideoRecordings(filter),
  stopVideoRecording: async (recordingId) => current().stopVideoRecording(recordingId),
  stopSegmentedVideoRecordingsForDevice: async (device) =>
    current().stopSegmentedVideoRecordingsForDevice(device),
};
