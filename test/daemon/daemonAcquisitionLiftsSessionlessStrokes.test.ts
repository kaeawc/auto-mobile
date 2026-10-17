import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

// #11541: the daemon's device-acquisition hook tells the socket server to lift the strokes that
// were started on the device while no session held it. The lift itself is covered against the
// real socket server in `socketServerInputSessionlessStrokeAtAcquisition.test.ts`; this pins the
// daemon's own wiring of the hook.

describe("Daemon device acquisition lifts sessionless strokes (#11541)", () => {
  const restores: Array<() => void> = [];
  let daemon: Daemon;

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
    const appearance = spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(
      undefined,
    );
    restores.push(() => appearance.mockRestore());
    daemon = new Daemon(
      {},
      {
        installedAppsRepository: new FakeInstalledAppsRepository(),
        timer: new FakeTimer(),
        deviceSessionRepository: new FakeDeviceSessionRepository(),
      },
    );
  });

  afterEach(() => {
    daemon.getSessionManager().stopCleanupTimer();
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    resetVideoRecordingManagerDependencies();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("a session acquiring a device lifts the sessionless strokes on that device", async () => {
    const lifted: string[] = [];
    daemon.setSocketServerForTesting({
      liftSessionlessStrokesOn: (deviceId) => {
        lifted.push(deviceId);
      },
    });

    await daemon.getSessionManager().createSession("new-owner", "emulator-5560", "android");

    expect(lifted).toEqual(["emulator-5560"]);
  });

  test("an acquisition before the socket server exists has no stroke to lift and succeeds", async () => {
    daemon.setSocketServerForTesting(null);

    await daemon.getSessionManager().createSession("new-owner", "emulator-5560", "android");

    expect(daemon.getSessionManager().getSessionForDevice("emulator-5560")).toBe("new-owner");
  });
});
