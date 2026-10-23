import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  opaqueForcesFallback,
  type DeviceMutationEntry,
  type DeviceMutationInput,
  type DeviceMutationScope,
} from "../../src/daemon/sessionBroker/mutations/types";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { stageSessionDownloadsAsPutAppFile } from "../../src/server/deviceMutationDataAdapters";
import { createDownloadsFixtureService } from "../../src/server/downloadsFixtureService";
import type { ActiveSessionDevice } from "../../src/server/activeSessionDevice";
import type { SharedStorageService } from "../../src/server/sharedStorageService";
import type { StageSharedStorageResult } from "../../src/server/sharedStorageContract";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";

const ANDROID: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
const IOS: BootedDevice = { ...ANDROID, platform: "ios" };
const SCOPE = { sessionUuid: "broker", deviceId: "phone", incarnation: "native-1" };
const APP = "com.example";

const broadcast = (extra: Record<string, unknown> = {}) => ({
  appId: APP,
  intent: { action: "com.example.SEED" },
  ...extra,
});

describe("sendBroadcast mutation identity", () => {
  test("is a fallback-forcing opaque intent keyed by app, user, action and component", () => {
    const [intent, ...rest] = deviceToolMutations("sendBroadcast", broadcast(), "android");
    expect(rest).toEqual([]);
    expect(intent.kind).toBe("opaque");
    expect(opaqueForcesFallback(intent)).toBe(true);
    const key = (args: Record<string, unknown>) =>
      deviceToolMutations("sendBroadcast", args, "android")[0].key;
    for (const change of [
      broadcast({ appId: "com.other" }),
      broadcast({ userId: 10 }),
      broadcast({ intent: { action: "com.example.OTHER" } }),
      broadcast({ intent: { action: "com.example.SEED", component: ".Receiver" } }),
    ]) {
      expect(key(change)).not.toBe(intent.key);
    }
  });

  test("waitForResult and extras only shape the report, not the identity", () => {
    const plain = deviceToolMutations("sendBroadcast", broadcast(), "android");
    expect(
      deviceToolMutations(
        "sendBroadcast",
        {
          ...broadcast({ waitForResult: false }),
          intent: {
            action: "com.example.SEED",
            extras: [{ key: "k", type: "string", value: "v" }],
          },
        },
        "android",
      ),
    ).toEqual(plain);
  });

  test("iOS has no broadcast intents and records nothing", () => {
    expect(deviceToolMutations("sendBroadcast", broadcast(), "ios")).toEqual([]);
  });
});

describe("backgroundWork mutation identity", () => {
  const work = (action: unknown, extra: Record<string, unknown> = {}) =>
    deviceToolMutations("backgroundWork", { appId: APP, action, ...extra }, "android");

  test("list and listAlarms only read dumpsys and record nothing", () => {
    expect(work("list")).toEqual([]);
    expect(work({ listAlarms: true })).toEqual([]);
  });

  test("runJob is a fallback-forcing opaque intent per app, user and job target", () => {
    const [job] = work({ runJob: { jobId: 7 } });
    expect(opaqueForcesFallback(job)).toBe(true);
    expect(work({ runJob: { jobId: 7, force: true } })).toEqual([job]);
    expect(work({ runJob: { jobId: 8 } })[0].key).not.toBe(job.key);
    expect(work({ runJob: { worker: "SyncWorker" } })[0].key).not.toBe(job.key);
    expect(work({ runJob: { jobId: 7 } }, { userId: 10 })[0].key).not.toBe(job.key);
    expect(work({ runJob: { jobId: 7 } }, { appId: "com.other" })[0].key).not.toBe(job.key);
  });

  test("workManagerDiagnostics leaves a breadcrumb that does not force the fallback reset", () => {
    const [diagnostics, ...rest] = work({ workManagerDiagnostics: true });
    expect(rest).toEqual([]);
    expect(diagnostics.kind).toBe("opaque");
    expect(opaqueForcesFallback(diagnostics)).toBe(false);
  });

  test("iOS has no JobScheduler and records nothing", () => {
    expect(
      deviceToolMutations(
        "backgroundWork",
        { appId: APP, action: { runJob: { jobId: 7 } } },
        "ios",
      ),
    ).toEqual([]);
  });
});

