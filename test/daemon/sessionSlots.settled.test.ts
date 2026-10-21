import { expect, test } from "bun:test";
import type { Session, SessionManager } from "../../src/daemon/sessionManager";
import { slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";

test("settled shares a per-UUID resolve-only promise and ignores facet changes with the same tag", async () => {
  const rig = slotAgreementRig();
  const session = await rig.manager.createSession("id", "fake-device", "android");
  const slots = Reflect.get(rig.manager, "sessionSlots") as SessionManager["sessionSlots"];
  const view = rig.manager.getLegacyLifecycleView();
  const settled = slots.settled("id", view);
  expect(slots.settled("id", view)).toBe(settled);
  let notifications = 0;
  const completion = settled.then(() => notifications++);
  slots.setCreation("id", { promise: Promise.resolve(session) });
  slots.deleteCreation("id");
  slots.setAssignment("other", Promise.resolve(session));
  await Promise.resolve();
  expect(notifications).toBe(0);
  slots.setRebind("id", { session, promise: Promise.resolve(session) });
  await completion;
  expect(notifications).toBe(1);
  const next = slots.settled("id", view);
  expect(next).not.toBe(settled);
  slots.deleteRebind("id");
  await next;
  expect(rig.timer.getSleepHistory()).toEqual([]);
  rig.timer.reset();
});

test("publication and unpublication notify settled even with the diagnostic probe off", async () => {
  const rig = slotAgreementRig();
  const slots = Reflect.get(rig.manager, "sessionSlots") as SessionManager["sessionSlots"];
  const view = rig.manager.getLegacyLifecycleView();
  rig.manager.setSlotShadowProbeMode("off");
  const warm = await rig.manager.createSession("warm", "fake-warm", "android");
  const assignment = slots.settled("id", view);
  slots.setAssignment("id", Promise.resolve(warm));
  await assignment;
  const creation = slots.settled("id", view);
  // createSession normally joins assignments through its public caller, but its own creation
  // facet is synchronous: assigning -> creating -> live is directly observable here.
  const work = rig.manager.createSession("id", "fake-device", "android");
  await creation;
  const published = slots.settled("id", view);
  await published;
  const session = await work;
  const releasing = slots.settled("id", view);
  slots.markReleasing(session);
  await releasing;
  const unpublished = slots.settled("id", view);
  await rig.manager.releaseSession("id", "plan-auto-release");
  await unpublished;
  expect(view.sessions.has("id")).toBe(false);
  expect(rig.timer.getSleepHistory()).toEqual([]);
  rig.timer.reset();
});

test("release-op, terminal intent and weak-identity mutations notify only their own UUID", async () => {
  const rig = slotAgreementRig();
  const session = await rig.manager.createSession("id", "fake-device", "android");
  const slots = Reflect.get(rig.manager, "sessionSlots") as SessionManager["sessionSlots"];
  const view = rig.manager.getLegacyLifecycleView();
  const other = slots.settled("other", view);
  let otherNotifications = 0;
  void other.then(() => otherNotifications++);
  (Reflect.get(rig.manager, "sessions") as Map<string, Session>).delete("id");
  const identity = slots.settled("id", view);
  slots.recordFinalizedIdentity(session);
  await identity;
  expect(otherNotifications).toBe(0);
  const absent = slots.settled("id", view);
  slots.deleteFinalizedIdentity("id");
  await absent;
  expect(otherNotifications).toBe(0);
  const releasing = slots.settled("id", view);
  slots.setReleaseOp("id", {
    session,
    promise: Promise.resolve(null),
    reason: { value: "plan-auto-release" },
    options: {},
    stuckDeadlineMs: 1000,
  });
  await releasing;
  expect(otherNotifications).toBe(0);
  const ended = slots.settled("id", view);
  slots.deleteReleaseOp("id");
  await ended;
  expect(otherNotifications).toBe(0);
  const fenced = slots.settled("id", view);
  slots.setRecoveredTerminalIntent("id", {
    sessionId: "id",
    reason: "explicit-release",
    at: 0,
  });
  await fenced;
  expect(otherNotifications).toBe(0);
  const lifted = slots.settled("id", view);
  slots.deleteRecoveredTerminalIntent("id");
  await lifted;
  expect(otherNotifications).toBe(0);
  expect(slots.settled("other", view)).toBe(other);
  expect(rig.timer.getSleepHistory()).toEqual([]);
  rig.timer.reset();
});
