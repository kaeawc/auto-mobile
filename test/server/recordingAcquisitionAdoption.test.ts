import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { announceSessionRelease } from "../../src/daemon/announceSessionRelease";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { VideoRecorderService } from "../../src/features/video";
import type { BootedDevice } from "../../src/models";
import {
  createOwnerlessRecordingAcquisitionCleanup,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
} from "../../src/daemon/recordingSessionCleanup";
import {
  adoptOwnerlessActiveVideoRecordings,
  getVideoRecordingMetadata,
  listActiveVideoRecordingIdsForOwner,
  listActiveVideoRecordings,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../src/daemon/videoRecordingManager";
import {
  hasSegmentedVideoRecordingsForOwner,
  resetSegmentedSessions,
  setSegmentedSessionTimer,
} from "../../src/server/videoRecordingTools";
import { getVideoArchiveItem } from "../../src/server/videoRecordingResources";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { createVideoRecordingToolsHarness } from "../helpers/videoRecordingToolsHarness";
import { toolIsError, toolText } from "../helpers/toolResponse";

const videoRecording = createVideoRecordingToolsHarness();

isolateToolRegistry();
const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "SlotDevice" };
const free: BootedDevice = { ...device, deviceId: "emulator-5556", name: "Free" };

class DeferredOwnershipRepository extends FakeVideoRecordingRepository {
  gate: Promise<void> | undefined;
  rejectedUpdatesRemaining = 0;
  ownershipUpdates = 0;
  override async updateRecording(
    recordingId: string,
    update: Parameters<FakeVideoRecordingRepository["updateRecording"]>[1],
  ): Promise<void> {
    if (update.ownerSessionUuid !== undefined) {
      this.ownershipUpdates += 1;
      if (this.rejectedUpdatesRemaining > 0) {
        this.rejectedUpdatesRemaining -= 1;
        throw new Error("ownership write unavailable");
      }
    }
    if (update.ownerSessionUuid !== undefined && this.gate) {
      await this.gate;
    }
    await super.updateRecording(recordingId, update);
  }
}

