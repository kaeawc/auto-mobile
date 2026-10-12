import { describe, expect } from "bun:test";
import {
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
} from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import {
  getDeviceToolsDependencies,
  resetDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  executionTracker,
  type SessionClockOffsetProvider,
} from "../../src/server/executionTracker";
import { getDeviceSessionIdFromResult } from "../../src/server/deviceSessionResult";
import { serverConfig } from "../../src/utils/ServerConfig";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { defaultAppearanceSyncDependencies } from "../../src/daemon/AppearanceSyncScheduler";
import { defaultRecordingSessionCleanupDeps } from "../../src/server/recordingSessionCleanup";
import {
  KEEPER_INTERVAL_MS,
  LivenessScenario,
  OWNER_TOKEN,
} from "../helpers/livenessScenarioHarness";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { warmedTests } from "../helpers/warmedTests";

const DEVICE = "emulator-5554";
const AVD = "restart-owner-phone";
interface Reservation {
  ownerMcpSessionIds?: ReadonlySet<string>;
  ownerLivenessToken?: string;
  scheduledDeadlineMs?: number;
  idleDeadlineMs?: number;
  recoveryWindowEndMs?: number;
}

function reservations(s: LivenessScenario) {
  return (s.daemon.pool as unknown as { rehydrationReservations: Map<string, Reservation> })
    .rehydrationReservations;
}

const ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
  "AUTOMOBILE_APPEARANCE_SYNC",
  "AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES",
  "AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES",
  "AUTOMOBILE_IOS_WARMUP_DEVICES",
] as const;

