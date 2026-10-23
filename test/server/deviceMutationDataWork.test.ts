import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { opaqueForcesFallback } from "../../src/daemon/sessionBroker/mutations/types";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";

const ANDROID: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
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
