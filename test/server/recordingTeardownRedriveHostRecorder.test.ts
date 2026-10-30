import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video/VideoRecorderService";
import {
  redriveUnconfirmedCaptureTeardowns,
  type RecordingTeardownRedriveDeps,
  type StartupOrphanCaptures,
} from "../../src/daemon/recordingTeardownRedrive";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { logger } from "../../src/utils/logger";

const descriptor = {
  kind: "ios-host-recorder" as const,
  hostPid: 42,
  hostStartToken: "generation-a",
  udid: "sim-id",
  capturePath: "/kept/raw.mov",
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
});

async function harness(held = false, incarnation: number | undefined = 1) {
  const timer = new FakeTimer();
  const repo = new FakeVideoRecordingRepository();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const holder = spyOn(manager, "getSessionForDevice").mockReturnValue(held ? "holder" : null);
  const mark = spyOn(manager, "markDeviceNeedsRecorderTeardown").mockReturnValue(() => {});
  const release = spyOn(manager, "onSessionDeviceUnbound");
  const sessionRelease = spyOn(manager, "onSessionRelease");
  const pending = spyOn(manager, "registerPendingDeviceCleanup");
  cleanup.push(() => {
    for (const spy of [warn, holder, mark, release, sessionRelease, pending]) {
      spy.mockRestore();
    }
    timer.reset();
  });
  await repo.insertRecording({
    recordingId: "host",
    deviceId: "sim-id",
    platform: "ios",
    status: "interrupted",
    fileName: "host.mp4",
    filePath: "/kept/host.mp4",
    format: "mp4",
    sizeBytes: 0,
    createdAt: "invalid",
    startedAt: "invalid",
    lastAccessedAt: "invalid",
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
    captureTeardown: descriptor,
  });
  let orphans!: StartupOrphanCaptures;
  const deps: RecordingTeardownRedriveDeps = {
    recordingRepository: repo,
    liveDaemonSessionIds: new Set(),
    ownedCaptureIds: () => [],
    getDevice: () => undefined,
    getDeviceIncarnation: () => incarnation,
    forceStopOrphanedCapture: async () => {},
    now: () => timer.now(),
    timer,
    onStartupOrphans: (handle) => {
      orphans = handle;
    },
  };
  const stop = spyOn(deps, "forceStopOrphanedCapture");
  cleanup.push(() => stop.mockRestore());
  const start = () => redriveUnconfirmedCaptureTeardowns(manager, deps);
  return {
    repo,
    timer,
    deps,
    mark,
    release,
    sessionRelease,
    pending,
    stop,
    start,
    orphans: () => orphans,
  };
}

test("idle startup host identity confirms immediately without a device or expiry", async () => {
  const h = await harness();
  await h.start();
  expect(h.mark).toHaveBeenCalledTimes(1);
  await h.mark.mock.calls[0]![1]!();
  expect(h.stop).toHaveBeenCalledWith(undefined, descriptor, { mode: "background" });
  expect((await h.repo.getRecording("host"))?.captureTeardown).toBeUndefined();
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("held release confirms a host descriptor while the device is absent", async () => {
  const h = await harness(true);
  await h.start();
  expect(h.stop).not.toHaveBeenCalled();
  h.release.mock.calls[0]![0]("holder", "sim-id");
  await h.pending.mock.calls[0]![1];
  expect(h.stop).toHaveBeenCalledWith(undefined, descriptor, { mode: "background" });
  expect((await h.repo.getRecording("host"))?.captureTeardown).toBeUndefined();
});

test("failed host teardown preserves its descriptor for another attempt", async () => {
  const h = await harness();
  h.stop.mockRejectedValue(new ActionableError("identity unreadable"));
  await h.start();
  await expect(h.orphans().stop("sim-id")).rejects.toBeInstanceOf(ActionableError);
  expect(h.stop).toHaveBeenCalledWith(undefined, descriptor, { mode: "user" });
  expect((await h.repo.getRecording("host"))?.captureTeardown).toEqual(descriptor);
});

test("a host orphan is redriven even without a pool incarnation", async () => {
  const h = await harness(false);
  h.deps.getDeviceIncarnation = () => undefined;
  await h.start();
  expect(h.mark).not.toHaveBeenCalled();
  await h.pending.mock.calls[0]![1];
  expect(h.stop).toHaveBeenCalledWith(undefined, descriptor, { mode: "background" });
  expect((await h.repo.getRecording("host"))?.captureTeardown).toBeUndefined();
});

test("device identity replacement still stops the independent host process", async () => {
  const h = await harness(true);
  await h.start();
  h.sessionRelease.mock.calls[0]![0]("holder", "sim-id", "idle-timeout", {
    snapshot: {
      sessionId: "holder",
      deviceId: "sim-id",
      releaseReason: "idle-timeout",
      releasedAtMs: 0,
      terminal: false,
      heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
    },
    deviceIdentityReplaced: true,
  });
  await h.pending.mock.calls[0]![1];
  expect(h.stop).toHaveBeenCalledTimes(1);
});

for (const held of [false, true]) {
  test(`unconfirmed ${held ? "release" : "health retry"} uses background and retains host identity`, async () => {
    const h = await harness(held);
    h.stop.mockRejectedValue(new ActionableError("unconfirmed"));
    await h.start();
    if (held) {
      h.release.mock.calls[0]![0]("holder", "sim-id");
      await h.pending.mock.calls[0]![1];
    } else {
      await expect(h.mark.mock.calls[0]![1]!()).rejects.toBeInstanceOf(ActionableError);
    }
    expect(h.stop).toHaveBeenCalledWith(undefined, descriptor, { mode: "background" });
    expect((await h.repo.getRecording("host"))?.captureTeardown).toEqual(descriptor);
  });
}

for (const id of [undefined, "host"]) {
  test(`caller orphan stop (${id ?? "id-less"}) uses user mode`, async () => {
    const h = await harness();
    await h.start();
    await h.orphans().stop("sim-id", id);
    expect(h.stop).toHaveBeenCalledWith(undefined, descriptor, { mode: "user" });
  });
}

test("process-start redrive uses background and retains unconfirmed host identity", async () => {
  const h = await harness(true);
  let listener!: (deviceId: string) => void | Promise<void>;
  h.deps.onDeviceProcessStarted = (callback) => {
    listener = callback;
  };
  h.stop.mockRejectedValue(new ActionableError("unconfirmed"));
  await h.start();
  await listener("sim-id");
  expect(h.stop).toHaveBeenCalledWith(undefined, descriptor, { mode: "background" });
  expect((await h.repo.getRecording("host"))?.captureTeardown).toEqual(descriptor);
});
