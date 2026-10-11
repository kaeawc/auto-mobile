import { spyOn } from "bun:test";
import * as daemonFilesModule from "../../src/daemon/daemonFiles";
import * as databaseModule from "../../src/db";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

/**
 * Replace every file and database seam `Daemon.stop()` reaches with a fake, so no shutdown stage
 * awaits real I/O. A stage deadline runs on the test's FakeTimer: a stage waiting on a real file
 * or socket would be abandoned by fake time passing, or not, depending on the event loop.
 *
 * Faked: the pid/socket file removal, the database close, the log flush, and the recording
 * repository the capture-cleanup stage queries. A test that asserts on one of these installs its
 * own spy over the fake as usual. Returns the restore function for `afterEach`.
 */
export async function fakeDaemonShutdownIo(): Promise<() => void> {
  await setVideoRecordingManagerDependencies({
    videoRecorderService: { listActiveRecordingIds: () => [] } as never,
    recordingRepository: new FakeVideoRecordingRepository() as never,
    configRepository: {} as never,
    highlightClient: {} as never,
    timer: new FakeTimer(),
    now: () => new Date(0),
  });
  const spies = [
    spyOn(daemonFilesModule, "cleanupDaemonFiles").mockResolvedValue(true),
    spyOn(databaseModule, "closeDatabase").mockResolvedValue(undefined),
    spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined),
  ];
  return () => {
    for (const spy of spies.toReversed()) {
      spy.mockRestore();
    }
    resetVideoRecordingManagerDependencies();
  };
}
