import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import {
  DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_EXECUTION_METHOD,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { MANAGED_EXECUTION_RELEASE_TIMEOUT_MS } from "../../src/daemon/managedExecutionLiveness";
import type { ManagedSlotConfig } from "../../src/models/managedSlotConfig";
import type { ManagedSlotsResult } from "../../src/models/managedSlotsResult";
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
const CONFIG: ManagedSlotConfig = {
  contractVersion: 1,
  managedHostScope: "host",
  runnerNamespace: "runner",
  runnerIncarnation: "boot",
  localSlotCapacity: 1,
  preparationTimeoutMs: 100,
  requests: [{ slotIndex: 0, role: "app", platform: "android", requestedSpec: {} }],
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
  parkHeartbeat = false;
  parkRelease = false;
  dropAfterReply = false;
  parkReconnect = false;
  parkTokenListing = false;
  result: ManagedSlotsResult | undefined;
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
              return this.heartbeat.promise;
            }
            if (method === DAEMON_RELEASE_EXECUTION_METHOD && this.parkRelease) {
              return this.release.promise;
            }
            return {};
          },
        });
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

  acquire(): Promise<ManagedSlotsResult> {
    const pending = this.proxy.acquireManagedSlots(CONFIG);
    void pending.then((result) => {
      this.result = result;
    });
    return pending;
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
    expect((await pending).slots.every((slot) => slot.sessionUuid === null)).toBe(true);
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
    s.timer.advanceTime(MANAGED_EXECUTION_RELEASE_TIMEOUT_MS - 1);
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
