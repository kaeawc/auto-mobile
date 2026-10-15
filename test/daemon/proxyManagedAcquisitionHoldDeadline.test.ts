import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonClient,
  DaemonShuttingDownError,
  DaemonUnavailableError,
} from "../../src/daemon/client";
import {
  DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_EXECUTION_METHOD,
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_SHUTTING_DOWN_ERROR_CODE,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { BROKER_EXECUTION_RELEASE_TIMEOUT_MS } from "../../src/daemon/sessionBroker/provisioning/executionLiveness";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
} from "../../src/daemon/types";
import type { BrokerProvisionRequest } from "../../src/daemon/sessionBroker/provisioning/provisionRequest";
import type { BindingsResult } from "../../src/daemon/sessionBroker/provisioning/acquisitionResult";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-2222-4333-8444-555555555555";
const TOKEN = "managed-acquisition-owner";
const INTERVAL = 2_000;
const CONFIG: BrokerProvisionRequest = {
  contractVersion: 1,
  managedHostScope: "host",
  runnerNamespace: "runner",
  runnerIncarnation: "boot",
  localBindingCapacity: 1,
  preparationTimeoutMs: 100,
  requests: [{ bindingIndex: 0, role: "app", platform: "android", requestedSpec: {} }],
};
const READY = readyManagedSlotsResult(SESSION);

/** Park real wire awaits without invoking a daemon, device, database or host process. */
class HoldScenario {
  readonly timer = new FakeTimer();
  readonly clients: FakeDaemonClient[] = [];
  readonly heartbeat = Promise.withResolvers<unknown>();
  readonly release = Promise.withResolvers<unknown>();
  readonly reconnect = Promise.withResolvers<void>();
  readonly tokenListing = Promise.withResolvers<unknown>();
  readonly registration = Promise.withResolvers<unknown>();
  parkHeartbeat = false;
  parkRelease = false;
  dropAfterReply = false;
  parkReconnect = false;
  parkTokenListing = false;
  recoverClaim = false;
  replacementUnavailable = false;
  parkRegistration = false;
  readonly claimRefusals: Error[] = [];
  readonly registrationRefusals: unknown[] = [];
  result: BindingsResult | undefined;
  readonly proxy: DaemonMcpProxy;

  constructor() {
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    this.proxy = new DaemonMcpProxy({
      timer: this.timer,
      livenessOwnerToken: TOKEN,
      heartbeatIntervalMs: INTERVAL,
      autoStartDaemon: false,
      daemonManager: manager,
      clientFactory: () => {
        const index = this.clients.length;
        const client = new FakeDaemonClient({
          onCallDaemonMethod: (method) => {
            if (method === "daemon/capabilities") {
              return { capabilities: ["managed-slots/v1"] };
            }
            if (method === DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD) {
              if (this.dropAfterReply) {
                client.emitConnectionClosed();
              }
              return READY;
            }
            if (method === DAEMON_TOKEN_OWNED_SESSIONS_METHOD) {
              return index > 0 && this.parkTokenListing
                ? this.tokenListing.promise
                : { sessions: [] };
            }
            if (method === DAEMON_HEARTBEAT_METHOD && this.parkHeartbeat) {
              if (index > 0 && this.recoverClaim) {
                const refusal = this.claimRefusals.shift();
                if (refusal) {
                  throw refusal;
                }
                return { accepted: true };
              }
              return this.heartbeat.promise;
            }
            if (method === DAEMON_REGISTER_SESSION_METHOD) {
              const refusal = this.registrationRefusals.shift();
              if (refusal) {
                throw refusal;
              }
              if (this.parkRegistration) {
                return this.registration.promise;
              }
            }
            if (method === DAEMON_RELEASE_EXECUTION_METHOD && this.parkRelease) {
              return this.release.promise;
            }
            return {};
          },
        });
        client.shouldFailConnect = index > 0 && this.replacementUnavailable;
        if (index > 0 && this.parkReconnect) {
          const connect = client.connect.bind(client);
          client.connect = async () => {
            await this.reconnect.promise;
            await connect();
          };
        }
        this.clients.push(client);
        return client;
      },
    });
  }

