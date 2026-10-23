import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deviceHold, genericAvailabilityOf } from "../../src/daemon/deviceHold";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/models/VideoRecordingConfigParsing";
import type { Session } from "../../src/daemon/sessionManager";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";
import type { DisconnectMonitorCadence } from "../../src/daemon/daemonCore/DaemonDisconnect";
import type { BootedDevice } from "../../src/models";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { createPooledDevice, DaemonDisconnectHarness } from "./helpers/DaemonDisconnectHarness";

function monitor(
  cadence: DisconnectMonitorCadence = { activeIntervalMs: 5_000, idleIntervalMs: 30_000 },
  platform: "ios" | "android" = "android",
) {
  const timer = new FakeTimer();
  const daemon = new DaemonDisconnectHarness(timer, {
    shouldSkipStaleDisconnectCleanup: async () => false,
    recordAndTryRecoverCapturedDisconnect: async () => ({ incidentId: undefined, handled: false }),
  });
  const pooled = createPooledDevice(platform === "ios" ? "simulator-1" : "emulator-5554", {
    platform,
  });
  const pool = daemon.getDevicePool();
  pool.getAllDevices = () => [pooled];
  pool.reconcileDiscoveryObservation = async () => {};
  pool.getDevice = (id) => (id === pooled.id ? pooled : null);
  let cleanupInProgress = false;
  let leased = false;
  pool.isDeviceLeasedForAndroidStartup = () => leased;
  pool.genericAvailability = () =>
    genericAvailabilityOf(
      deviceHold({ status: pooled.status, sessionId: pooled.sessionId, cleanupInProgress }),
    );
  let sessions: Session[] = [];
  daemon.getSessionManager().getAllSessions = () => sessions;
  let recordings: VideoRecordingRecord[] = [];
  let discoveries = 0;
  let present = true;
  let failDiscovery = false;
  let succeededPlatforms: Set<"android" | "ios"> | undefined;
  let extraDevices: BootedDevice[] = [];
  let offline = false;
  let recovered = 0;
  const scopes: ("ios" | "android" | "either" | undefined)[] = [];
  const manager = {
    getBootedDevicesDetailed: async (
      scope?: "ios" | "android" | "either",
    ): Promise<BootedDeviceDiscovery> => {
      scopes.push(scope);
      if (failDiscovery) {
        throw new Error("fake discovery failed");
      }
      discoveries++;
      return {
        devices: [
          ...(present ? [{ platform, deviceId: pooled.id, name: pooled.name }] : []),
          ...extraDevices,
        ].filter((device) => !scope || scope === "either" || device.platform === scope),
        succeededPlatforms:
          succeededPlatforms ??
          new Set(scope === "either" || !scope ? ["android", "ios"] : [scope]),
      };
    },
    getAndroidOfflineDeviceIds: async () => new Set<string>(),
    getAndroidListedDeviceStates: async () =>
      new Map<string, string>(offline ? [[pooled.id, "offline"]] : []),
    recoverAndroidOfflineDevices: async () => {
      recovered++;
    },
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
        platform,
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
        platform,
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
    scopes,
    recovered: () => recovered,
    setOffline: () => {
      offline = true;
    },
    setExtraDevices: (devices: BootedDevice[]) => {
      extraDevices = devices;
    },
    setSucceededPlatforms: (platforms: Set<"android" | "ios">) => {
      succeededPlatforms = platforms;
    },
    setFailure: (value: boolean) => {
      failDiscovery = value;
    },
    release: () => {
      sessions = [];
      recordings = [];
      pooled.status = "idle";
      serverConfig.setPlanExecutionActive(false);
    },
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
      pooled.sessionId = "claim-owner";
    },
    lease: () => {
      leased = true;
    },
    beginCleanup: () => {
      cleanupInProgress = true;
      pooled.status = "busy";
    },
  };
}

