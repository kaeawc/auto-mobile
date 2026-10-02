import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import { ActionableError } from "../models/ActionableError";
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
  const pendingRetirements = new Map<string, Set<string>>();
  return {
    name: "recordings",
    prepareForIncarnationChange: async (deviceId) => {
      const activeRecordings = await dependencies.listActiveVideoRecordings({ deviceId });
      const pending = pendingRetirements.get(deviceId) ?? new Set<string>();
      pendingRetirements.set(deviceId, pending);
      const failures: unknown[] = [];
      for (const { recordingId } of activeRecordings) {
        pending.add(recordingId);
        const [result] = await Promise.allSettled([
          (async () => {
            await dependencies.forceStopVideoRecording(recordingId);
            await dependencies.interruptVideoRecording(recordingId);
          })(),
        ]);
        if (result.status === "rejected") {
          failures.push(result.reason);
        } else {
          pending.delete(recordingId);
        }
      }
      if (pending.size === 0) {
        pendingRetirements.delete(deviceId);
      }
      if (failures.length > 0) {
        // Preserve the original failure for the invalidator's per-listener warning.
        throw failures[0];
      }
    },
    onDeviceIncarnationChanged: async (deviceId) => {
      const pending = pendingRetirements.get(deviceId);
      pendingRetirements.delete(deviceId);
      const results = await Promise.allSettled(
        [...(pending ?? [])].map(async (id) => await dependencies.interruptVideoRecording(id)),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        // The invalidator logs this structured failure after all retirements were attempted.
        throw new ActionableError(`Failed to retire recordings after VM restore on ${deviceId}`, {
          cause: new AggregateError(failures.map((failure) => failure.reason)),
        });
      }
    },
  };
}

registerDeviceIncarnationListener(createVideoRecordingDeviceIncarnationListener());
