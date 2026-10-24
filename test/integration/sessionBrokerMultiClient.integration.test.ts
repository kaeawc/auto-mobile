/**
 * Owner requirement: the broker serves several independent MCP clients, each holding sessions on
 * different devices. The real broker, durable registry, request handlers (`daemon/registerSession`,
 * `daemon/releaseSession`, `daemon/releaseBrokerSession`), per-socket connection scopes and
 * SessionManager run against a fake native device port; only device I/O and stdio are replaced.
 * Each "client" is a distinct liveness owner token on its own socket session id.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
} from "../../src/daemon/constants";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { brokerConnectionControlRefusal } from "../../src/daemon/sessionBroker/connectionScope";
import { DEVICE_OUTSIDE_BROKER_GRANT_CODE } from "../../src/daemon/sessionBroker/connectionRefusal";
import { SESSION_OWNER_EXITED_CODE } from "../../src/devices/sessionBrokerResult";
import { createFakeBrokerDaemon } from "../helpers/fakeBrokerDaemon";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { useScratchRoot } from "../helpers/scratchRoot";
import {
  acquire,
  connect,
  deviceOf,
  release,
  type Host,
  type Grant,
  type Client,
} from "../helpers/brokerMultiClient";

const A: Client = { name: "client-a", token: "token-a" };
const B: Client = { name: "client-b", token: "token-b" };

const hosts: Host[] = [];

beforeAll(async () => {
  // Keep first-open SQLite/schema initialization outside each scenario's 100 ms budget.
  const warm = await createFakeBrokerDaemon();
  try {
    await acquire(warm, A, 0);
  } finally {
    await warm.close();
  }
});

/** A restarted daemon mints fresh resource ids; a counter restarting at fake-1 would collide. */
function restartedIds() {
  return new FakeIdGenerator(Array.from({ length: 64 }, (_, i) => `restart-${i + 1}`));
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function open(options: Parameters<typeof createFakeBrokerDaemon>[0] = {}): Promise<Host> {
  const host = await createFakeBrokerDaemon(options);
  hosts.push(host);
  return host;
}

function refusalFor(host: Host, grant: Grant, target: { deviceId?: string; sessionUuid?: string }) {
  // The same confinement the socket server applies to every control frame (socketServer.ts
  // assertBrokerConnectionControl): the connection's own scope, resolved through the SessionManager.
  return brokerConnectionControlRefusal({
    binding: host.scopes.get(grant.socket),
    action: "input/tap",
    deviceId: target.deviceId,
    requesterSessionUuid: target.sessionUuid,
    grantedDeviceOf: (uuid) => host.sessions.getSession(uuid)?.assignedDevice ?? undefined,
  });
}

describe("session broker with several MCP clients", () => {
  test("grants are disjoint, confined per client, and release or crash only frees the owner's devices", async () => {
    const host = await open({ capacity: 3, liveDisposition: true });
    const a1 = await acquire(host, A, 1);
    const a2 = await acquire(host, A, 2);
    const b1 = await acquire(host, B, 1);
    for (const [client, grant] of [
      [A, a1],
      [A, a2],
      [B, b1],
    ] as const) {
      expect((await connect(host, client, grant))?.success).not.toBe(false);
    }

    // Disjoint: three sessions, three distinct devices.
    const devices = [a1, a2, b1].map((grant) => deviceOf(host, grant.sessionUuid));
    expect(new Set([a1, a2, b1].map((grant) => grant.sessionUuid)).size).toBe(3);
    expect(new Set(devices).size).toBe(3);
    expect(
      (await host.controls.inventory()).devices.map((device) => device.deviceId).sort(),
    ).toEqual([...devices].sort());

    // A drives its own devices; neither device nor session of B is reachable from A (and back).
    expect(
      refusalFor(host, a1, { deviceId: devices[0], sessionUuid: a1.sessionUuid }),
    ).toBeUndefined();
    expect(
      refusalFor(host, a2, { deviceId: devices[1], sessionUuid: a2.sessionUuid }),
    ).toBeUndefined();
    const deviceRefusal = refusalFor(host, a1, { deviceId: devices[2] });
    expect(deviceRefusal?.code).toBe(DEVICE_OUTSIDE_BROKER_GRANT_CODE);
    expect(deviceRefusal?.reason).toBe("device");
    const sessionRefusal = refusalFor(host, a1, { sessionUuid: b1.sessionUuid });
    expect(sessionRefusal?.code).toBe(DEVICE_OUTSIDE_BROKER_GRANT_CODE);
    expect(sessionRefusal?.reason).toBe("session");
    expect(refusalFor(host, b1, { deviceId: devices[0] })?.code).toBe(
      DEVICE_OUTSIDE_BROKER_GRANT_CODE,
    );
    expect(
      refusalFor(host, b1, { deviceId: devices[2], sessionUuid: b1.sessionUuid }),
    ).toBeUndefined();

    // A's second connection is confined to its own device too, not to its sibling's.
    expect(refusalFor(host, a2, { deviceId: devices[0] })?.reason).toBe("device");

    // A cannot end B's session through its own socket, nor release it with its own token.
    const foreignEnd = await handleDaemonRequest(
      {
        id: "foreign-end",
        type: "daemon_request",
        method: DAEMON_RELEASE_SESSION_METHOD,
        params: { sessionId: b1.sessionUuid },
      },
      host.state,
      undefined,
      undefined,
      { socketSessionId: a1.socket },
    );
    expect(foreignEnd).toMatchObject({ success: false, code: DEVICE_OUTSIDE_BROKER_GRANT_CODE });
    await expect(release(host, A, b1.sessionUuid)).rejects.toThrow(/another liveness owner/);
    expect(await host.broker.hasActiveSession(b1.sessionUuid)).toBe(true);

    // B releases its only device: A's two stay granted and inventoried.
    const released = await release(host, B, b1.sessionUuid);
    expect(released).toMatchObject({ success: true, result: { outcome: "released" } });
    expect(await host.broker.hasActiveSession(b1.sessionUuid)).toBe(false);
    expect(await host.broker.hasActiveSession(a1.sessionUuid)).toBe(true);
    expect(await host.broker.hasActiveSession(a2.sessionUuid)).toBe(true);
    expect(
      (await host.controls.inventory()).devices.map((device) => device.deviceId).sort(),
    ).toEqual([devices[0], devices[1]].sort());

    // A freed device is reusable by the other client, and the grant stays disjoint from A's.
    const b2 = await acquire(host, B, 2);
    expect(devices.slice(0, 2)).not.toContain(deviceOf(host, b2.sessionUuid));

    // Crash of A: its socket closes (scope unbound) and its liveness lapses (sessions leave the
    // SessionManager). The recovery sweep frees A's devices and nothing of B's.
    host.scopes.unbind(a1.socket);
    host.scopes.unbind(a2.socket);
    await host.sessions.releaseSession(a1.sessionUuid, "owner-disconnected");
    await host.sessions.releaseSession(a2.sessionUuid, "owner-disconnected");
    await host.broker.recover();
    await host.broker.joinReleases();
    expect(await host.broker.hasActiveSession(a1.sessionUuid)).toBe(false);
    expect(await host.broker.hasActiveSession(a2.sessionUuid)).toBe(false);
    expect(await host.broker.hasActiveSession(b2.sessionUuid)).toBe(true);
    expect((await host.controls.inventory()).devices.map((device) => device.deviceId)).toEqual([
      deviceOf(host, b2.sessionUuid),
    ]);
  });

  test("an execution owner's death ends its grant as session_owner_exited; an explicit release stays released (#12791)", async () => {
    const host = await open({ capacity: 2, liveDisposition: true });
    const a = await acquire(host, A, 1);
    const b = await acquire(host, B, 1);
    for (const [client, grant] of [
      [A, a],
      [B, b],
    ] as const) {
      expect((await connect(host, client, grant))?.success).not.toBe(false);
    }
    const deviceB = deviceOf(host, b.sessionUuid);

    // The proxy's owner watch reports the death on its bounded release. The daemon answers once
    // the terminal receipt is committed, not after the (slow) native drain and destruction.
    const drain = Promise.withResolvers<void>();
    host.devices.releaseHook = () => drain.promise;
    const ownerExit = await release(host, A, a.sessionUuid, SESSION_OWNER_EXITED_CODE);
    expect(ownerExit).toEqual({
      success: true,
      result: { sessionUuid: a.sessionUuid, outcome: "cleanup_pending" },
    });
    expect(await host.client.status(a.config.requestId, A.token)).toMatchObject({
      outcome: "failed",
      sessionUuid: a.sessionUuid,
      cleanupPending: true,
      failure: { code: SESSION_OWNER_EXITED_CODE, retryable: false },
    });
    expect(await host.broker.hasActiveSession(a.sessionUuid)).toBe(false);

    host.devices.releaseHook = undefined;
    drain.resolve();
    await host.broker.joinReleases();
    const receiptA = await host.client.status(a.config.requestId, A.token);
    expect(receiptA).toMatchObject({
      outcome: "failed",
      requestId: a.config.requestId,
      sessionUuid: a.sessionUuid,
      cleanupPending: false,
      failure: { code: SESSION_OWNER_EXITED_CODE },
    });
    // The device is destroyed, the sibling's grant is untouched, and replay is the terminal receipt.
    expect((await host.controls.inventory()).devices.map((device) => device.deviceId)).toEqual([
      deviceB,
    ]);
    expect(await host.prepare(a.config, A.token)).toEqual(receiptA!);
    expect(await release(host, A, a.sessionUuid, SESSION_OWNER_EXITED_CODE)).toEqual({
      success: true,
      result: { sessionUuid: a.sessionUuid, outcome: "released" },
    });
    expect(await host.client.status(a.config.requestId, A.token)).toEqual(receiptA);

    // The client's own release is not an owner death.
    expect(await release(host, B, b.sessionUuid)).toEqual({
      success: true,
      result: { sessionUuid: b.sessionUuid, outcome: "released" },
    });
    const receiptB = await host.client.status(b.config.requestId, B.token);
    expect(receiptB).toMatchObject({ outcome: "released", cleanupPending: false });
    expect(receiptB?.failure).toBeUndefined();
    expect((await host.controls.inventory()).devices).toEqual([]);
  });

  describe("daemon restart", () => {
    const scratch = useScratchRoot("broker-multi-client-");
    const successorOwner = {
      daemonId: "broker-daemon-2",
      pid: 202,
      processGenerationToken: "start-b",
    };

    async function twoClientsThenDaemonDies() {
      const dbPath = join(scratch.next(), "broker.sqlite");
      const first = await open({ capacity: 2, dbPath, liveDisposition: true });
      const a = await acquire(first, A, 1);
      const b = await acquire(first, B, 1);
      const devices = new Map(
        [a, b].map((grant) => [grant.sessionUuid, deviceOf(first, grant.sessionUuid)]),
      );
      const statuses = {
        a: await first.client.status(a.config.requestId, A.token),
        b: await first.client.status(b.config.requestId, B.token),
      };
      await first.crash();
      hosts.splice(hosts.indexOf(first), 1);
      return { dbPath, a, b, devices, statuses };
    }

    async function rehydrate(
      host: Host,
      before: Awaited<ReturnType<typeof twoClientsThenDaemonDies>>,
      only?: Grant,
    ) {
      for (const [grant, client] of [
        [before.a, A],
        [before.b, B],
      ] as const) {
        if (!only || only === grant) {
          await host.sessions.createSession(
            grant.sessionUuid,
            before.devices.get(grant.sessionUuid)!,
            "ios",
          );
          host.sessions.bindAcquiredLivenessOwnerToken(grant.sessionUuid, client.token);
        }
      }
    }

    test("a handoff keeps each client's own grant and refuses cross-client rebinds", async () => {
      const before = await twoClientsThenDaemonDies();
      const { a, b } = before;
      const second = await open({
        capacity: 2,
        dbPath: before.dbPath,
        liveDisposition: true,
        sessionIdBase: 16,
        ids: restartedIds(),
      });
      await rehydrate(second, before);
      await second.broker.recover();

      expect(await second.client.status(a.config.requestId, A.token)).toEqual(before.statuses.a);
      expect(await second.client.status(b.config.requestId, B.token)).toEqual(before.statuses.b);
      await expect(second.client.status(b.config.requestId, A.token)).rejects.toThrow(
        /another liveness owner/,
      );

      // A reconnecting proxy re-proves ownership and is bound to its own grant only.
      expect((await connect(second, A, a))?.success).not.toBe(false);
      expect(refusalFor(second, a, { sessionUuid: a.sessionUuid })).toBeUndefined();
      expect(refusalFor(second, a, { sessionUuid: b.sessionUuid })?.reason).toBe("session");
      await expect(
        handleDaemonRequest(
          {
            id: "steal",
            type: "daemon_request",
            method: DAEMON_REGISTER_SESSION_METHOD,
            params: {
              sessionId: b.sessionUuid,
              clientName: A.name,
              sessionBroker: { requestId: b.config.requestId, livenessOwnerToken: A.token },
            },
          },
          second.state,
          undefined,
          undefined,
          { socketSessionId: a.socket },
        ),
      ).rejects.toThrow(/another liveness owner/);
    });

    test("a grant whose session did not survive the restart is released alone", async () => {
      const before = await twoClientsThenDaemonDies();
      const second = await open({
        capacity: 2,
        dbPath: before.dbPath,
        liveDisposition: true,
        sessionIdBase: 16,
        ids: restartedIds(),
      });
      await rehydrate(second, before, before.b);
      await second.broker.recover();
      await second.broker.joinReleases();

      expect(await second.broker.hasActiveSession(before.a.sessionUuid)).toBe(false);
      expect(await second.broker.hasActiveSession(before.b.sessionUuid)).toBe(true);
      expect((await second.client.status(before.a.config.requestId, A.token))?.outcome).toBe(
        "released",
      );
    });

    test("a crashed owner ends both grants with a stable receipt and frees capacity for successors", async () => {
      const before = await twoClientsThenDaemonDies();
      const second = await open({
        capacity: 2,
        dbPath: before.dbPath,
        liveDisposition: true,
        sessionIdBase: 16,
        ids: restartedIds(),
        owner: successorOwner,
        isOwnerLive: () => false,
      });
      await second.broker.recover();
      await second.broker.joinReleases();

      const receiptA = await second.client.status(before.a.config.requestId, A.token);
      const receiptB = await second.client.status(before.b.config.requestId, B.token);
      if (!receiptA) {
        throw new Error("missing release receipt");
      }
      expect(receiptA.failure?.code).toBe("session_owner_exited");
      expect(receiptB?.failure?.code).toBe("session_owner_exited");
      expect(await second.broker.hasActiveSession(before.a.sessionUuid)).toBe(false);
      expect(await second.broker.hasActiveSession(before.b.sessionUuid)).toBe(false);
      expect((await second.controls.inventory()).devices).toEqual([]);
      // The original request replays byte-for-byte, and each client can acquire a fresh grant.
      expect(await second.prepare(before.a.config, A.token)).toEqual(receiptA);
      const successorA = await acquire(second, A, 2);
      const successorB = await acquire(second, B, 2);
      expect(deviceOf(second, successorA.sessionUuid)).not.toBe(
        deviceOf(second, successorB.sessionUuid),
      );
    });
  });
});
