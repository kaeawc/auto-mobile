import { describe, expect, test } from "bun:test";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/models/VideoRecordingConfigParsing";
import type { Session } from "../../src/daemon/sessionManager";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { createPooledDevice, DaemonDisconnectHarness } from "./helpers/DaemonDisconnectHarness";

function monitor(cadence = { activeIntervalMs: 5_000, idleIntervalMs: 30_000 }) {
  const timer = new FakeTimer();
  const daemon = new DaemonDisconnectHarness(timer);
  const pooled = createPooledDevice("emulator-5554");
  const pool = daemon.getDevicePool();
  pool.getAllDevices = () => [pooled];
  pool.reconcileDiscoveryObservation = async () => {};
  let claimed = false;
  pool.genericAvailability = () =>
    claimed || pooled.status === "busy" || pooled.sessionId !== null ? "reserved" : "free";
  let sessions: Session[] = [];
  daemon.getSessionManager().getAllSessions = () => sessions;
  let recordings: VideoRecordingRecord[] = [];
  let discoveries = 0;
  let present = true;
  const manager = {
    getBootedDevicesDetailed: async (): Promise<BootedDeviceDiscovery> => {
      discoveries++;
      return {
        devices: present ? [{ platform: "android", deviceId: pooled.id, name: pooled.name }] : [],
        succeededPlatforms: new Set(["android"]),
      };
    },
    getAndroidOfflineDeviceIds: async () => new Set<string>(),
    getAndroidListedDeviceStates: async () => new Map<string, string>(),
    recoverAndroidOfflineDevices: async () => {},
  };
  daemon.startMonitor(manager, async () => recordings, undefined, cadence);
  const tick = async () => {
    timer.advanceTime(cadence.activeIntervalMs);
    await drainMicrotasks(100);
  };
  const holdSession = () => {
    sessions = [
      {
        sessionId: "holder",
        assignedDevice: pooled.id,
        platform: "android",
        createdAt: 0,
        lastUsedAt: 0,
        activityGeneration: 0,
        expiresAt: 1_000_000,
        cacheData: {},
        lastHeartbeat: 0,
        sessionTimeoutMs: 1_000_000,
        heartbeatTimeoutMs: 1_000_000,
        heartbeatTimeoutSource: "custom",
        hasReceivedHeartbeat: true,
        ownership: "owned",
        livenessPolicy: "heartbeat",
      },
    ];
  };
  const record = () => {
    recordings = [
      {
        recordingId: "rec-1",
        deviceId: pooled.id,
        platform: "android",
        status: "recording",
        fileName: "recording.mp4",
        format: "mp4",
        sizeBytes: 0,
        filePath: "/fake/recording.mp4",
        createdAt: "2026-10-20T00:00:00Z",
        startedAt: "2026-10-20T00:00:00Z",
        lastAccessedAt: "2026-10-20T00:00:00Z",
        config: { ...DEFAULT_VIDEO_RECORDING_CONFIG },
      },
    ];
  };
  return {
    tick,
    timer,
    pooled,
    daemon,
    discoveries: () => discoveries,
    holdSession,
    record,
    setPresent: (value: boolean) => {
      present = value;
    },
    claim: () => {
      claimed = true;
    },
  };
}

describe("DaemonDisconnect adaptive discovery cadence", () => {
  test("an idle pool runs two discovery sweeps over twelve 5-second ticks", async () => {
    const rig = monitor();
    try {
      for (let tick = 0; tick < 12; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(2);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test.each(["session", "busy", "claimed", "recording"])(
    "%s resumes 5-second discovery on the next tick",
    async (reason) => {
      const rig = monitor();
      try {
        await rig.tick();
        expect(rig.discoveries()).toBe(0);
        if (reason === "session") {
          rig.holdSession();
        }
        if (reason === "busy") {
          rig.pooled.status = "busy";
        }
        if (reason === "claimed") {
          rig.claim();
        }
        if (reason === "recording") {
          rig.record();
        }
        await rig.tick();
        await rig.tick();
        expect(rig.discoveries()).toBe(2);
        expect(rig.daemon.disconnectMisses.size).toBe(0);
      } finally {
        await rig.daemon.disconnectMonitor?.stop();
      }
    },
  );

  test("released claims return to idle cadence without changing active miss counting", async () => {
    const rig = monitor();
    try {
      await rig.tick();
      expect(rig.discoveries()).toBe(0);
      rig.pooled.status = "busy";
      rig.setPresent(false);
      await rig.tick();
      expect(rig.daemon.disconnectMisses.get(rig.pooled.id)).toBe(1);
      await rig.tick();
      expect(rig.daemon.disconnectMisses.get(rig.pooled.id)).toBe(2);
      rig.setPresent(true);
      await rig.tick();
      expect(rig.daemon.disconnectMisses.has(rig.pooled.id)).toBe(false);
      rig.pooled.status = "idle";
      for (let tick = 0; tick < 5; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(3);
      await rig.tick();
      expect(rig.discoveries()).toBe(4);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("the injected intervals control idle polling", async () => {
    const rig = monitor({ activeIntervalMs: 10, idleIntervalMs: 40 });
    try {
      for (let tick = 0; tick < 8; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(2);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });
});
