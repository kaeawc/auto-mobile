import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  collectDisconnectCandidates,
  collectDisconnectedRecordings,
  DISCONNECT_RECORDING_STOP_WAIT_MS,
  getAndroidOfflineCanonicalIds,
  logDisconnectMisses,
  PLAN_DEVICE_DISCONNECT_MISS_CAP,
  probeListedAndroidStates,
  stopRecordingAfterDeviceDisconnect,
} from "../../src/daemon/deviceLossDiscovery";
import * as videoRecordingManager from "../../src/daemon/videoRecordingManager";
import { AndroidOfflineProbeError } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { DeviceLossMisses } from "../../src/daemon/deviceLossMisses";

type AliasPool = Parameters<typeof getAndroidOfflineCanonicalIds>[0];

function aliasPool(aliases: Record<string, string[]> = {}): AliasPool {
  return { getAndroidTransportAliases: (id: string) => aliases[id] ?? [] };
}

describe("device-loss discovery helpers (#11808)", () => {
  test("an offline alias serial counts as its canonical id", async () => {
    const pool = aliasPool({ usb1: ["192.168.0.5:5555"] });
    const asked: string[][] = [];
    const offline = await getAndroidOfflineCanonicalIds(
      pool,
      {
        getAndroidOfflineDeviceIds: async (ids) => {
          asked.push([...ids].sort());
          return new Set(["192.168.0.5:5555"]);
        },
      },
      ["usb1"],
    );
    expect([...offline]).toEqual(["usb1"]);
    expect(asked).toEqual([["192.168.0.5:5555", "usb1"]]);
  });

  describe("probeListedAndroidStates", () => {
    const android = new Map<string, "android" | "ios">([["emu-1", "android"]]);

    test("skips the probe while a plan is active", async () => {
      let probes = 0;
      const listed = await probeListedAndroidStates(
        aliasPool(),
        {
          getAndroidListedDeviceStates: async () => {
            probes++;
            return new Map();
          },
        },
        true,
        {
          candidateDeviceIds: new Set(["emu-1"]),
          bootedDeviceIds: new Set(),
          candidatePlatforms: android,
        },
      );
      expect(listed).toEqual({});
      expect(probes).toBe(0);
    });

    test("does not probe when every Android candidate is booted", async () => {
      let probes = 0;
      await probeListedAndroidStates(
        aliasPool(),
        {
          getAndroidListedDeviceStates: async () => {
            probes++;
            return new Map();
          },
        },
        false,
        {
          candidateDeviceIds: new Set(["emu-1"]),
          bootedDeviceIds: new Set(["emu-1"]),
          candidatePlatforms: android,
        },
      );
      expect(probes).toBe(0);
    });

    test("classifies offline and transitional rows under the canonical id", async () => {
      const listed = await probeListedAndroidStates(
        aliasPool({ "emu-1": ["alias-1"] }),
        { getAndroidListedDeviceStates: async () => new Map([["alias-1", "offline"]]) },
        false,
        {
          candidateDeviceIds: new Set(["emu-1"]),
          bootedDeviceIds: new Set(),
          candidatePlatforms: android,
        },
      );
      expect([...listed.offlineDeviceIds!]).toEqual(["emu-1"]);
      expect([...listed.transitionalAdbDeviceIds!]).toEqual(["emu-1"]);
      expect([...listed.listedNonDeviceIds!]).toEqual(["emu-1"]);
      expect(listed.offlineTransportIds).toEqual(new Map([["emu-1", new Set(["alias-1"])]]));
    });

    test("a probe failure supplies no evidence", async () => {
      const listed = await probeListedAndroidStates(
        aliasPool(),
        {
          getAndroidListedDeviceStates: async () => {
            throw new AndroidOfflineProbeError("adb unavailable");
          },
        },
        false,
        {
          candidateDeviceIds: new Set(["emu-1"]),
          bootedDeviceIds: new Set(),
          candidatePlatforms: android,
        },
      );
      expect(listed).toEqual({});
    });

    test("rethrows unexpected failures", async () => {
      await expect(
        probeListedAndroidStates(
          aliasPool(),
          {
            getAndroidListedDeviceStates: async () => {
              throw new Error("boom");
            },
          },
          false,
          {
            candidateDeviceIds: new Set(["emu-1"]),
            bootedDeviceIds: new Set(),
            candidatePlatforms: android,
          },
        ),
      ).rejects.toThrow("boom");
    });
  });

  test("candidates come from recordings, the pool and sessions, pool platform winning", () => {
    const candidates = collectDisconnectCandidates(
      {
        getAllDevices: () => [{ id: "pool-1", platform: "android", incarnation: 7 }],
      },
      {
        getAllSessions: () => [
          { assignedDevice: "pool-1", platform: "ios" },
          { assignedDevice: "sess-1", platform: "ios" },
        ],
      },
      [{ deviceId: "rec-1", platform: "ios", recordingId: "r1" }],
    );
    expect([...candidates.candidateDeviceIds].sort()).toEqual(["pool-1", "rec-1", "sess-1"]);
    expect(candidates.candidatePlatforms.get("pool-1")).toBe("android");
    expect(candidates.candidatePlatforms.get("sess-1")).toBe("ios");
    expect(candidates.candidateIncarnations.get("pool-1")).toBe(7);
  });

  test("an ADB-reset cohort is marked missing and its recordings attached", () => {
    const missing = new Map<string, string[]>([["other", []]]);
    const cohort = [{ id: "emu-1" }];
    const byId = collectDisconnectedRecordings(cohort, missing, [
      { deviceId: "emu-1", recordingId: "r1" },
      { deviceId: "unrelated", recordingId: "r2" },
    ]);
    expect([...byId.keys()]).toEqual(["emu-1"]);
    expect(missing.get("emu-1")).toEqual(["r1"]);
    expect(missing.has("unrelated")).toBe(false);
  });

  test("a plan-time tick lowers recorded misses to the plan cap", () => {
    const misses = new DeviceLossMisses();
    const result = {
      missed: [{ deviceId: "emu-1", misses: PLAN_DEVICE_DISCONNECT_MISS_CAP + 5 }],
      transitional: [],
    };
    logDisconnectMisses(misses, result, new Set(["emu-1"]), new Set());
    expect(misses.get("emu-1")).toBe(PLAN_DEVICE_DISCONNECT_MISS_CAP);
    const idle = new DeviceLossMisses();
    logDisconnectMisses(idle, result, new Set(), new Set());
    expect(idle.size).toBe(0);
  });

  describe("stopRecordingAfterDeviceDisconnect", () => {
    let stop: ReturnType<
      typeof spyOn<typeof videoRecordingManager, "stopVideoRecordingUnattended">
    >;

    beforeEach(() => {
      stop = spyOn(videoRecordingManager, "stopVideoRecordingUnattended");
    });

    afterEach(() => {
      stop.mockRestore();
    });

    test("refuses a second stop while one is in flight and releases at the wait bound", async () => {
      const timer = new FakeTimer();
      const stoppingRecordings = new Set<string>();
      let finishStop: (() => void) | undefined;
      stop.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishStop = () => resolve({} as Awaited<ReturnType<typeof stop>>);
          }),
      );
      const deps = { timer, stoppingRecordings };
      const first = stopRecordingAfterDeviceDisconnect(deps, "rec-1", "dev-1");
      await drainMicrotasks(5);
      expect(await stopRecordingAfterDeviceDisconnect(deps, "rec-1", "dev-1")).toBe(false);
      timer.advanceTime(DISCONNECT_RECORDING_STOP_WAIT_MS);
      expect(await first).toBe(true);
      expect(stoppingRecordings.has("rec-1")).toBe(true);
      finishStop?.();
      await drainUntil(() => !stoppingRecordings.has("rec-1"), {
        description: "recording stop to finish",
      });
    });
  });
});
