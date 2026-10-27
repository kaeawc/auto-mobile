/** Session cleanup only needs ownership and finalization, not the MCP video tools. */
export interface SegmentedRecordingCleanup {
  adoptOwnerlessSegmentedVideoRecordings(deviceId: string, sessionUuid: string): void;
  hasSegmentedVideoRecordingsForOwner(sessionUuid: string | undefined, deviceId: string): boolean;
  segmentedVideoRecordingHandlesForOwner(
    sessionUuid: string | undefined,
    deviceId: string,
  ): string[];
  captureSegmentedRecordingIdsForOwner(
    sessionUuid: string | undefined,
    deviceId: string,
  ): () => readonly string[];
  stopSegmentedVideoRecordingsForOwner(
    sessionUuid: string | undefined,
    deviceId: string,
  ): Promise<void>;
  finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice(
    sessionUuid: string,
    deviceId: string,
  ): Promise<void>;
}

// No segmented sessions exist until the server-side registry loads and registers its operations.
let cleanup: SegmentedRecordingCleanup = {
  adoptOwnerlessSegmentedVideoRecordings: () => {},
  hasSegmentedVideoRecordingsForOwner: () => false,
  segmentedVideoRecordingHandlesForOwner: () => [],
  captureSegmentedRecordingIdsForOwner: () => () => [],
  stopSegmentedVideoRecordingsForOwner: async () => {},
  finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice: async () => {},
};

export function registerSegmentedRecordingCleanup(next: SegmentedRecordingCleanup): () => void {
  const previous = cleanup;
  cleanup = next;
  return () => {
    cleanup = previous;
  };
}

/** Resolve at call time, including for cleanup dependencies created before server registration. */
export const segmentedRecordingCleanup: SegmentedRecordingCleanup = {
  adoptOwnerlessSegmentedVideoRecordings: (...args) =>
    cleanup.adoptOwnerlessSegmentedVideoRecordings(...args),
  hasSegmentedVideoRecordingsForOwner: (...args) =>
    cleanup.hasSegmentedVideoRecordingsForOwner(...args),
  segmentedVideoRecordingHandlesForOwner: (...args) =>
    cleanup.segmentedVideoRecordingHandlesForOwner(...args),
  captureSegmentedRecordingIdsForOwner: (...args) =>
    cleanup.captureSegmentedRecordingIdsForOwner(...args),
  stopSegmentedVideoRecordingsForOwner: (...args) =>
    cleanup.stopSegmentedVideoRecordingsForOwner(...args),
  finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice: (...args) =>
    cleanup.finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice(...args),
};
