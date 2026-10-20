import { registerDeviceLifecycleServerHost } from "../features/deviceLifecycle/deviceLifecycleServerHost";
import {
  notifyInstalledAppResourceListChanged,
  syncInstalledAppResourceRegistry,
  syncInstalledAppResources,
} from "./appResources";
import { notifyBootedDeviceResourcesUpdated } from "./bootedDeviceResources";
import { notifyDeviceImageResourcesUpdated } from "./deviceImageResources";
import { listActiveVideoRecordings, stopVideoRecording } from "../daemon/videoRecordingManager";
import { stopSegmentedVideoRecordingsForDevice } from "./videoRecordingTools";

/** Wires the server's resource and video-recording operations into the lifecycle tools. */
registerDeviceLifecycleServerHost({
  notifyBootedDeviceResourcesUpdated,
  notifyDeviceImageResourcesUpdated,
  notifyInstalledAppResourceListChanged,
  syncInstalledAppResourceRegistry,
  syncInstalledAppResources,
  listActiveVideoRecordings,
  stopVideoRecording,
  stopSegmentedVideoRecordingsForDevice,
});
