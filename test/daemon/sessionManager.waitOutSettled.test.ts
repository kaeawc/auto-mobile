import { expect, test } from "bun:test";
import type { Session, SessionManager } from "../../src/daemon/sessionManager";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";

type Store = SessionManager["sessionSlots"];
type WaitKind = "Release" | "Recreation" | "Rebind";

// The waiter is registered before the issuer's clearing continuation, as can happen when a
// refused row rewrite joins work that is already in flight. Count native microtasks, not time.
async function characterize(kind: WaitKind) {
  const rig = slotAgreementRig();
  const session = await rig.manager.createSession("wait-id", "fake-device", "android");
  const slots = Reflect.get(rig.manager, "sessionSlots") as Store;
  const gate = Promise.withResolvers<Session>();
  const events: string[] = [];
  let turn = 0;
  const note = (name: string) => events.push(`${name}:${turn}`);
  if (kind === "Release") {
    slots.setReleaseOp(session.sessionId, {
      session,
      promise: gate.promise.then(() => null),
      reason: { value: "plan-auto-release" },
      options: {},
      startedAtMs: 0,
      stuckDeadlineMs: 1000,
      forcedAbort: new AbortController(),
    });
  } else if (kind === "Recreation") {
    // An unpublished issue can clear its map after the promise wakes its other waiters.
    (Reflect.get(rig.manager, "sessions") as Map<string, Session>).delete(session.sessionId);
    slots.setCreation(session.sessionId, { promise: gate.promise });
  } else {
    slots.setRebind(session.sessionId, { session, promise: gate.promise });
  }
  const wait = Reflect.get(rig.manager, `waitOut${kind}Of`) as (
    id: string | Session,
  ) => Promise<void>;
  const waiter = wait
    .call(rig.manager, kind === "Rebind" ? session : session.sessionId)
    .then(() => {
      note("waiter");
      // Models the synchronous row-write issuance immediately after await waitOut*Of.
      note("row-write");
    });
  const issuer = (async () => {
    await gate.promise;
    note("clear");
    if (kind === "Release") {
      slots.deleteReleaseOp(session.sessionId);
    } else if (kind === "Recreation") {
      slots.deleteCreation(session.sessionId);
    } else {
      slots.deleteRebind(session.sessionId);
    }
  })();
  gate.resolve(session);
  for (turn = 1; turn <= 12; turn++) {
    await Promise.resolve();
  }
  await issuer;
  await waiter;
  expect(rig.timer.getSleepHistory()).toEqual([]);
  rig.timer.reset();
  return events;
}

test.each(["Release", "Recreation", "Rebind"] as const)(
  "waitOut%sOf preserves clearing and following row-write microtask order",
  async (kind) => {
    const resumeTurn = { Release: 5, Recreation: 3, Rebind: 2 }[kind];
    expect(await characterize(kind)).toEqual([
      "clear:1",
      `waiter:${resumeTurn}`,
      `row-write:${resumeTurn}`,
    ]);
  },
);

// The real issuer publishes before its outer finally clears the facet. A settled notification
// on publication must preserve that window as well as the controlled promise-order case above.
class GatedPersistence extends FakeDeviceSessionPersistence {
  gate?: Promise<void>;
  override async upsertActiveSession(
    ...args: Parameters<DeviceSessionPersistence["upsertActiveSession"]>
  ) {
    if (this.gate) {
      await this.gate;
    }
    return super.upsertActiveSession(...args);
  }
}

test.each(["Release", "Recreation", "Rebind"] as const)(
  "real %s issuer pins publication, facet clearing and next row write",
  async (kind) => {
    const persistence = new GatedPersistence();
    const rig = slotAgreementRig(persistence);
    const session = await rig.manager.createSession("real-id", "fake-device", "android");
    const gate = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<"teardown">();
    let turn = 0;
    const events: string[] = [];
    const note = (name: string) => events.push(`${name}:${turn}`);
    let work: Promise<unknown>;
    const uuid = kind === "Recreation" ? "new-id" : session.sessionId;
    if (kind === "Release") {
      rig.manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 1000 }));
      work = rig.manager.releaseSession(uuid, "plan-auto-release");
    } else {
      persistence.gate = gate.promise;
      work =
        kind === "Recreation"
          ? rig.manager.createSession(uuid, "next-device", "android")
          : rig.manager.rebindSession(uuid, "next-device", "android");
    }
    const view = rig.manager.getLegacyLifecycleView();
    const facet =
      kind === "Release"
        ? view.releaseOps
        : kind === "Recreation"
          ? view.pendingCreations
          : view.pendingRebinds;
    expect(facet.has(uuid)).toBe(true);
    const wait = Reflect.get(rig.manager, `waitOut${kind}Of`) as (
      id: string | Session,
    ) => Promise<void>;
    const waiter = wait.call(rig.manager, kind === "Rebind" ? session : uuid).then(() => {
      note("waiter");
      note("row-write");
    });
    const issuer = work.then(() => note("issuer"));
    gate.resolve();
    hold.resolve("teardown");
    let cleared = false;
    let published = kind !== "Recreation";
    for (turn = 1; turn <= 80; turn++) {
      await Promise.resolve();
      if (!published && view.sessions.has(uuid)) {
        published = true;
        note("published");
      }
      if (!cleared && !facet.has(uuid)) {
        cleared = true;
        note("clear");
      }
    }
    await issuer;
    const expected = {
      Release: ["clear:10", "issuer:12", "waiter:13", "row-write:13"],
      Recreation: ["published:14", "waiter:18", "row-write:18", "clear:21", "issuer:22"],
      Rebind: ["clear:22", "issuer:23", "waiter:23", "row-write:23"],
    };
    expect(events).toEqual(expected[kind]);
    await waiter;
    expect(rig.timer.getSleepHistory()).toEqual([]);
    rig.timer.reset();
  },
);
