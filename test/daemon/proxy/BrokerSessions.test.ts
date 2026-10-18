import { describe, expect, test } from "bun:test";
import { BrokerSessions, type BrokerSessionsPort } from "../../../src/daemon/proxy/BrokerSessions";
import type { DaemonClientLike } from "../../../src/daemon/client";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import type { SessionBrokerResult } from "../../../src/devices/sessionBrokerResult";
import { SESSION_OWNERSHIP_LOST_CODE } from "../../../src/daemon/sessionReleasedDuringCall";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeTimer } from "../../fakes/FakeTimer";

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
  requestId: "request-1",
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

type Call = { method: string; params: Record<string, unknown> };

function rig(answer: (call: Call) => unknown = () => ready) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const calls: Call[] = [];
  const events: string[] = [];
  const state = { bound: undefined as string | undefined, closing: false };
  const client = new FakeDaemonClient({
    onCallDaemonMethod: (method, params) => {
      calls.push({ method, params });
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      return answer({ method, params });
    },
  });
  const state2 = {
    client: client as DaemonClientLike | null,
    establishError: undefined as unknown,
  };
  const port: BrokerSessionsPort = {
    ensureConnected: async () => {},
    requireClient: () => client,
    client: () => state2.client,
    isClosing: () => state.closing,
    boundSessionUuid: () => state.bound,
    terminalBoundSessionUuid: () => undefined,
    bindStartupSession: (uuid) => {
      state.bound = uuid;
      events.push(`bind:${uuid}`);
    },
    establishBoundSessionHeartbeat: async () => {
      events.push("establish");
      if (state2.establishError) {
        throw state2.establishError;
      }
    },
    fenceBoundSession: (uuid, code) => events.push(`fence:${uuid}:${code}`),
    forgetBoundSession: (uuid) => {
      events.push(`forget:${uuid}`);
      if (state.bound === uuid) {
        state.bound = undefined;
      }
    },
  };
  const brokerSessions = new BrokerSessions({ timer, livenessOwnerToken: "owner-1", port });
  return { brokerSessions, calls, events, state, state2, client };
}

describe("BrokerSessions", () => {
  test("acquire binds, establishes ownership and exposes the held binding", async () => {
    const { brokerSessions, events } = rig();
    expect(brokerSessions.result).toBeUndefined();

    expect(await brokerSessions.acquire(config)).toEqual(ready);

    expect(events).toEqual(["bind:session-1", "establish"]);
    expect(brokerSessions.result).toEqual(ready);
    expect(brokerSessions.sessions.get("session-1")).toBe("request-1");
    expect(brokerSessions.heldBinding()).toEqual({
      requestId: "request-1",
      sessionUuid: "session-1",
    });
  });

  test("a failed ownership establishment leaves no held binding and releases the receipt", async () => {
    const { brokerSessions, calls, events, state2 } = rig();
    state2.establishError = new Error("claim refused");

    const result = await brokerSessions.acquire(config);

    expect(result.outcome).toBe("failed");
    expect(brokerSessions.heldBinding()).toBeUndefined();
    expect(brokerSessions.sessions.size).toBe(0);
    expect(events).toContain("forget:session-1");
    expect(calls.some(({ method }) => method === "daemon/releaseBrokerSession")).toBe(true);
  });

  test("rebindConnection re-registers the held receipt on the new socket", async () => {
    const { brokerSessions, calls, client } = rig();
    await brokerSessions.acquire(config);

    await brokerSessions.rebindConnection(client);

    const register = calls.find(({ method }) => method === "daemon/registerSession")!;
    expect(register.params).toEqual({
      sessionId: "session-1",
      clientName: "auto-mobile-session-broker-proxy",
      sessionBroker: { requestId: "request-1", livenessOwnerToken: "owner-1" },
    });
  });

  test("rebindConnection ignores a stale client and a closing proxy", async () => {
    const { brokerSessions, calls, client, state, state2 } = rig();
    await brokerSessions.acquire(config);

    state2.client = null;
    await brokerSessions.rebindConnection(client);
    state2.client = client;
    state.closing = true;
    await brokerSessions.rebindConnection(client);

    expect(calls.some(({ method }) => method === "daemon/registerSession")).toBe(false);
  });

  test("an ownership-lost rebind fences the binding and drops the receipt", async () => {
    const { brokerSessions, events, client } = rig((call) => {
      if (call.method === "daemon/registerSession") {
        throw Object.assign(new Error("lost"), { code: SESSION_OWNERSHIP_LOST_CODE });
      }
      return ready;
    });
    await brokerSessions.acquire(config);

    await brokerSessions.rebindConnection(client);

    expect(events).toContain(`fence:session-1:${SESSION_OWNERSHIP_LOST_CODE}`);
    expect(brokerSessions.heldBinding()).toBeUndefined();
  });

  test("releaseAll releases each session with the reason, then forgets it", async () => {
    const { brokerSessions, calls, events } = rig((call) =>
      call.method === "daemon/releaseBrokerSession"
        ? { sessionUuid: call.params.sessionId, outcome: "released" }
        : ready,
    );
    await brokerSessions.acquire(config);

    await brokerSessions.releaseAll("session_owner_exited");

    const release = calls.find(({ method }) => method === "daemon/releaseBrokerSession")!;
    expect(release.params).toMatchObject({
      sessionId: "session-1",
      livenessOwnerToken: "owner-1",
      reason: "session_owner_exited",
    });
    expect(brokerSessions.sessions.size).toBe(0);
    expect(brokerSessions.heldBinding()).toBeUndefined();
    expect(events).toContain("forget:session-1");
  });

  test("releaseAll forgets the session even when the daemon is unreachable", async () => {
    const { brokerSessions, events, state2 } = rig();
    await brokerSessions.acquire(config);
    state2.client = null;

    await brokerSessions.releaseAll();

    expect(events).toContain("forget:session-1");
    expect(brokerSessions.sessions.size).toBe(0);
  });

  test("clear drops every hold without calling the daemon", async () => {
    const { brokerSessions, calls } = rig();
    await brokerSessions.acquire(config);
    const before = calls.length;

    brokerSessions.clear();

    expect(brokerSessions.sessions.size).toBe(0);
    expect(brokerSessions.heldBinding()).toBeUndefined();
    expect(calls.length).toBe(before);
  });
});