  acquire(preparationTimeoutMs = CONFIG.preparationTimeoutMs): Promise<BindingsResult> {
    const pending = this.proxy.acquireBindings({ ...CONFIG, preparationTimeoutMs });
    void pending.then((result) => {
      this.result = result;
    });
    return pending;
  }

  loseClaimConnection(): void {
    this.clients[0]!.emitConnectionClosed();
    this.heartbeat.reject(new DaemonUnavailableError("Daemon socket closed"));
  }

  async step(ms: number): Promise<void> {
    this.timer.advanceTime(ms);
    await drainMicrotasks(150);
  }

  calls(method: string, sessionId = SESSION) {
    return this.clients
      .flatMap((client) => client.callDaemonMethodCalls)
      .filter((call) => call.method === method && call.params.sessionId === sessionId);
  }

  async expire(): Promise<void> {
    this.timer.advanceTime(100);
    await drainMicrotasks(150);
    expect(this.result).toMatchObject({
      outcome: "failed",
      failure: { code: "timeout", retryable: true },
    });
    expect(this.proxy.getManagedSlotsResult()).toBe(this.result);
  }

  assertAbandoned(): void {
    expect(this.proxy.getManagedExecutionSessions()).toEqual([]);
    // Inspect private state through Reflect, without changing the production test surface.
    expect(Reflect.get(this.proxy, "boundSessionUuid")).toBeUndefined();
    expect(Reflect.get(this.proxy, "heartbeatKeeperStarted")).toBe(false);
    for (const key of ["ownedDeviceSessions", "claimableSessions", "otherHeldSessions"]) {
      // close owns teardown and retains claim permissions, which alone are not heartbeat targets.
      if (key === "claimableSessions" && Reflect.get(this.proxy, "closing")) {
        continue;
      }
      expect(Reflect.get(this.proxy, key).has(SESSION)).toBe(false);
    }
  }

  async noMoreHeartbeats(): Promise<void> {
    const before = this.calls(DAEMON_HEARTBEAT_METHOD).length;
    for (let tick = 0; tick < 4; tick++) {
      this.timer.advanceTime(INTERVAL);
      await drainMicrotasks(150);
    }
    expect(this.calls(DAEMON_HEARTBEAT_METHOD)).toHaveLength(before);
    this.assertAbandoned();
  }
}

