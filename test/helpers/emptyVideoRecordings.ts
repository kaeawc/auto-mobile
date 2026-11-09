import { setVideoRecordingManagerDependencies } from "../../src/daemon/videoRecordingManager";
import type { Timer } from "../../src/utils/SystemTimer";

/**
 * Shutdown looks up a device's active recordings; answer from an empty in-memory repository so the
 * real file-backed DB is never resolved. `restartStopHarness` resets these dependencies per test.
 */
export async function useEmptyVideoRecordings(timer: Timer): Promise<void> {
  await setVideoRecordingManagerDependencies({
    videoRecorderService: {} as never,
    recordingRepository: { listRecordings: async () => [] } as never,
    configRepository: {} as never,
    highlightClient: {} as never,
    timer,
    now: () => new Date(0),
  });
}