describe("ownerless recording acquisition adoption", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let repository: DeferredOwnershipRepository;
  let backend: FakeVideoCaptureBackend;
  let acquisitions: string[];
  let connectionOwner: string | undefined;
  const archiveRoot = path.join(os.tmpdir(), "auto-mobile-adoption-fake");
  const handler = () => ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;

  async function arrangeHarness(): Promise<void> {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [device, free];
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "adoption", {
        timer,
        deviceManager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([device, free]);
    repository = new DeferredOwnershipRepository();
    backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    await setVideoRecordingManagerDependencies({
      recordingRepository: repository,
      configRepository: new FakeVideoRecordingConfigRepository(),
      videoRecorderService: new VideoRecorderService({
        backend,
        archiveRoot,
        idGenerator: new FakeIdGenerator(),
        securePermissions: new FakeSecurePermissions(false),
        now: () => new Date(timer.now()),
      }),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
      statFileSize: async () => 10,
      retentionPolicy: { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 15_000 },
    });
    acquisitions = [];
    const adopt = createOwnerlessRecordingAcquisitionCleanup(manager);
    manager.setDeviceAcquisitionExecutionCanceller((id, session) => {
      acquisitions.push(session);
      adopt(id, session);
    });
    registerRecordingSessionCleanup(manager);
    connectionOwner = undefined;
    videoRecording.configure({
      requesterResolver: {
        baseSessionUuid: (id) => id,
        isDeviceHeld: (id) => manager.getSessionForDevice(id) !== null,
        connectionOwnsDeviceSession: (connection, id, owner) =>
          connection === connectionOwner && manager.getSessionForDevice(id) === owner,
        holdingSessionUuid: (id) => manager.getSessionForDevice(id) ?? undefined,
        resolveOwnedDeviceSessionForMcpSession: (connection, id) =>
          connection === connectionOwner
            ? (manager.getSessionForDevice(id) ?? undefined)
            : undefined,
      },
    });
    const detector = new FakeDeviceReadiness();
    detector.setConnectedDevices([device, free]);
    videoRecording.configure({ deviceDetector: detector });
    setSegmentedSessionTimer(timer);
    if (!ToolRegistry.getTool("videoRecording")) {
      videoRecording.register();
    }
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  function arrangedEach<T>(table: readonly T[]) {
    return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
      test.each([...table])(
        name,
        async (row: T) => {
          await arrangeHarness();
          await fn(row);
        },
        timeout,
      );
    };
  }

  afterEach(() => {
    manager.stopCleanupTimer();
    resetSegmentedSessions();
    resetVideoRecordingManagerDependencies();
    videoRecording.clear();
    for (const id of acquisitions) {
      takeRecordingIdsFinalizedByRelease(id);
    }
    timer.reset();
  });

  arranged(
    "acquisition retries a rejected ownership write once before completing cleanup",
    async () => {
      const recording = await startVideoRecording({ device });
      repository.rejectedUpdatesRemaining = 1;
      await manager.createSession("holder", device.deviceId, "android");
      await manager.drainPendingDeviceCleanups(1_000);
      expect(repository.ownershipUpdates).toBe(2);
      expect((await repository.getRecording(recording.recordingId))?.ownerSessionUuid).toBe(
        "holder",
      );
      expect(
        await repository.getRecording(recording.recordingId, { ownerSessionUuid: "other" }),
      ).toBeNull();
      expect(backend.stopCalls).toEqual([]);
    },
  );

  arranged("two pool acquisitions race: only the committed winner adopts", async () => {
    const recording = await startVideoRecording({ device });
    const results = await Promise.allSettled([
      pool.bindOrReuseDeviceSession({
        sessionId: "first",
        deviceId: device.deviceId,
        platform: "android",
        allowSessionRebind: false,
        mcpSessionId: "connection-first",
      }),
      pool.bindOrReuseDeviceSession({
        sessionId: "second",
        deviceId: device.deviceId,
        platform: "android",
        allowSessionRebind: false,
        mcpSessionId: "connection-second",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const holder = manager.getSessionForDevice(device.deviceId)!;
    expect(acquisitions).toEqual([holder]);
    expect(listActiveVideoRecordingIdsForOwner(holder, device.deviceId)).toEqual([
      recording.recordingId,
    ]);
    expect(listActiveVideoRecordingIdsForOwner(undefined, device.deviceId)).toEqual([]);
    expect((await repository.getRecording(recording.recordingId))?.ownerSessionUuid).toBe(holder);
    expect(backend.stopCalls).toEqual([]);
  });

  arranged(
    "only active ownerless captures change; finished and already owned rows stay unchanged",
    async () => {
      const active = await startVideoRecording({ device });
      const original = (await repository.getRecording(active.recordingId))!;
      await repository.insertRecording({
        ...original,
        recordingId: "finished",
        status: "completed",
      });
      const owned = await startVideoRecording({ device: free, ownerSessionUuid: "other" });
      await manager.createSession("holder", device.deviceId, "android");
      expect((await repository.getRecording(active.recordingId))?.ownerSessionUuid).toBe("holder");
      expect((await repository.getRecording("finished"))?.ownerSessionUuid).toBeUndefined();
      expect((await repository.getRecording(owned.recordingId))?.ownerSessionUuid).toBe("other");
      expect(adoptOwnerlessActiveVideoRecordings(device.deviceId, "next")).toBeUndefined();
      expect(backend.stopCalls).toEqual([]);
    },
  );

  arrangedEach(["holder", "connection"])(
    "adoption refuses sessionless stop and admits the %s",
    async (requester) => {
      const recording = await startVideoRecording({ device });
      await manager.createSession("holder", device.deviceId, "android");
      await expect(
        handler()(device, { action: "stop", recordingId: recording.recordingId }),
      ).rejects.toMatchObject({ code: "device_owned_by_other_session" });
      expect(backend.stopCalls).toEqual([]);
      connectionOwner = "acquiring-connection";
      const response = await handler()(device, {
        action: "stop",
        recordingId: recording.recordingId,
        ...(requester === "holder"
          ? { sessionUuid: "holder" }
          : { __mcpSessionId: connectionOwner }),
      });
      expect(toolIsError(response)).not.toBe(true);
      expect(backend.stopCalls.map((call) => call.recordingId)).toEqual([recording.recordingId]);
    },
  );

  arranged("ownership gates and release ids see adoption before persistence settles", async () => {
    const recording = await startVideoRecording({ device });
    const update = Promise.withResolvers<void>();
    repository.gate = update.promise;
    await manager.createSession("holder", device.deviceId, "android");
    try {
      await expect(
        handler()(device, { action: "stop", recordingId: recording.recordingId }),
      ).rejects.toMatchObject({ code: "device_owned_by_other_session" });
      expect(listActiveVideoRecordingIdsForOwner("holder", device.deviceId)).toEqual([
        recording.recordingId,
      ]);
      const releasing = manager.releaseSession("holder");
      await releasing;
      await drainUntil(() => backend.stopCalls.length === 1, {
        description: "adopted release stop",
      });
      expect(takeRecordingIdsFinalizedByRelease("holder")).toEqual([recording.recordingId]);
      expect(backend.stopCalls.map((call) => call.recordingId)).toEqual([recording.recordingId]);
      expect(manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(true);
    } finally {
      update.resolve();
      await manager.drainPendingDeviceCleanups(1_000);
    }
    expect((await repository.getRecording(recording.recordingId))?.ownerSessionUuid).toBe("holder");
  });

  arranged(
    "release announces adopted ids, finalizes them, and the artifact is fetchable by id after handoff",
    async () => {
      const recording = await startVideoRecording({ device });
      await manager.createSession("holder", device.deviceId, "android");
      const announced: string[][] = [];
      manager.onSessionRelease((id, _deviceId, reason, snapshot) => {
        announceSessionRelease(
          {
            takeRecordingIds: takeRecordingIdsFinalizedByRelease,
            emit: (_session, _reason, _snapshot, extras) => {
              announced.push(extras?.recordingIds ?? []);
            },
          },
          { fallbacks: null, announced: null },
          id,
          reason,
          snapshot,
        );
      });
      await manager.releaseSession("holder");
      await manager.drainPendingDeviceCleanups(1_000);
      expect(announced).toEqual([[recording.recordingId]]);
      expect(takeRecordingIdsFinalizedByRelease("holder")).toEqual([]);
      expect((await repository.getRecording(recording.recordingId))?.status).toBe("completed");
      expect((await repository.getRecording(recording.recordingId))?.ownerSessionUuid).toBe(
        "holder",
      );
      await manager.createSession("next", device.deviceId, "android");
      expect(listActiveVideoRecordingIdsForOwner("next", device.deviceId)).toEqual([]);
      const fetched = await getVideoArchiveItem(
        { recordingId: recording.recordingId },
        {
          archiveRoot,
          getById: (id) => getVideoRecordingMetadata(id, { ownerSessionUuid: "holder" }),
          lookupLatest: async () => ({ recording: null }),
          list: async () => [],
          readFile: async (file) => {
            expect(file).toBe(recording.outputPath);
            return Buffer.from("recorded-video");
          },
        },
      );
      expect(fetched.blob).toBe(Buffer.from("recorded-video").toString("base64"));
    },
  );

  arranged("sessionless recording remains stoppable before any acquisition", async () => {
    const recording = await startVideoRecording({ device });
    await handler()(device, { action: "stop", recordingId: recording.recordingId });
    expect(await listActiveVideoRecordings()).toEqual([]);
    expect(acquisitions).toEqual([]);
  });

  arranged(
    "a nested bare start resolves the real pool's acquiring connection for every held target",
    async () => {
      const connection = "nested-connection";
      const owner = await pool.bindOrReuseDeviceSession({
        sessionId: "holder",
        deviceId: device.deviceId,
        platform: "android",
        allowSessionRebind: false,
        mcpSessionId: connection,
      });
      const otherOwner = await pool.bindOrReuseDeviceSession({
        sessionId: "second-holder",
        deviceId: free.deviceId,
        platform: "android",
        allowSessionRebind: false,
        mcpSessionId: connection,
      });
      videoRecording.configure({
        requesterResolver: {
          baseSessionUuid: (id) => id,
          isDeviceHeld: (id) => manager.getSessionForDevice(id) !== null,
          holdingSessionUuid: (id) => manager.getSessionForDevice(id) ?? undefined,
          connectionOwnsDeviceSession: (requester, id, holder) =>
            pool.resolveOwnedDeviceSessionForMcpSession(requester, id) === holder,
          resolveOwnedDeviceSessionForMcpSession: (requester, id) =>
            pool.resolveOwnedDeviceSessionForMcpSession(requester, id),
        },
      });
      const response = await runWithToolSelectionContext({ callerMcpSessionId: connection }, () =>
        handler()(free, { action: "start", maxDuration: 300 }),
      );
      expect(JSON.parse(toolText(response)).count).toBe(2);
      expect(listActiveVideoRecordingIdsForOwner(owner, device.deviceId)).toHaveLength(1);
      expect(hasSegmentedVideoRecordingsForOwner(owner, device.deviceId)).toBe(true);
      expect(listActiveVideoRecordingIdsForOwner(undefined, device.deviceId)).toEqual([]);
      expect(listActiveVideoRecordingIdsForOwner(otherOwner, free.deviceId)).toHaveLength(1);
      expect(hasSegmentedVideoRecordingsForOwner(otherOwner, free.deviceId)).toBe(true);
      expect(listActiveVideoRecordingIdsForOwner(owner, free.deviceId)).toEqual([]);
      expect(listActiveVideoRecordingIdsForOwner(undefined, free.deviceId)).toEqual([]);
    },
  );

  for (const maxDuration of [60, 300]) {
    for (const resolved of [device, free]) {
      arranged(
        `holder connection bare ${maxDuration > 180 ? "segmented" : "plain"} start owns its ${resolved === device ? "registry" : "fan-out"} target through release`,
        async () => {
          await manager.createSession("holder", device.deviceId, "android");
          connectionOwner = "acquiring-connection";
          const response = await handler()(resolved, {
            action: "start",
            maxDuration,
            __mcpSessionId: connectionOwner,
          });
          const started = JSON.parse(toolText(response));
          const recordingId: string = started.recordings.find(
            (record: { deviceId: string }) => record.deviceId === device.deviceId,
          ).recordingId;
          expect(started.count).toBe(2);
          expect((await repository.getRecording(recordingId))?.ownerSessionUuid).toBe("holder");
          expect(listActiveVideoRecordingIdsForOwner(undefined, device.deviceId)).toEqual([]);
          if (maxDuration > 180) {
            expect(hasSegmentedVideoRecordingsForOwner("holder", device.deviceId)).toBe(true);
            expect(hasSegmentedVideoRecordingsForOwner(undefined, device.deviceId)).toBe(false);
          }
          for (const sessionUuid of ["stranger", undefined]) {
            await expect(
              handler()(device, { action: "stop", recordingId, sessionUuid }),
            ).rejects.toMatchObject({ code: "device_owned_by_other_session" });
          }
          expect(backend.stopCalls).toEqual([]);
          const announced: string[][] = [];
          manager.onSessionRelease((id, _deviceId, reason, snapshot) => {
            announceSessionRelease(
              {
                takeRecordingIds: takeRecordingIdsFinalizedByRelease,
                emit: (_session, _reason, _snapshot, extras) => {
                  announced.push(extras?.recordingIds ?? []);
                },
              },
              { fallbacks: null, announced: null },
              id,
              reason,
              snapshot,
            );
          });
          await manager.releaseSession("holder");
          await manager.drainPendingDeviceCleanups(1_000);
          expect(announced).toEqual([[recordingId]]);
          expect(backend.stopCalls.map((call) => call.recordingId)).toEqual([recordingId]);
          expect((await repository.getRecording(recordingId))?.status).toBe("completed");
          expect(await listActiveVideoRecordings({ deviceId: device.deviceId })).toEqual([]);
          expect(hasSegmentedVideoRecordingsForOwner("holder", device.deviceId)).toBe(false);
          await manager.createSession("next", device.deviceId, "android");
          expect(listActiveVideoRecordingIdsForOwner("next", device.deviceId)).toEqual([]);
          expect(hasSegmentedVideoRecordingsForOwner("next", device.deviceId)).toBe(false);
          expect((await repository.getRecording(recordingId))?.ownerSessionUuid).toBe("holder");
          // The same fan-out still creates an ownerless capture on the unheld device.
          expect(listActiveVideoRecordingIdsForOwner(undefined, free.deviceId)).toHaveLength(1);
        },
      );
    }
  }

  arranged(
    "between holder publication and adoption, existing sessionless fan-out admission refuses a start",
    async () => {
      const adopt = createOwnerlessRecordingAcquisitionCleanup(manager);
      let inWindow: Promise<unknown> | undefined;
      manager.setDeviceAcquisitionExecutionCanceller((id, session) => {
        inWindow = handler()(free, { action: "start", platform: "android" });
        adopt(id, session);
      });
      await manager.createSession("holder", device.deviceId, "android");
      await inWindow;
      expect(await listActiveVideoRecordings({ deviceId: device.deviceId })).toEqual([]);
      expect(listActiveVideoRecordingIdsForOwner(undefined, device.deviceId)).toEqual([]);
      expect(backend.startCalls.map((call) => call.device?.deviceId)).not.toContain(
        device.deviceId,
      );
    },
  );

  arranged(
    "same-device restart rebind adopts nothing new and retains unbound callback ordering",
    async () => {
      await manager.createSession("holder", device.deviceId, "android");
      const events: string[] = [];
      manager.setDeviceAcquisitionExecutionCanceller(() => {
        events.push("acquire");
      });
      manager.onSessionDeviceUnbound(() => {
        events.push("unbound");
      });
      await manager.rebindSession("holder", device.deviceId, "android", { force: true });
      expect(events).toEqual(["unbound"]);
      expect(acquisitions).toEqual(["holder"]);
      await manager.rebindSession("holder", free.deviceId, "android");
      expect(events).toEqual(["unbound", "acquire", "unbound"]);
    },
  );

  arranged(
    "a broker-binding execution session passed to the acquisition hook becomes the owner",
    async () => {
      const recording = await startVideoRecording({ device });
      const execution = "managed-execution:slot-0";
      await pool.bindOrReuseDeviceSession({
        sessionId: execution,
        deviceId: device.deviceId,
        platform: "android",
      });
      await manager.adoptManagedExecutionLivenessPolicy(execution);
      expect(acquisitions).toEqual([execution]);
      expect(listActiveVideoRecordingIdsForOwner(execution, device.deviceId)).toEqual([
        recording.recordingId,
      ]);
      expect(listActiveVideoRecordingIdsForOwner(undefined, device.deviceId)).toEqual([]);
      expect(backend.stopCalls).toEqual([]);
    },
  );

  arranged(
    "the segmented registry adopts its session and current capture without stopping rotation",
    async () => {
      const response = await handler()(device, {
        action: "start",
        maxDuration: 181,
        platform: "android",
      });
      const handle: string = JSON.parse(toolText(response)).recordings[0].recordingId;
      expect(hasSegmentedVideoRecordingsForOwner(undefined, device.deviceId)).toBe(true);
      await manager.createSession("holder", device.deviceId, "android");
      expect(hasSegmentedVideoRecordingsForOwner(undefined, device.deviceId)).toBe(false);
      expect(hasSegmentedVideoRecordingsForOwner("holder", device.deviceId)).toBe(true);
      expect((await repository.getRecording(handle))?.ownerSessionUuid).toBe("holder");
      await expect(
        handler()(device, { action: "stop", recordingId: handle }),
      ).rejects.toMatchObject({
        code: "device_owned_by_other_session",
      });
      expect(backend.stopCalls).toEqual([]);
    },
  );
});