describe("managed acquisition hold deadline on the proxy", () => {
  let available: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  const scenarios: HoldScenario[] = [];
  beforeEach(() => {
    available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const scenario of scenarios.splice(0)) {
      scenario.reconnect.resolve();
      scenario.tokenListing.resolve({ sessions: [] });
      scenario.registration.resolve({ accepted: true });
      scenario.heartbeat.resolve({});
      scenario.release.resolve({});
      await drainMicrotasks(150);
      await scenario.proxy.close();
      scenario.timer.reset();
    }
    available.mockRestore();
    warn.mockRestore();
  });
  function scenario(): HoldScenario {
    const value = new HoldScenario();
    scenarios.push(value);
    return value;
  }

  test("lost claiming heartbeat acknowledgment times out and late success cannot restore the hold", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    expect(s.calls(DAEMON_HEARTBEAT_METHOD)[0]?.params).toMatchObject({
      claimLivenessOwnership: true,
      livenessOwnerToken: TOKEN,
    });
    await s.expire();
    expect((await pending).bindings.every((binding) => binding.sessionUuid === null)).toBe(true);
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)[0]?.params).toEqual({
      sessionId: SESSION,
      livenessOwnerToken: TOKEN,
    });
    s.assertAbandoned();
    await s.noMoreHeartbeats();
    s.heartbeat.resolve({});
    await drainMicrotasks(150);
    await s.noMoreHeartbeats();
    expect(s.proxy.getManagedSlotsResult()).toBe(s.result);
    await expect(s.proxy.holdManagedExecutionSession(SESSION)).rejects.toThrow();
  });

  test("late failed acknowledgment leaves the failed result and a newer binding intact", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    await s.expire();
    await pending;
    s.parkHeartbeat = false;
    await s.proxy.holdManagedExecutionSession(OTHER);
    s.heartbeat.reject(new Error("lost acknowledgment"));
    await drainMicrotasks(150);
    expect(s.proxy.getManagedExecutionSessions()).toEqual([OTHER]);
    expect(Reflect.get(s.proxy, "boundSessionUuid")).toBe(OTHER);
    expect(s.proxy.getManagedSlotsResult()).toBe(s.result);
    const before = s.calls(DAEMON_HEARTBEAT_METHOD).length;
    s.timer.advanceTime(INTERVAL);
    await drainMicrotasks(150);
    expect(s.calls(DAEMON_HEARTBEAT_METHOD)).toHaveLength(before);
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
  });

  test("lost release acknowledgment is bounded and local targets disappear before it settles", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.parkRelease = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    s.timer.advanceTime(100);
    await drainMicrotasks(150);
    expect(s.result).toBeUndefined();
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
    s.assertAbandoned();
    s.timer.advanceTime(BROKER_EXECUTION_RELEASE_TIMEOUT_MS - 1);
    await drainMicrotasks(150);
    expect(s.result).toBeUndefined();
    s.timer.advanceTime(1);
    await drainMicrotasks(150);
    expect(s.result).toMatchObject({ outcome: "failed", failure: { code: "timeout" } });
    await pending;
    await s.noMoreHeartbeats();
    s.release.resolve({});
    s.heartbeat.resolve({});
    await drainMicrotasks(150);
    await s.noMoreHeartbeats();
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
    expect(s.proxy.getManagedSlotsResult()).toBe(s.result);
  });

  test("reconnect parked between reply and hold is bounded and cannot claim after reconnecting late", async () => {
    const s = scenario();
    s.dropAfterReply = true;
    s.parkReconnect = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    expect(s.clients).toHaveLength(2);
    await s.expire();
    await pending;
    s.assertAbandoned();
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
    s.reconnect.resolve();
    await drainMicrotasks(150);
    expect(s.calls(DAEMON_HEARTBEAT_METHOD)).toHaveLength(0);
    await s.noMoreHeartbeats();
  });

  test("reconnect finishing inside the deadline holds and heartbeats on the new connection", async () => {
    const s = scenario();
    s.dropAfterReply = true;
    s.parkReconnect = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    s.timer.advanceTime(50);
    s.reconnect.resolve();
    await drainMicrotasks(150);
    expect(s.result).toBe(READY);
    expect(await pending).toBe(READY);
    expect(s.proxy.getManagedExecutionSessions()).toEqual([SESSION]);
    expect(
      s.clients[1]?.callDaemonMethodCalls.some(
        (call) => call.method === DAEMON_HEARTBEAT_METHOD && call.params.sessionId === SESSION,
      ),
    ).toBe(true);
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(0);
  });

  test("stale token-owned listing after abandonment cannot resume, claim or heartbeat the released session", async () => {
    const s = scenario();
    s.dropAfterReply = true;
    s.parkTokenListing = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    expect(
      s.clients[1]?.callDaemonMethodCalls.some(
        (call) => call.method === DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
      ),
    ).toBe(true);
    await s.expire();
    await pending;
    s.assertAbandoned();
    const before = s.calls(DAEMON_HEARTBEAT_METHOD).length;
    s.tokenListing.resolve({
      sessions: [
        {
          sessionId: SESSION,
          deviceId: "emulator-fake",
          platform: "android",
          lastUsedAt: s.timer.now(),
        },
      ],
    });
    await drainMicrotasks(150);
    expect(s.calls(DAEMON_HEARTBEAT_METHOD)).toHaveLength(before);
    await s.noMoreHeartbeats();
    expect(s.proxy.getManagedSlotsResult()).toBe(s.result);
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
  });

  test("close during a parked hold cancels acquisition and owns exactly one release", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    await s.proxy.close();
    await drainMicrotasks(150);
    expect(s.result).toMatchObject({ outcome: "failed", failure: { code: "cancelled" } });
    await pending;
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
    expect(s.proxy.isConnected()).toBe(false);
    s.assertAbandoned();
    s.heartbeat.resolve({});
    await drainMicrotasks(150);
    await s.noMoreHeartbeats();
    expect(s.proxy.getManagedSlotsResult()).toBe(s.result);
  });

  test("ready acquisition keeps the hold and a second different session is refused", async () => {
    const s = scenario();
    expect(await s.acquire()).toBe(READY);
    await expect(s.proxy.holdManagedExecutionSession(OTHER)).rejects.toThrow("already bound");
    expect(s.proxy.getManagedExecutionSessions()).toEqual([SESSION]);
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(0);
  });

  test("a lost claiming heartbeat waits through paced outages for claim and managed registration", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.replacementUnavailable = true;
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    expect(s.result).toBeUndefined();
    for (const delay of [25, 50, 100]) {
      await s.step(delay);
      expect(s.result).toBeUndefined();
    }
    s.replacementUnavailable = false;
    await s.step(200);
    expect(s.result?.outcome).toBe("ready");
    expect(await pending).toEqual(READY);
    const calls = s.clients.at(-1)!.callDaemonMethodCalls;
    expect(calls.find((call) => call.method === DAEMON_HEARTBEAT_METHOD)?.params).toMatchObject({
      sessionId: SESSION,
      claimLivenessOwnership: true,
      livenessOwnerToken: TOKEN,
    });
    expect(calls.find((call) => call.method === DAEMON_REGISTER_SESSION_METHOD)?.params).toEqual({
      sessionId: SESSION,
      clientName: "auto-mobile-managed-slot-proxy",
      bindings: {
        scopeKey: READY.scope.scopeKey,
        sessionUuids: [SESSION],
        livenessOwnerToken: TOKEN,
      },
    });
  });

  test("a lost claiming heartbeat never publishes ready when the replacement misses the deadline", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.replacementUnavailable = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    expect(s.result).toBeUndefined();
    await s.step(25);
    await s.step(50);
    expect(s.result).toBeUndefined();
    await s.step(25);
    expect(await pending).toMatchObject({ outcome: "failed", failure: { code: "timeout" } });
    s.assertAbandoned();
    // No client is reachable: abandonment leaves release to the daemon's existing lease cleanup.
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(0);
    await s.noMoreHeartbeats();
  });

  test.each([undefined, "daemon-restart"])(
    "not-found claim with reason %s retries before ready",
    async (releaseReason) => {
      const s = scenario();
      s.parkHeartbeat = true;
      s.recoverClaim = true;
      s.claimRefusals.push(
        Object.assign(new Error("rehydration pending"), {
          code: DAEMON_SESSION_NOT_FOUND_CODE,
          releaseReason,
        }),
      );
      const pending = s.acquire(1_000);
      await drainMicrotasks(150);
      s.loseClaimConnection();
      await drainMicrotasks(150);
      expect(s.result).toBeUndefined();
      await s.step(25);
      expect(s.result).toBeUndefined();
      await s.step(50);
      expect(s.result?.outcome).toBe("ready");
      expect(await pending).toEqual(READY);
      expect(
        s.calls(DAEMON_HEARTBEAT_METHOD).filter((call) => call.params.claimLivenessOwnership),
      ).toHaveLength(3);
    },
  );

  test.each([
    {
      name: "device restart",
      fields: {
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        releaseReason: "device-restart:emulator-5554",
      },
    },
    {
      name: "terminal release",
      fields: { code: DAEMON_SESSION_NOT_FOUND_CODE, releaseReason: "explicit-release" },
    },
    { name: "owner conflict", fields: { code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE } },
    {
      name: "retryable owner conflict",
      fields: { code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE, retryable: true },
    },
    { name: "retryable database refusal", fields: { code: "SQLITE_BUSY", retryable: true } },
  ])("a $name claim fails the hold immediately", async ({ fields }) => {
    const s = scenario();
    s.parkHeartbeat = true;
    const pending = s.acquire();
    await drainMicrotasks(150);
    s.heartbeat.reject(Object.assign(new Error("claim refused"), fields));
    await drainMicrotasks(150);
    expect(s.result).toMatchObject({
      outcome: "failed",
      failure: { code: "execution_hold_failed" },
    });
    expect(await pending).toBe(s.result!);
    expect(s.timer.now()).toBe(0);
    expect(
      s.calls(DAEMON_HEARTBEAT_METHOD).filter((call) => call.params.claimLivenessOwnership),
    ).toHaveLength(1);
    expect(s.calls(DAEMON_RELEASE_EXECUTION_METHOD)).toHaveLength(1);
    s.assertAbandoned();
  });

  test.each([true, false])(
    "replacement registration retryable=%s must settle before ready",
    async (retryable) => {
      const s = scenario();
      s.parkHeartbeat = true;
      s.recoverClaim = true;
      s.registrationRefusals.push(
        Object.assign(new Error("managed registration refused"), {
          code: "managed_slot_registration_refused",
          retryable,
        }),
      );
      const pending = s.acquire(1_000);
      await drainMicrotasks(150);
      s.loseClaimConnection();
      await drainMicrotasks(150);
      await s.step(25);
      if (retryable) {
        expect(s.result).toBeUndefined();
        await s.step(50);
        expect(s.result?.outcome).toBe("ready");
      } else {
        expect(s.result).toMatchObject({
          outcome: "failed",
          failure: { code: "execution_hold_failed" },
        });
        expect(s.timer.now()).toBe(25);
        expect(s.calls(DAEMON_REGISTER_SESSION_METHOD)).toHaveLength(1);
      }
      expect(await pending).toBe(s.result!);
    },
  );

  test.each([
    {
      name: "release still draining",
      failure: new Error("release is still in progress; retry registration"),
    },
    { name: "SQLITE_BUSY", failure: { code: "SQLITE_BUSY", retryable: true } },
  ])("replacement registration retries $name before ready", async ({ failure }) => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.registrationRefusals.push(failure);
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    await s.step(25);
    expect(s.result).toBeUndefined();
    expect(s.calls(DAEMON_REGISTER_SESSION_METHOD)).toHaveLength(1);
    await s.step(50);
    expect(s.result?.outcome).toBe("ready");
    expect(await pending).toEqual(READY);
    expect(s.calls(DAEMON_REGISTER_SESSION_METHOD)).toHaveLength(2);
  });

  test("replacement registration honours its 500 ms retry minimum", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.registrationRefusals.push({
      code: "managed_slot_registration_refused",
      retryable: true,
      retryAfterMs: 500,
    });
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    await s.step(25);
    expect(s.calls(DAEMON_REGISTER_SESSION_METHOD)).toHaveLength(1);
    expect(s.result).toBeUndefined();
    await s.step(499);
    expect(s.calls(DAEMON_REGISTER_SESSION_METHOD)).toHaveLength(1);
    expect(s.result).toBeUndefined();
    await s.step(1);
    expect(s.result?.outcome).toBe("ready");
    expect(await pending).toEqual(READY);
    expect(s.calls(DAEMON_REGISTER_SESSION_METHOD)).toHaveLength(2);
  });

  test.each([
    { name: "typed", failure: new DaemonShuttingDownError() },
    { name: "coded", failure: { code: DAEMON_SHUTTING_DOWN_ERROR_CODE, retryable: false } },
  ])("replacement registration reconnects after a $name shutdown answer", async ({ failure }) => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.registrationRefusals.push(failure);
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    await s.step(25);
    expect(s.result).toBeUndefined();
    const shuttingDownClient = s.clients[1]!;
    expect(
      shuttingDownClient.callDaemonMethodCalls.filter(
        (call) => call.method === DAEMON_REGISTER_SESSION_METHOD,
      ),
    ).toHaveLength(1);
    await s.step(50);
    expect(s.result?.outcome).toBe("ready");
    expect(await pending).toEqual(READY);
    expect(s.clients).toHaveLength(3);
    expect(
      s.clients[2]!.callDaemonMethodCalls.filter(
        (call) => call.method === DAEMON_REGISTER_SESSION_METHOD,
      ),
    ).toHaveLength(1);
  });

  test.each([
    { name: "explicit false without a code", failure: { retryable: false } },
    { name: "code without retry intent", failure: { code: "registration_refused" } },
  ])("replacement registration fails immediately on $name", async ({ failure }) => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.registrationRefusals.push(failure);
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    await s.step(25);
    expect(s.result).toMatchObject({
      outcome: "failed",
      failure: { code: "execution_hold_failed" },
    });
    expect(await pending).toBe(s.result!);
    expect(s.timer.now()).toBe(25);
    expect(s.calls(DAEMON_REGISTER_SESSION_METHOD)).toHaveLength(1);
    s.assertAbandoned();
  });

  test("normal acquisition keeps exactly its existing call order and adds no wait", async () => {
    const s = scenario();
    expect(await s.acquire()).toEqual(READY);
    expect(s.clients).toHaveLength(1);
    expect(s.clients[0]!.callDaemonMethodCalls.map((call) => call.method)).toEqual([
      DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
      "daemon/capabilities",
      DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
      DAEMON_HEARTBEAT_METHOD,
    ]);
    expect(s.timer.now()).toBe(0);
  });

  test("a late successful claim on the closed connection cannot publish ready", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.clients[0]!.emitConnectionClosed();
    s.heartbeat.resolve({ accepted: true });
    await drainMicrotasks(150);
    expect(s.result).toBeUndefined();
    await s.step(25);
    expect(s.result?.outcome).toBe("ready");
    expect(await pending).toEqual(READY);
    expect(s.clients[1]!.callDaemonMethodCalls.map((call) => call.method)).toContain(
      DAEMON_REGISTER_SESSION_METHOD,
    );
  });

  test("a registration ack on an obsolete replacement cannot finish the hold", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.parkRegistration = true;
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    await s.step(25);
    expect(s.result).toBeUndefined();
    expect(s.clients[1]!.callDaemonMethodCalls.map((call) => call.method)).toContain(
      DAEMON_REGISTER_SESSION_METHOD,
    );
    s.clients[1]!.emitConnectionClosed();
    s.parkRegistration = false;
    s.registration.resolve({ accepted: true });
    await drainMicrotasks(150);
    expect(s.result).toBeUndefined();
    await s.step(50);
    expect(s.result?.outcome).toBe("ready");
    expect(await pending).toEqual(READY);
    expect(s.clients[2]!.callDaemonMethodCalls.map((call) => call.method)).toContain(
      DAEMON_REGISTER_SESSION_METHOD,
    );
  });

  test("closing during a paced outage cancels instead of publishing ready", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    s.recoverClaim = true;
    s.replacementUnavailable = true;
    const pending = s.acquire(1_000);
    await drainMicrotasks(150);
    s.loseClaimConnection();
    await drainMicrotasks(150);
    await s.proxy.close();
    expect(await pending).toMatchObject({ outcome: "failed", failure: { code: "cancelled" } });
    s.assertAbandoned();
    const clients = s.clients.length;
    await s.step(1_000);
    expect(s.clients).toHaveLength(clients);
  });

  test("the hold signal cancels an outstanding claim without waiting for its reply", async () => {
    const s = scenario();
    s.parkHeartbeat = true;
    const abort = new AbortController();
    let settled = false;
    const pending = s.proxy.holdManagedExecutionSession(SESSION, abort.signal).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await drainMicrotasks(150);
    expect(s.calls(DAEMON_HEARTBEAT_METHOD)).toHaveLength(1);
    abort.abort(new Error("hold cancelled"));
    await drainMicrotasks(150);
    expect(settled).toBe(true);
    expect(String(await pending)).toContain("hold cancelled");
  });

  test("a non-managed initial binding still connects after its first heartbeat fails", async () => {
    const timer = new FakeTimer();
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const client = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === DAEMON_HEARTBEAT_METHOD) {
          throw new DaemonUnavailableError("heartbeat transport failure");
        }
      },
    });
    const proxy = new DaemonMcpProxy({
      timer,
      initialSessionUuid: SESSION,
      autoStartDaemon: false,
      daemonManager: manager,
      clientFactory: () => client,
    });
    try {
      await proxy.ensureConnected();
      expect(proxy.isConnected()).toBe(true);
      expect(
        client.callDaemonMethodCalls.filter((call) => call.method === DAEMON_HEARTBEAT_METHOD),
      ).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  test("an already-aborted hold refuses before binding or sending anything", async () => {
    const s = scenario();
    const abort = new AbortController();
    abort.abort(new Error("caller cancelled"));
    await expect(s.proxy.holdManagedExecutionSession(SESSION, abort.signal)).rejects.toThrow(
      "caller cancelled",
    );
    s.assertAbandoned();
    expect(s.clients).toHaveLength(0);
  });
});
