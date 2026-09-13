import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import {
  registerDeviceIncarnationListener,
  type DeviceIncarnationListener,
} from "../utils/deviceIncarnation";
import {
  forceStopVideoRecording,
  interruptVideoRecording,
  listActiveVideoRecordings,
} from "./videoRecordingManager";

export interface VideoRecordingIncarnationDependencies {
  listActiveVideoRecordings(filter: { deviceId: string }): Promise<VideoRecordingRecord[]>;
  forceStopVideoRecording(recordingId: string): Promise<void>;
  interruptVideoRecording(recordingId: string): Promise<void>;
}

const defaultDependencies: VideoRecordingIncarnationDependencies = {
  listActiveVideoRecordings,
  forceStopVideoRecording,
  interruptVideoRecording,
};

/** Creates the listener that retires captures before a VM load rewinds their guest process. */
export function createVideoRecordingDeviceIncarnationListener(
  dependencies: VideoRecordingIncarnationDependencies = defaultDependencies,
): DeviceIncarnationListener {
  return {
    name: "recordings",
    prepareForIncarnationChange: async (deviceId) => {
      const activeRecordings = await dependencies.listActiveVideoRecordings({ deviceId });
      for (const recording of activeRecordings) {
        await dependencies.forceStopVideoRecording(recording.recordingId);
        await dependencies.interruptVideoRecording(recording.recordingId);
      }
    },
    onDeviceIncarnationChanged: () => {},
  };
}

registerDeviceIncarnationListener(createVideoRecordingDeviceIncarnationListener());
