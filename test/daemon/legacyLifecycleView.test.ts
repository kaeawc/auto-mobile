import { beforeAll, expect, test } from "bun:test";
import { createLegacyLifecycleView } from "../../src/daemon/legacyLifecycleView";
import { FakeLegacyLifecycleView } from "../fakes/FakeLegacyLifecycleView";
import { slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";

beforeAll(async () => {
  const rig = slotAgreementRig();
  await rig.manager.createSession("warm", "fake-warm", "android");
  rig.timer.reset();
});

test("adapter borrows every map and reflects later changes and WeakSet membership", () => {
  const source = new FakeLegacyLifecycleView();
  const view = createLegacyLifecycleView(source, source.releasingSessions);
  const session = {};
  source
    .publish("id", session)
    .startAssignment("a")
    .startCreation("c")
    .requestRelease("r")
    .startRebind("b")
    .startRelease("id")
    .fenceTerminal("t")
    .recoverIntent("j")
    .finalize("f", { deref: () => session });
  for (const [key, value] of Object.entries(source)) {
    if (value instanceof Map) {
      expect(Reflect.get(view, key)).toBe(value);
    }
  }
  expect(view.sessions.get("id")).toBe(session);
  expect(view.isReleasing(session)).toBe(false);
  source.releasingSessions.add(session);
  expect(view.isReleasing(session)).toBe(true);
  source.releasingSessions.delete(session);
  expect(view.isReleasing(session)).toBe(false);
});

test("real manager adapter follows publish, releasing, operation and finalized identities", async () => {
  const rig = slotAgreementRig();
  const view = rig.manager.getLegacyLifecycleView();
  expect(view.sessions).toBe(Reflect.get(rig.manager, "sessions"));
  const slots = Reflect.get(rig.manager, "sessionSlots");
  expect(view.terminalSnapshots).toBe(slots.terminalSnapshots);
  expect(view.recoveredTerminalIntents).toBe(slots.recoveredTerminalIntents);
  expect(view.latestFinalizedIdentities).toBe(slots.latestFinalizedIdentities);
  expect(view.releaseOps).toBe(slots.releaseOps);
  expect(view.pendingAssignments).toBe(slots.assignments);
  expect(view.pendingCreations).toBe(slots.creations);
  expect(view.pendingReleases).toBe(slots.releaseRequests);
  expect(view.pendingRebinds).toBe(slots.rebinds);
  const creation = rig.manager.createSession("id", "fake-id", "android");
  expect(view.pendingCreations.has("id")).toBe(true);
  const session = await creation;
  expect(view.sessions.get("id")).toBe(session);
  const release = rig.manager.releaseSession("id", "plan-auto-release");
  expect(view.isReleasing(session)).toBe(true);
  expect(view.releaseOps.get("id")?.session).toBe(session);
  await release;
  expect(view.sessions.has("id")).toBe(false);
  expect(view.isReleasing(session)).toBe(false);
  expect(view.releaseOps.has("id")).toBe(false);
  expect(view.latestFinalizedIdentities.get("id")?.deref()).toBe(session);
  rig.timer.reset();
});