describe("restart reservation owner reconnect through the real stdio proxy", () => {
  let scenario: LivenessScenario | undefined;
  let previous:
    | {
        env: Array<string | undefined>;
        clockOffset: SessionClockOffsetProvider;
        embeddedSdk: boolean;
        registry: unknown[];
        appearance: typeof defaultAppearanceSyncDependencies;
        recording: typeof defaultRecordingSessionCleanupDeps;
      }
    | undefined;
  let managerFactory:
    | ReturnType<typeof getDeviceToolsDependencies>["deviceManagerFactory"]
    | undefined;
  const test = warmedTests(async () => {
    if (scenario) {
      await scenario.stop();
      scenario = undefined;
    }
    resetDeviceToolsDependencies();
    resetDbWriteBarrier();
    expect(executionTracker.getActiveExecutionCount()).toBe(0);
    expect(ToolRegistry.getAllTools()).toHaveLength(0);
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    expect(getDbWriteBarrier().inFlightCount()).toBe(0);
    expect(getDbWriteBarrier().isDraining()).toBe(false);
    expect(getDeviceToolsDependencies().deviceManagerFactory).not.toBe(managerFactory);
    expect(Reflect.get(PlatformDeviceManagerFactory, "instance")).toBeNull();
    expect(Reflect.get(PlatformDeviceManagerFactory, "injectedManager")).toBeNull();
    if (previous) {
      Reflect.set(executionTracker, "sessionClockOffsetProvider", previous.clockOffset);
      expect(Reflect.get(executionTracker, "sessionClockOffsetProvider")).toBe(
        previous.clockOffset,
      );
      expect(ENV_KEYS.map((key) => process.env[key])).toEqual(previous.env);
      expect(
        [
          "deviceSessionManager",
          "toolCallRepository",
          "navigationToolCallRecorder",
          "executionTargetResolver",
          "auditRunner",
          "afterToolCall",
          "env",
        ].map((key) => Reflect.get(ToolRegistry, key)),
      ).toEqual(previous.registry);
      expect(defaultAppearanceSyncDependencies).toEqual(previous.appearance);
      expect(defaultRecordingSessionCleanupDeps).toEqual(previous.recording);
      expect(serverConfig.isEmbeddedSdkEnabled()).toBe(previous.embeddedSdk);
      previous = undefined;
    }
  });

  async function handoff(beforeFirstHeartbeat = false) {
    previous = {
      env: ENV_KEYS.map((key) => process.env[key]),
      clockOffset: Reflect.get(executionTracker, "sessionClockOffsetProvider"),
      embeddedSdk: serverConfig.isEmbeddedSdkEnabled(),
      registry: [
        "deviceSessionManager",
        "toolCallRepository",
        "navigationToolCallRecorder",
        "executionTargetResolver",
        "auditRunner",
        "afterToolCall",
        "env",
      ].map((key) => Reflect.get(ToolRegistry, key)),
      appearance: { ...defaultAppearanceSyncDependencies },
      recording: { ...defaultRecordingSessionCleanupDeps },
    };
    scenario = await LivenessScenario.start({
      freshConnectionIdPerDial: true,
      realStartAdmission: true,
      deviceNames: { [DEVICE]: AVD },
    });
    managerFactory = getDeviceToolsDependencies().deviceManagerFactory;
    const s = scenario;
    s.dropHeartbeats = beforeFirstHeartbeat;
    const holder = await s.acquire();
    if (!beforeFirstHeartbeat) {
      await s.idle(KEEPER_INTERVAL_MS);
    }
    await drainMicrotasks(256);
    expect(s.daemon.manager.getSession(holder)?.livenessOwnerToken).toBe(OWNER_TOKEN);
    const connection = s.proxyConnectionId()!;
    await s.loseDevice(holder);
    expect(s.daemon.manager.getSession(holder)).toBeNull();
    expect(reservations(s).get(holder)?.ownerMcpSessionIds?.has(connection)).toBe(true);
    return { s, holder, connection };
  }

  test("owner resumes a restart handoff lost before its first heartbeat on a fresh connection", async () => {
    const { s, holder, connection } = await handoff(true);
    expect(reservations(s).get(holder)?.ownerLivenessToken).toBe(OWNER_TOKEN);
    const result = await s.proxy.callTool("getAndroid", { avdName: AVD });
    expect(result).not.toMatchObject({ isError: true });
    expect(getDeviceSessionIdFromResult(result)).toBe(holder);
    expect(s.proxyConnectionId()).not.toBe(connection);
    expect(s.deviceBootCount()).toBe(1);
  });

  test("pre-first-heartbeat reservation refuses a rival proxy naming the holder", async () => {
    const { s, holder } = await handoff(true);
    const rival = s.addProxy({ token: "rival-token" });
    await expectRefused(s, holder, () =>
      rival.callTool("getAndroid", { avdName: AVD, [DAEMON_OWNED_SESSIONS_PARAM]: [holder] }),
    );
  });

  for (const keeperReconnect of [true, false]) {
    test(`${keeperReconnect ? "keeper-reconnected" : "immediate"} owner boots once and resumes the same session`, async () => {
      const { s, holder, connection } = await handoff();
      if (keeperReconnect) {
        await s.idle(KEEPER_INTERVAL_MS);
        await drainMicrotasks(256);
        expect(s.proxyConnectionId()).not.toBe(connection);
        expect(Reflect.get(s.proxy, "recoverableBoundSessionHandoff")).toBeUndefined();
      } else {
        expect(Reflect.get(s.proxy, "recoverableBoundSessionHandoff")).toBe(holder);
      }
      const result = await s.proxy.callTool("getAndroid", { avdName: AVD });
      expect(JSON.stringify(result)).not.toContain("device_owned_by_other_session");
      expect(result).not.toMatchObject({ isError: true });
      expect(getDeviceSessionIdFromResult(result)).toBe(holder);
      expect(s.proxyConnectionId()).not.toBe(connection);
      expect(s.deviceBootCount()).toBe(1);
      expect(s.daemon.manager.getAllSessions().map((session) => session.sessionId)).toEqual([
        holder,
      ]);
      const live = s.daemon.manager.getSession(holder)!;
      expect(live.assignedDevice).toBe(DEVICE);
      expect(s.daemon.manager.isAdmittedForAutomation(live)).toBe(true);
      expect(
        s.daemon.pool.resolveOwnedDeviceSessionForMcpSession(s.proxyConnectionId()!, DEVICE),
      ).toBe(holder);
      expect(reservations(s).has(holder)).toBe(false);
      await expect(s.toolCall(holder)).resolves.toMatchObject({ content: expect.any(Array) });
    });
  }

  async function expectRefused(s: LivenessScenario, holder: string, call: () => Promise<unknown>) {
    const row = { ...(await s.repository.getSession(holder))! };
    const hold = reservations(s).get(holder)!;
    const before = { ...hold, ownerMcpSessionIds: new Set(hold.ownerMcpSessionIds) };
    const result = await call();
    expect(result).toMatchObject({ isError: true });
    const errorResult = result as { content: Array<{ text: string }> };
    const refusal: unknown = JSON.parse(errorResult.content[0]!.text);
    expect(refusal).toMatchObject({
      code: "device_owned_by_other_session",
      retryable: true,
      deviceId: DEVICE,
    });
    expect(s.deviceBootCount()).toBe(0);
    expect(reservations(s).get(holder)).toEqual(before);
    expect(await s.repository.getSession(holder)).toEqual(row);
    expect(s.daemon.manager.getSession(holder)).toBeNull();
  }

  test("rival proxy with a different owner token is refused before boot", async () => {
    const { s, holder } = await handoff();
    const rival = s.addProxy({ token: "rival-token" });
    await expectRefused(s, holder, () => rival.callTool("getAndroid", { avdName: AVD }));
  });

  for (const token of [undefined, "wrong-token"]) {
    test(`raw connection naming the holder with ${token ?? "no token"} proves nothing`, async () => {
      const { s, holder } = await handoff();
      await expectRefused(s, holder, async () => {
        const envelope = await s.daemonMethod(
          "tools/call",
          {
            name: "getAndroid",
            arguments: {
              avdName: AVD,
              [DAEMON_OWNED_SESSIONS_PARAM]: [holder],
              ...(token ? { [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: token } : {}),
            },
          },
          "raw-rival",
        );
        expect(envelope.success).toBe(true);
        return envelope.result;
      });
      expect(
        [...reservations(s).get(holder)!.ownerMcpSessionIds!].some((id) =>
          id.startsWith("raw-rival"),
        ),
      ).toBe(false);
    });
  }
});
