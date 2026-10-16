import { beforeAll, expect, test } from "bun:test";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import { deriveSlot } from "../../src/daemon/sessionSlots";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { assertSlotAgreement, slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";
import { drainUntil } from "../helpers/fakeTimerStepping";

class GatedPersistence extends FakeDeviceSessionPersistence {
  upsertGate: Promise<void> | undefined;
  releaseGate: Promise<void> | undefined;

  override async upsertActiveSession(
    ...args: Parameters<DeviceSessionPersistence["upsertActiveSession"]>
  ) {
    if (this.upsertGate) {
      await this.upsertGate;
    }
    return super.upsertActiveSession(...args);
  }

  override async markReleased(...args: Parameters<DeviceSessionPersistence["markReleased"]>) {
    if (this.releaseGate) {
      await this.releaseGate;
    }
    return super.markReleased(...args);
  }
}

beforeAll(async () => {
  const rig = slotAgreementRig();
  await rig.manager.createSession("warm", "fake-warm", "android");
  rig.timer.reset();
});

test("forced release leaves an orphan rebind only until its pending write settles", async () => {
  const persistence = new GatedPersistence();
  const rig = slotAgreementRig(persistence);
  const session = await rig.manager.createSession("id", "fake-id", "android");
  const gate = Promise.withResolvers<void>();
  persistence.upsertGate = gate.promise;
  const rebind = rig.manager.rebindSession("id", "fake-rebound", "android");
  const rebindResult = rebind.then(
    () => "published",
    () => "refused",
  );
  const release = rig.manager.releaseSession("id", "plan-auto-release");
  expect(rig.manager.forceStuckRelease("id")?.deviceId).toBe("fake-id");
  const view = rig.manager.getLegacyLifecycleView();
  expect(view.sessions.has("id")).toBe(false);
  expect(view.pendingRebinds.has("id")).toBe(true);
  expect(deriveSlot(view, "id").residue).toBe(true);
  assertSlotAgreement(rig, ["id"], [session], "orphan-rebind");
  gate.resolve();
  await rebindResult;
  await release;
  expect(view.pendingRebinds.has("id")).toBe(false);
  expect(deriveSlot(view, "id").residue).toBeUndefined();
  assertSlotAgreement(rig, ["id"], [session], "settled-rebind");
  rig.timer.reset();
});

test("declined terminal commit agrees across fence lifting and live-row rewrite", async () => {
  const persistence = new GatedPersistence();
  const rig = slotAgreementRig(persistence);
  const session = await rig.manager.createSession("id", "fake-id", "android");
  const releaseGate = Promise.withResolvers<void>();
  persistence.releaseGate = releaseGate.promise;
  let commit = true;
  const release = rig.manager.releaseSessionUnlessSuperseded("id", "explicit-release", {
    commitFence: () => commit,
  });
  const view = rig.manager.getLegacyLifecycleView();
  await drainUntil(() => view.terminalSnapshots.has("id"), { description: "terminal fence" });
  const rewriteGate = Promise.withResolvers<void>();
  persistence.upsertGate = rewriteGate.promise;
  commit = false;
  releaseGate.resolve();
  await drainUntil(() => view.releaseOps.get("id")?.commitDeclined === true, {
    description: "declined commit",
  });
  assertSlotAgreement(rig, ["id"], [session], "declined-terminal");
  // A newly raised fence is lifted synchronously on this path. Pre-existing fences stay held;
  // the fake-view regression pins that separate mapping, including a fence without any op.
  expect(rig.manager.isCurrentSession(session)).toBe(!view.terminalSnapshots.has("id"));
  rewriteGate.resolve();
  expect((await release).superseded).toBe(true);
  assertSlotAgreement(rig, ["id"], [session], "declined-settled");
  rig.timer.reset();
});

test("failed terminal write leaves a published fence without an op, including a later declined release", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const rig = slotAgreementRig(persistence);
  const session = await rig.manager.createSession("id", "fake-id", "android");
  persistence.failure = "release";
  await expect(rig.manager.releaseSession("id", "explicit-release")).rejects.toThrow();
  const view = rig.manager.getLegacyLifecycleView();
  expect(view.sessions.get("id")).toBe(session);
  expect(view.releaseOps.has("id")).toBe(false);
  expect(view.terminalSnapshots.has("id")).toBe(true);
  expect(deriveSlot(view, "id")).toEqual({
    tag: "releasing",
    fence: "terminal",
    releaseRequested: false,
  });
  assertSlotAgreement(rig, ["id"], [session], "failed-terminal-without-op");
  persistence.failure = null;
  const declined = rig.manager.releaseSessionUnlessSuperseded("id", "explicit-release", {
    commitFence: () => false,
  });
  expect((await declined).superseded).toBe(true);
  expect(view.isReleasing(session)).toBe(false);
  expect(view.terminalSnapshots.has("id")).toBe(true);
  assertSlotAgreement(rig, ["id"], [session], "declined-existing-fence");
  rig.timer.reset();
});
