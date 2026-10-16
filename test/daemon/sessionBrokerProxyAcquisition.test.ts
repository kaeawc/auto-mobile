import { describe, expect, test } from "bun:test";
import {
  acquireSessionThroughDaemon,
  DAEMON_PREPARE_SESSION_METHOD,
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
  DAEMON_SESSION_REQUEST_STATUS_METHOD,
  type SessionBrokerProxyAcquisitionPorts,
} from "../../src/daemon/sessionBrokerProxyAcquisition";
import type { SessionConfig } from "../../src/devices/sessionConfig";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

const config: SessionConfig = {
  contractVersion: 1,
  requestId: "request-1",
  device: {
    schemaVersion: 1,
    platform: "android",
    hardware: { kind: "archetype", archetype: "phone" },
    os: { kind: "major", major: 35 },
  },
  preparationTimeoutMs: 20_000,
};
const ready: SessionBrokerResult = {
  contractVersion: 1,
  requestId: config.requestId,
  outcome: "ready",
  sessionUuid: "session-1",
  profile: {
    platform: "android",
    metadataState: "current",
    profileId: "pixel_8",
    systemImagePackage: "system-images;android-35;google_apis;x86_64",
    osVersion: "15",
    versionPrecision: "major",
    apiLevel: 35,
    abi: "x86_64",
    flavor: "google_apis",
  },
  cleanupPending: false,
};

function rig(
  answer: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
  autoAdvance = true,
) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const held: Array<{ requestId: string; sessionUuid: string }> = [];
  const ports: SessionBrokerProxyAcquisitionPorts = {
    ensureConnected: async () => {},
    callDaemonMethod: async (method, params) => {
      calls.push({ method, params });
      return await answer(method, params);
    },
    holdSession: async (requestId, sessionUuid) => {
      held.push({ requestId, sessionUuid });
    },
    releaseSession: async (sessionUuid) =>
      answer(DAEMON_RELEASE_BROKER_SESSION_METHOD, { sessionId: sessionUuid }),
    livenessOwnerToken: "owner-1",
    timer,
  };
  return { ports, calls, held, timer };
}

describe("session broker proxy acquisition", () => {
  test.each([false, true])(
    "preserves transient failure retryability through lost reply=%s",
    async (lostReply) => {
      const receipt: SessionBrokerResult = {
        ...ready,
        outcome: "failed",
        sessionUuid: null,
        profile: null,
        failure: { code: "timeout", message: "runner-setup timed out", retryable: true },
      };
      const { ports, held } = rig((method) => {
        if (method === "daemon/capabilities") {
          return { capabilities: ["session-broker/v1"] };
        }
        if (lostReply && method === DAEMON_PREPARE_SESSION_METHOD) {
          throw new Error("reply lost");
        }
        return receipt;
      });
      expect(await acquireSessionThroughDaemon(config, ports)).toEqual(receipt);
      expect(held).toEqual([]);
    },
  );

  test("forwards the owner PID but omits its proxy-only start identity without mutating config", async () => {
    const ownerConfig = {
      ...config,
      executionOwnerPid: 4242,
      executionOwnerStartIdentity: "T1",
    };
    const { ports, calls } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : ready,
    );
    expect(await acquireSessionThroughDaemon(ownerConfig, ports)).toEqual(ready);
    const prepare = calls.find(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)!;
    expect(prepare.params.config).not.toHaveProperty("executionOwnerStartIdentity");
    expect(prepare.params.config).toEqual({ ...config, executionOwnerPid: 4242 });
    expect(ownerConfig).toEqual({
      ...config,
      executionOwnerPid: 4242,
      executionOwnerStartIdentity: "T1",
    });
  });

  test("prepares once with no allocation controls and holds the exact ready UUID", async () => {
    const { ports, calls, held } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : ready,
    );

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    const prepare = calls.find(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)!;
    expect(prepare.params).toEqual({
      config,
      livenessOwnerToken: "owner-1",
    });
    expect(prepare.params).not.toHaveProperty("scope");
    expect(prepare.params).not.toHaveProperty("slot");
    expect(held).toEqual([{ requestId: "request-1", sessionUuid: "session-1" }]);
  });

  test("a lost prepare reply polls only the same durable request", async () => {
    let prepareCalls = 0;
    const { ports, calls } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_PREPARE_SESSION_METHOD) {
        prepareCalls++;
        throw new Error("reply lost");
      }
      return ready;
    });

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    expect(prepareCalls).toBe(1);
    expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual([
      {
        method: DAEMON_SESSION_REQUEST_STATUS_METHOD,
        params: { requestId: "request-1", livenessOwnerToken: "owner-1" },
      },
    ]);
  });

  test("pending preparation converges through status without another prepare", async () => {
    const pending = { ...ready, outcome: "pending", sessionUuid: null, profile: null } as const;
    let statuses = 0;
    const { ports, calls } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_PREPARE_SESSION_METHOD) {
        return pending;
      }
      return ++statuses === 1 ? pending : ready;
    });

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(statuses).toBe(2);
  });

  test("permanently pending work stops at the one deadline with the same identity", async () => {
    const pending = { ...ready, outcome: "pending", sessionUuid: null, profile: null } as const;
    const { ports, calls } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : pending,
    );

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(pending);
    expect(ports.timer.now()).toBe(config.preparationTimeoutMs!);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(
      calls
        .filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)
        .every(
          ({ params }) =>
            params.requestId === config.requestId &&
            params.livenessOwnerToken === ports.livenessOwnerToken,
        ),
    ).toBe(true);
  });

  test("shutdown cancellation stops same-request polling without minting a replacement", async () => {
    const pending = { ...ready, outcome: "pending", sessionUuid: null, profile: null } as const;
    const { ports, calls, held, timer } = rig(
      (method) =>
        method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : pending,
      false,
    );
    const controller = new AbortController();

    const acquisition = acquireSessionThroughDaemon(config, ports, controller.signal);
    await drainMicrotasks(16);
    expect(timer.getPendingSleepCount()).toBe(1);

    controller.abort();
    timer.advanceTime(250);
    await drainMicrotasks(16);

    expect(await acquisition).toEqual(pending);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(held).toEqual([]);
  });

  test("a failed hold uses broker release and retains incomplete cleanup", async () => {
    const { ports } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_RELEASE_BROKER_SESSION_METHOD) {
        return { sessionUuid: "session-1", outcome: "cleanup_pending" };
      }
      return ready;
    });
    ports.holdSession = async () => {
      throw new Error("heartbeat refused");
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      cleanupPending: true,
      failure: { code: "session_hold_failed" },
    });
  });

  test("an unknown broker release cannot certify failed-hold cleanup", async () => {
    const { ports } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_RELEASE_BROKER_SESSION_METHOD) {
        return { sessionUuid: "session-1", outcome: "unknown_session" };
      }
      return ready;
    });
    ports.holdSession = async () => {
      throw new Error("heartbeat refused");
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
    });
  });

  test("missing capability fails before prepare", async () => {
    const { ports, calls } = rig(() => ({ capabilities: [] }));
    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: { code: "contract_unsupported", retryable: false },
    });
    expect(calls.some(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toBe(false);
  });

  test("preserves an authoritative terminal receipt with its original UUID and profile", async () => {
    const released = { ...ready, outcome: "released" } as const;
    const { ports, held } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : released,
    );

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(released);
    expect(held).toEqual([]);
  });
});