describe("recorded opaque intents", () => {
  test("record with an unobservable prior and the invoking tool name", async () => {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, SCOPE),
    );
    await recording.beforeToolCall("sendBroadcast", broadcast(), ANDROID, "broker");
    await recording.beforeToolCall(
      "backgroundWork",
      { appId: APP, action: { runJob: { jobId: 7 } } },
      ANDROID,
      "broker",
    );
    const entries = await journal.list(SCOPE);
    expect(entries.map((entry) => entry.toolName)).toEqual(["sendBroadcast", "backgroundWork"]);
    for (const entry of entries) {
      expect(entry.priorValue).toEqual({ state: "unobservable" });
      expect(opaqueForcesFallback(entry)).toBe(true);
    }
  });
});

describe("stageSessionDownloads mutation identity", () => {
  const files = [{ destinationPath: "docs/a.txt", contentText: "x" }];
  const asPutAppFile = (request: Parameters<typeof stageSessionDownloadsAsPutAppFile>[0]) =>
    deviceToolMutations("putAppFile", stageSessionDownloadsAsPutAppFile(request), "android");

  test("journals the shared-file and media intents putAppFile journals for the same directory", () => {
    expect(asPutAppFile({ directory: "run-1", reset: true, indexMedia: true, files })).toEqual([
      {
        kind: "shared-file",
        key: JSON.stringify(["user_files", null, null, "run-1", "default", "namespace-reset"]),
      },
      {
        kind: "shared-file",
        key: JSON.stringify(["user_files", null, null, "run-1", "default", "docs/a.txt"]),
      },
      { kind: "media", key: JSON.stringify(["user_files", null, null, "run-1", "default"]) },
    ]);
    expect(
      deviceToolMutations(
        "putAppFile",
        {
          target: { domain: "user_files", namespace: "run-1", indexMedia: false },
          files,
        },
        "android",
      ),
    ).toEqual(asPutAppFile({ directory: "run-1", indexMedia: false, files }));
  });
});

describe("stageSessionDownloads service-side recording (#14359)", () => {
  const STAGED: StageSharedStorageResult = {
    success: true,
    deviceId: "phone",
    platform: "android",
    namespace: "run-1",
    userId: 0,
    userSource: "primary",
    destinationDirectory: "/storage/emulated/0/Download/run-1",
    reset: false,
    files: [
      { destinationPath: "docs/a.txt", byteCount: 1, mediaIndexing: { status: "notRequested" } },
    ],
  };
  const request = {
    sessionUuid: "broker",
    directory: "run-1",
    files: [{ destinationPath: "docs/a.txt", contentText: "x" }],
  };

  function harness(device: BootedDevice = ANDROID, recorder = true) {
    const events: string[] = [];
    const recorded: DeviceMutationEntry[][] = [];
    const recordingJournal = new (class extends FakeDeviceMutationJournal {
      override async record(
        scope: DeviceMutationScope,
        mutation: DeviceMutationInput,
      ): Promise<void> {
        events.push("journal-record");
        await super.record(scope, mutation);
      }
    })(new FakeTimer());
    const sharedStorage: SharedStorageService = {
      stage: async () => {
        events.push("device-write");
        recorded.push([...(await recordingJournal.list(SCOPE))]);
        return STAGED;
      },
    };
    const recording = new SessionDeviceMutationRecording(() =>
      recorder ? new SessionMutationRecorder(recordingJournal, SCOPE) : undefined,
    );
    const service = createDownloadsFixtureService({
      resolveActiveSession: (sessionUuid): ActiveSessionDevice => ({ sessionUuid, device }),
      sharedStorage: () => sharedStorage,
      registerPendingDeviceCleanup: () => {},
      mutationRecording: () => recording,
    });
    return { service, events, journal: recordingJournal, recorded };
  }

  test("writes the journal row before the first device write", async () => {
    const { service, events, journal, recorded } = harness();
    await service.stage(request);
    expect(events).toEqual(["journal-record", "device-write"]);
    expect(recorded[0]).toMatchObject([
      {
        kind: "shared-file",
        toolName: "putAppFile",
        priorValue: { state: "unobservable" },
        key: JSON.stringify(["user_files", null, null, "run-1", "default", "docs/a.txt"]),
      },
    ]);
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("a session without a recorder still stages", async () => {
    const { service, events } = harness(ANDROID, false);
    await service.stage(request);
    expect(events).toEqual(["device-write"]);
  });

  test("iOS is refused as unavailable without recording or writing", async () => {
    const { service, events, journal } = harness(IOS);
    expect(await service.stage(request)).toMatchObject({ success: false, status: "unavailable" });
    expect(events).toEqual([]);
    expect(await journal.list(SCOPE)).toEqual([]);
  });
});