describe("DaemonDisconnect adaptive discovery cadence", () => {
  let previousPlanActive: boolean;
  beforeEach(() => {
    previousPlanActive = serverConfig.isPlanExecutionActive();
    serverConfig.setPlanExecutionActive(false);
  });
  afterEach(() => serverConfig.setPlanExecutionActive(previousPlanActive));

  test("unchanged idle pool makes exactly seven reads in ten minutes", async () => {
    const rig = monitor();
    try {
      for (let tick = 0; tick < 120; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(7);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("android-only discovery makes exactly seven idle reads in ten minutes", async () => {
    const rig = monitor();
    rig.setSucceededPlatforms(new Set(["android"]));
    try {
      for (let tick = 0; tick < 120; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(7);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("succeeded platform changes reset idle backoff to thirty seconds", async () => {
    const rig = monitor();
    rig.setSucceededPlatforms(new Set(["android"]));
    try {
      for (let tick = 0; tick < 48; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(4);
      rig.setSucceededPlatforms(new Set(["android", "ios"]));
      for (let tick = 0; tick < 24; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(5);
      for (let tick = 0; tick < 5; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(5);
      await rig.tick();
      expect(rig.discoveries()).toBe(6);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("a failed full sweep retries either on the next watching tick", async () => {
    const rig = monitor(undefined, "ios");
    rig.pooled.status = "busy";
    try {
      rig.setFailure(true);
      await rig.tick();
      rig.setFailure(false);
      await rig.tick();
      expect(rig.scopes).toEqual(["either", "either"]);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test.each(["appearing", "disappearing"])("%s discovery resets idle backoff", async (change) => {
    const rig = monitor();
    try {
      const extra: BootedDevice = { platform: "ios", deviceId: "new-sim", name: "New" };
      if (change === "disappearing") {
        rig.setExtraDevices([extra]);
      }
      for (let tick = 0; tick < 48; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(4);
      rig.setExtraDevices(change === "appearing" ? [extra] : []);
      for (let tick = 0; tick < 24; tick++) {
        await rig.tick();
      }
      const count = rig.discoveries();
      for (let tick = 0; tick < 6; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(count + 1);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test.each(["session", "recording", "busy", "plan"])(
    "%s resets backoff on activity and release",
    async (reason) => {
      const rig = monitor();
      try {
        for (let tick = 0; tick < 48; tick++) {
          await rig.tick();
        }
        expect(rig.discoveries()).toBe(4);
        if (reason === "session") {
          rig.holdSession();
        }
        if (reason === "recording") {
          rig.record();
        }
        if (reason === "busy") {
          rig.pooled.status = "busy";
        }
        if (reason === "plan") {
          serverConfig.setPlanExecutionActive(true);
        }
        const before = rig.discoveries();
        await rig.tick();
        await rig.tick();
        expect(rig.discoveries()).toBe(before + 2);
        rig.release();
        for (let tick = 0; tick < 12; tick++) {
          await rig.tick();
        }
        expect(rig.discoveries()).toBe(before + 4);
      } finally {
        await rig.daemon.disconnectMonitor?.stop();
      }
    },
  );

  test.each(["ios", "android"] as const)(
    "watching %s scopes reads between full sweeps",
    async (platform) => {
      const rig = monitor(undefined, platform);
      try {
        rig.pooled.status = "busy";
        for (let tick = 0; tick < 13; tick++) {
          await rig.tick();
        }
        expect(rig.scopes).toEqual([
          "either",
          platform,
          platform,
          platform,
          platform,
          platform,
          "either",
          platform,
          platform,
          platform,
          platform,
          platform,
          "either",
        ]);
      } finally {
        await rig.daemon.disconnectMonitor?.stop();
      }
    },
  );

  test("mixed session and pooled platforms always sweep either", async () => {
    const rig = monitor(undefined, "ios");
    try {
      rig.holdSession();
      rig.daemon.getSessionManager().getAllSessions()[0]!.platform = "android";
      await rig.tick();
      await rig.tick();
      expect(rig.scopes).toEqual(["either", "either"]);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("tracked iOS disappearance retains three misses and cleanup", async () => {
    const rig = monitor(undefined, "ios");
    const removed: string[] = [];
    rig.daemon.getDevicePool().removeDisconnectedDevice = async (id) => {
      expect(rig.daemon.disconnectMisses.get(id)).toBe(3);
      removed.push(id);
    };
    rig.daemon.getDevicePool().recordEmulatorLossIncident = async () => undefined;
    try {
      rig.pooled.status = "busy";
      rig.setPresent(false);
      await rig.tick();
      expect(rig.daemon.disconnectMisses.get(rig.pooled.id)).toBe(1);
      await rig.tick();
      expect(rig.daemon.disconnectMisses.get(rig.pooled.id)).toBe(2);
      await rig.tick();
      expect(removed).toEqual([rig.pooled.id]);
      expect(rig.scopes).toEqual(["either", "either", "ios", "ios", "ios", "ios"]);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("an empty pool also backs off over ten minutes", async () => {
    const rig = monitor();
    rig.daemon.getDevicePool().getAllDevices = () => [];
    rig.setPresent(false);
    try {
      for (let tick = 0; tick < 120; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(7);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("a failed idle sweep resets the next interval and baseline", async () => {
    const rig = monitor();
    try {
      for (let tick = 0; tick < 48; tick++) {
        await rig.tick();
      }
      rig.setFailure(true);
      for (let tick = 0; tick < 24; tick++) {
        await rig.tick();
      }
      rig.setFailure(false);
      const before = rig.discoveries();
      for (let tick = 0; tick < 6; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(before + 1);
      for (let tick = 0; tick < 6; tick++) {
        await rig.tick();
      }
      expect(rig.discoveries()).toBe(before + 2);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("missing pooled devices never back off", async () => {
    const rig = monitor();
    rig.setPresent(false);
    try {
      for (let tick = 0; tick < 12; tick++) {
        await rig.tick();
      }
      expect(rig.daemon.disconnectMisses.get(rig.pooled.id)).toBe(2);
      expect(rig.discoveries()).toBe(4);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("plan activity without tracked devices sweeps either every tick", async () => {
    const rig = monitor();
    rig.daemon.getDevicePool().getAllDevices = () => [];
    rig.setPresent(false);
    serverConfig.setPlanExecutionActive(true);
    try {
      await rig.tick();
      await rig.tick();
      expect(rig.scopes).toEqual(["either", "either"]);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("plan activity on a tracked single-platform device still sweeps either every tick", async () => {
    const rig = monitor(undefined, "ios");
    serverConfig.setPlanExecutionActive(true);
    try {
      await rig.tick();
      await rig.tick();
      await rig.tick();
      expect(rig.scopes).toEqual(["either", "either", "either"]);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

  test("offline recovery rediscovery retains Android scope", async () => {
    const rig = monitor();
    rig.pooled.status = "busy";
    try {
      await rig.tick();
      rig.setPresent(false);
      rig.setOffline();
      await rig.tick();
      expect(rig.recovered()).toBe(1);
      expect(rig.scopes).toEqual(["either", "android", "android", "android"]);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

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

  test.each(["session", "busy", "claimed", "recording", "leased", "plan", "error"])(
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
        if (reason === "leased") {
          rig.lease();
        }
        if (reason === "plan") {
          serverConfig.setPlanExecutionActive(true);
        }
        if (reason === "error") {
          rig.pooled.health = "error";
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

  test("a cleanup-state device vanishing is swept at the 5-second cadence", async () => {
    const rig = monitor();
    try {
      rig.beginCleanup();
      expect(rig.daemon.getDevicePool().genericAvailability(rig.pooled.id)).toBe("free");
      rig.setPresent(false);
      await rig.tick();
      expect(rig.discoveries()).toBe(2); // Cheap read plus a fresh absence confirmation.
      expect(rig.daemon.disconnectMisses.get(rig.pooled.id)).toBe(1);
      await rig.tick();
      expect(rig.discoveries()).toBe(4);
      expect(rig.daemon.disconnectMisses.get(rig.pooled.id)).toBe(2);
    } finally {
      await rig.daemon.disconnectMonitor?.stop();
    }
  });

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
      expect(rig.discoveries()).toBe(5); // Two absent sweeps (two reads each), then presence.
      await rig.tick();
      expect(rig.discoveries()).toBe(6);
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
