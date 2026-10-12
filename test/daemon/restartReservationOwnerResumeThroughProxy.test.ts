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
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import type { LivenessScenarioOptions } from "../helpers/livenessScenarioHarness";
import type { Mutex } from "async-mutex";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";

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

  async function startScenario(options: LivenessScenarioOptions = {}) {
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
      ...options,
    });
    managerFactory = getDeviceToolsDependencies().deviceManagerFactory;
    return scenario;
  }

  async function handoff(beforeFirstHeartbeat = false) {
    const s = await startScenario();
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

  async function labelHandoff(withOtherBase = false) {
    const primary = "emulator-5556";
    const otherPrimary = "emulator-5558";
    const otherDevice = "emulator-5560";
    const siblingDevice = "emulator-5562";
    const s = await startScenario({
      devices: withOtherBase
        ? [primary, DEVICE, otherPrimary, otherDevice, siblingDevice]
        : [primary, DEVICE],
    });
    const base = await s.acquire(primary);
    const connection = s.proxyConnectionId()!;
    const label = `${base}:label`;
    const manager = s.daemon.manager;
    async function allocateLabel(owner: string, id: string, deviceId: string) {
      await asPlanAllocation(manager, owner, [id], () =>
        s.daemon.pool.bindOrReuseDeviceSession(
          id,
          deviceId,
          "android",
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          connection,
        ),
      );
      manager.setDeviceLabels(owner, { ...manager.getDeviceLabels(owner), [id]: id });
    }
    await allocateLabel(base, label, DEVICE);
    let otherLabel: string | undefined;
    let siblingLabel: string | undefined;
    if (withOtherBase) {
      siblingLabel = `${base}:sibling`;
      await allocateLabel(base, siblingLabel, siblingDevice);
      // The token is deliberately the same: the presented ownership base must also match.
      const other = s.addProxy({ token: OWNER_TOKEN });
      const acquired = await other.callTool("getAndroid", { deviceId: otherPrimary });
      const otherBase = getDeviceSessionIdFromResult(acquired)!;
      expect(otherBase).toBeDefined();
      otherLabel = `${otherBase}:label`;
      await allocateLabel(otherBase, otherLabel, otherDevice);
      await s.loseDevice(otherLabel, otherDevice);
      await s.loseDevice(siblingLabel, siblingDevice);
    }
    await s.loseDevice(label, DEVICE);
    expect(manager.getSession(base)).not.toBeNull();
    expect(manager.getSession(label)).toBeNull();
    expect(manager.ownershipSessionUuid(label, false)).toBe(base);
    expect(manager.getBaseSessionOfDerivedLabel(label)).toBe(base);
    expect(reservations(s).get(label)?.ownerLivenessToken).toBe(OWNER_TOKEN);
    return { s, base, label, connection, otherLabel, siblingLabel };
  }

  test("live base label handoff: presenting the base with its token admits acquisition", async () => {
    const { s, base, label, connection } = await labelHandoff();
    const sent: Record<string, unknown>[] = [];
    const reconnect = s.addProxy({
      token: OWNER_TOKEN,
      initialSessionUuid: base,
      client: (daemon) =>
        new FakeDaemonClient({
          daemon,
          onCallTool: (_name, params) => {
            sent.push(params);
          },
        }),
    });
    const result = await reconnect.callTool("getAndroid", {
      avdName: AVD,
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(sent).toContainEqual(
      expect.objectContaining({
        [DAEMON_OWNED_SESSIONS_PARAM]: [base],
        [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
      }),
    );
    expect(s.deviceBootCount()).toBe(1);
    expect(reservations(s).has(label)).toBe(false);
    expect(s.daemon.pool.hasConnectedMcpSessionOwner(base, connection)).toBe(true);
  });

  test("live base label handoff: presenting the released label with its token still credits it", async () => {
    const { s, label } = await labelHandoff();
    const before = new Set(reservations(s).get(label)!.ownerMcpSessionIds);
    await s.daemonMethod(
      "tools/call",
      {
        name: "observe",
        arguments: {
          deviceId: "emulator-5556",
          [DAEMON_OWNED_SESSIONS_PARAM]: [label],
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
        },
      },
      "label-owner-reconnect",
    );
    const owners = reservations(s).get(label)!.ownerMcpSessionIds!;
    expect(owners.size).toBe(before.size + 1);
    for (const owner of before) {
      expect(owners.has(owner)).toBe(true);
    }
    expect(s.daemon.manager.getSession(label)).toBeNull();
    expect(s.deviceBootCount()).toBe(0);
  });

  test("live base reconnect credits only its label hold without renewing or reviving it", async () => {
    const { s, base, label, otherLabel, siblingLabel } = await labelHandoff(true);
    const before = { ...reservations(s).get(label)! };
    const siblingBefore = { ...reservations(s).get(siblingLabel!)! };
    const otherBefore = { ...reservations(s).get(otherLabel!)! };
    const row = { ...(await s.repository.getSession(label))! };
    const baseBefore = { ...s.daemon.manager.getSession(base)! };
    await s.idle(1);
    // A read runs selector restoration without admitting control or renewing activity.
    await s.daemonMethod(
      "tools/call",
      {
        name: "observe",
        arguments: {
          deviceId: "emulator-5556",
          [DAEMON_OWNED_SESSIONS_PARAM]: [base],
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
        },
      },
      "base-owner-reconnect",
    );
    const credited = reservations(s).get(label)!;
    expect(credited.ownerMcpSessionIds!.size).toBe(before.ownerMcpSessionIds!.size + 1);
    expect(credited).toEqual({ ...before, ownerMcpSessionIds: credited.ownerMcpSessionIds });
    expect(reservations(s).get(otherLabel!)).toEqual(otherBefore);
    expect(reservations(s).get(siblingLabel!)?.ownerMcpSessionIds).toEqual(
      credited.ownerMcpSessionIds,
    );
    expect(reservations(s).get(siblingLabel!)).toEqual({
      ...siblingBefore,
      ownerMcpSessionIds: credited.ownerMcpSessionIds,
    });
    expect(s.daemon.manager.getSession(label)).toBeNull();
    expect(await s.repository.getSession(label)).toEqual(row);
    expect(s.daemon.manager.getSession(base)).toMatchObject({
      lastUsedAt: baseBefore.lastUsedAt,
      expiresAt: baseBefore.expiresAt,
      lastHeartbeat: baseBefore.lastHeartbeat,
      lastOwnerHeartbeat: baseBefore.lastOwnerHeartbeat,
      activityGeneration: baseBefore.activityGeneration,
    });
    expect(s.deviceBootCount()).toBe(0);
  });

  test("live base label handoff refuses a rival proxy token", async () => {
    const { s, base, label } = await labelHandoff();
    const sent: Record<string, unknown>[] = [];
    const rival = s.addProxy({
      token: "rival-token",
      initialSessionUuid: base,
      client: (daemon) =>
        new FakeDaemonClient({
          daemon,
          onCallTool: (_name, params) => {
            sent.push(params);
          },
        }),
    });
    await expectRefused(s, label, () =>
      rival.callTool("getAndroid", {
        avdName: AVD,
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        [DAEMON_OWNED_SESSIONS_PARAM]: [base],
        [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "rival-token",
      }),
    );
  });

  test("live base label handoff refuses a tokenless connection naming the base", async () => {
    const { s, base, label } = await labelHandoff();
    await expectRefused(s, label, async () => {
      const envelope = await s.daemonMethod(
        "tools/call",
        {
          name: "getAndroid",
          arguments: { avdName: AVD, [DAEMON_OWNED_SESSIONS_PARAM]: [base] },
        },
        "tokenless-label-restore",
      );
      expect(envelope.success).toBe(true);
      return envelope.result;
    });
  });

  test("live base label handoff refuses an unrelated id sharing its prefix", async () => {
    const { s, base, label } = await labelHandoff();
    const sent: Record<string, unknown>[] = [];
    const unrelatedId = `${base}:unpublished`;
    const reconnect = s.addProxy({
      token: OWNER_TOKEN,
      initialSessionUuid: unrelatedId,
      client: (daemon) =>
        new FakeDaemonClient({
          daemon,
          onCallTool: (_name, params) => {
            sent.push(params);
          },
        }),
    });
    await expectRefused(s, label, () =>
      reconnect.callTool("getAndroid", {
        avdName: AVD,
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        [DAEMON_OWNED_SESSIONS_PARAM]: [unrelatedId],
        [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
      }),
    );
  });

  for (const matchesHold of [true, false]) {
    test(`a refused live base ${matchesHold ? "credits" : "does not credit"} its label only when the reservation token matches`, async () => {
      const { s, base, label } = await labelHandoff();
      const manager = s.daemon.manager;
      await manager.releaseLivenessOwnership(base, OWNER_TOKEN);
      await manager.claimLivenessOwnership(base, "new-base-token");
      expect(manager.getSession(base)?.livenessOwnerToken).toBe("new-base-token");
      const before = { ...reservations(s).get(label)! };
      const refused = await s.daemon.pool.restoreOwnedDeviceSessionsForMcpSession(
        [base],
        "refused-base-reconnect",
        matchesHold ? OWNER_TOKEN : "rival-token",
      );
      expect(refused).toEqual([
        { sessionId: base, deviceId: "emulator-5556", reason: "owned-by-other-connection" },
      ]);
      const owners = reservations(s).get(label)!.ownerMcpSessionIds!;
      expect(owners.has("refused-base-reconnect")).toBe(matchesHold);
      expect(reservations(s).get(label)).toEqual({ ...before, ownerMcpSessionIds: owners });
      expect(manager.getSession(label)).toBeNull();
      expect(s.deviceBootCount()).toBe(0);
    });
  }

  test("a base restore closed while waiting for assignmentMutex credits no label hold", async () => {
    const { s, base, label } = await labelHandoff();
    const pool = s.daemon.pool;
    const mutex = (pool as unknown as { assignmentMutex: Mutex }).assignmentMutex;
    const unlock = await mutex.acquire();
    const before = { ...reservations(s).get(label)! };
    const restore = pool.restoreOwnedDeviceSessionsForMcpSession(
      [base],
      "closed-label-restore",
      OWNER_TOKEN,
    );
    try {
      await drainMicrotasks();
      expect(reservations(s).get(label)).toEqual(before);
      pool.releaseMcpSessionBindings("closed-label-restore");
    } finally {
      unlock();
    }
    expect(await restore).toEqual([]);
    expect(reservations(s).get(label)).toEqual(before);
    expect(pool.hasConnectedMcpSessionOwner(base, s.proxyConnectionId())).toBe(false);
    expect(s.daemon.manager.getSession(label)).toBeNull();
  });

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
