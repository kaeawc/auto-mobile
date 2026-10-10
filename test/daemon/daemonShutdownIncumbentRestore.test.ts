import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import * as daemonFilesModule from "../../src/daemon/daemonFiles";
import { DaemonState } from "../../src/daemon/daemonState";
import { IncumbentOwnerGuard } from "../../src/daemon/incumbentOwnerGuard";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";
import * as databaseModule from "../../src/db";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

// #11156: a SIGTERM during a contended start runs stop() before the socket bind
// commits. Exit cleanup is suppressed then (the contender must not delete the
// winner's files), so stop() itself must put the live incumbent's PID record back
// or the shared PID file keeps naming the exiting contender.

/** Records restore calls instead of touching the real PID file. */
class RecordingIncumbentGuard extends IncumbentOwnerGuard {
  restores = 0;

  override restoreIncumbentAfterRefusal(): boolean {
    this.restores += 1;
    return true;
  }
}

interface DaemonBindInternals {
  socketBindCommitted: boolean;
}

function daemonWith(guard: IncumbentOwnerGuard): Daemon {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new Daemon(
    {},
    new FakeInstalledAppsRepository(),
    timer,
    new FakeDeviceSessionRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    guard,
  );
}

describe("Daemon shutdown before the socket bind (#11156)", () => {
  const restores: Array<() => void> = [];

  beforeEach(async () => {
    resetDbWriteBarrier();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    for (const spy of [
      spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(undefined),
      spyOn(databaseModule, "closeDatabase").mockResolvedValue(undefined),
      spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined),
      spyOn(daemonFilesModule, "cleanupDaemonFiles").mockResolvedValue(false),
    ]) {
      restores.push(() => spy.mockRestore());
    }
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    resetVideoRecordingManagerDependencies();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("restores the displaced incumbent's PID record when stopped before the bind", async () => {
    const guard = new RecordingIncumbentGuard();
    const daemon = daemonWith(guard);

    await daemon.stop();

    expect(guard.restores).toBe(1);
  });

  test("leaves the PID record alone once this daemon committed the socket bind", async () => {
    const guard = new RecordingIncumbentGuard();
    const daemon = daemonWith(guard);
    (daemon as unknown as DaemonBindInternals).socketBindCommitted = true;

    await daemon.stop();

    expect(guard.restores).toBe(0);
  });
});
