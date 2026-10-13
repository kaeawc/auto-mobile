import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DEFAULT_VIDEO_RECORDING_CONFIG,
  type VideoCaptureTeardownDescriptor,
} from "../../src/features/video/VideoRecorderService";
import {
  redriveUnconfirmedCaptureTeardowns,
  type RecordingTeardownRedriveDeps,
} from "../../src/server/recordingTeardownRedrive";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const DESCRIPTOR = {
  kind: "android-screenrecord" as const,
  deviceTempPath: "/sdcard/auto-mobile-orphan.mp4",
  devicePid: 42,
};
const ORPHAN_ROW = {
  recordingId: "orphan-from-previous-daemon",
  deviceId: DEVICE.deviceId,
  platform: DEVICE.platform,
  status: "interrupted" as const,
  fileName: "orphan.mp4",
  filePath: "/unused/orphan.mp4",
  format: "mp4" as const,
  sizeBytes: 0,
  createdAt: "1970-01-01T00:00:00.000Z",
  startedAt: "1970-01-01T00:00:00.000Z",
  lastAccessedAt: "1970-01-01T00:00:00.000Z",
  config: DEFAULT_VIDEO_RECORDING_CONFIG,
  captureTeardown: DESCRIPTOR,
};

describe("startup recorder redrive and a device pooled after it ran", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let markers: InMemoryDeviceHealthMarkers;
  let repo: FakeVideoRecordingRepository;
  let spies: Array<{ mockRestore(): void }>;
  let incarnation: number | undefined;
  let listener: (deviceId: string) => void;
  let kills: VideoCaptureTeardownDescriptor[];
  let owned: string[];
  let deps: RecordingTeardownRedriveDeps;

  beforeEach(() => {
    timer = new FakeTimer();
    repo = new FakeVideoRecordingRepository();
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    manager.stopCleanupTimer();
    markers = new InMemoryDeviceHealthMarkers(timer);
    incarnation = undefined;
    manager.setDeviceHealthMarkers(
      markers,
      () => incarnation,
      () => true,
    );
    spies = [spyOn(logger, "warn").mockImplementation(() => {})];
    kills = [];
    owned = [];
    deps = {
      recordingRepository: repo,
      liveDaemonSessionIds: new Set(["peer"]),
      ownedCaptureIds: () => owned,
      getDevice: () => (incarnation === undefined ? undefined : DEVICE),
      getDeviceIncarnation: () => incarnation,
      onDeviceIncarnationAssigned: (callback) => {
        listener = callback;
      },
      forceStopOrphanedCapture: async (_device, descriptor) => {
        kills.push(descriptor);
      },
      now: () => timer.now(),
      timer,
    };
  });
  afterEach(() => {
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    timer.reset();
  });
  async function start() {
    await repo.insertRecording(ORPHAN_ROW);
    expect(await redriveUnconfirmedCaptureTeardowns(manager, deps)).toBe(true);
  }
  async function step(ms = 1000) {
    await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
    await drainUntilQuiescent(timer);
  }
  function pool(next = 1) {
    incarnation = next;
    listener(DEVICE.deviceId);
  }
  const marker = () => markers.get(DEVICE.deviceId, incarnation ?? 1)?.reason;

  test("pool hook synchronously quarantines, then kills the exact orphan once", async () => {
    await start();
    expect(marker()).toBeUndefined();
    pool();
    expect(marker()).toBe("recording-teardown");
    expect(kills).toEqual([]);
    listener(DEVICE.deviceId); // Same incarnation must not register a second retry.
    await step();
    expect(kills).toEqual([DESCRIPTOR]);
    expect((await repo.getRecording(ORPHAN_ROW.recordingId))?.captureTeardown).toBeUndefined();
    expect(marker()).toBeUndefined();
  });

  test("devices without startup rows and already confirmed rows do nothing", async () => {
    await start();
    const mark = spyOn(manager, "markDeviceNeedsRecorderTeardown");
    spies.push(mark);
    listener("no-retained-rows");
    expect(mark).not.toHaveBeenCalled();
    pool();
    await step();
    mark.mockClear();
    pool(2);
    expect(mark).not.toHaveBeenCalled();
    expect(kills).toEqual([DESCRIPTOR]);
  });

  test("held late device shares one deferred subscription and marks before unconfirmed release settles", async () => {
    const holder = spyOn(manager, "getSessionForDevice").mockReturnValue("holder");
    const release = spyOn(manager, "onSessionRelease");
    const unbound = spyOn(manager, "onSessionDeviceUnbound");
    spies.push(holder, release, unbound);
    let succeeds = false;
    deps.forceStopOrphanedCapture = async (_device, descriptor) => {
      kills.push(descriptor);
      if (!succeeds) {
        throw new Error("offline");
      }
    };
    await start();
    pool();
    pool(2);
    expect(marker()).toBeUndefined();
    expect(kills).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(unbound).toHaveBeenCalledTimes(1);
    holder.mockReturnValue(null);
    unbound.mock.calls[0]![0]("holder", DEVICE.deviceId);
    await step(0);
    expect(kills).toEqual([DESCRIPTOR]);
    expect(marker()).toBe("recording-teardown");
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    succeeds = true;
    await step();
    expect(marker()).toBeUndefined();
    expect(kills).toEqual([DESCRIPTOR, DESCRIPTOR]);
  });

  test("re-pooling an unconfirmed startup device marks the new incarnation", async () => {
    incarnation = 1;
    await start();
    expect(marker()).toBe("recording-teardown");
    pool(2);
    expect(marker()).toBe("recording-teardown");
    await step();
    expect(kills).toEqual([DESCRIPTOR]);
    expect(marker()).toBeUndefined();
  });

  test("a row missing from the peer-safe re-read resolves without a command or DB write", async () => {
    await start();
    const read = spyOn(repo, "listRecordings").mockResolvedValue([]);
    const update = spyOn(repo, "updateRecording");
    spies.push(read, update);
    pool();
    expect(marker()).toBe("recording-teardown");
    await step();
    expect(read).toHaveBeenCalledWith({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: deps.liveDaemonSessionIds,
      deviceId: DEVICE.deviceId,
    });
    expect(kills).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(marker()).toBeUndefined();
    pool(2);
    expect(marker()).toBeUndefined();
  });

  test("a capture now owned locally is skipped at hook time", async () => {
    await start();
    owned = [ORPHAN_ROW.recordingId];
    pool();
    expect(marker()).toBeUndefined();
    await step();
    expect(kills).toEqual([]);
  });

  test("ownership acquired after marking is checked again before any command", async () => {
    await start();
    pool();
    owned = [ORPHAN_ROW.recordingId];
    const update = spyOn(repo, "updateRecording");
    spies.push(update);
    await step();
    expect(kills).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(marker()).toBeUndefined();
  });

  test("failed re-read retains quarantine and is retried without discovering new rows", async () => {
    await start();
    await repo.insertRecording({ ...ORPHAN_ROW, recordingId: "created-after-startup" });
    const read = spyOn(repo, "listRecordings").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    spies.push(read);
    pool();
    await step();
    expect(marker()).toBe("recording-teardown");
    expect(kills).toEqual([]);
    await step(2000);
    expect(kills).toEqual([DESCRIPTOR]);
    expect((await repo.getRecording("created-after-startup"))?.captureTeardown).toEqual(DESCRIPTOR);
    expect(marker()).toBeUndefined();
  });

  test("subscription is installed before startup read and pooling during read is handled once", async () => {
    await repo.insertRecording(ORPHAN_ROW);
    const readGate = Promise.withResolvers<void>();
    const list = repo.listRecordings.bind(repo);
    const read = spyOn(repo, "listRecordings").mockImplementation(async (query) => {
      await readGate.promise;
      return list(query);
    });
    spies.push(read);
    const startup = redriveUnconfirmedCaptureTeardowns(manager, deps);
    pool();
    readGate.resolve();
    await startup;
    expect(marker()).toBe("recording-teardown");
    listener(DEVICE.deviceId);
    await step();
    expect(kills).toEqual([DESCRIPTOR]);
    expect(marker()).toBeUndefined();
  });
});
