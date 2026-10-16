import { expect, test } from "bun:test";
import type {
  Session,
  SessionManager,
  SessionReleaseSnapshot,
} from "../../src/daemon/sessionManager";
import { deriveSlot } from "../../src/daemon/sessionSlots";
import { slotAgreementRig, slotPredicateOracle } from "../helpers/sessionSlotAgreementHarness";

type Store = SessionManager["sessionSlots"];
const cases = [
  "assigning",
  "creating",
  "live",
  "rebinding",
  "releasing-none",
  "releasing-terminal",
  "ended",
  "fenced",
  "absent",
  "residue-absent",
  "residue-ended",
  "residue-fenced",
  "declined",
  "weakset-cleaned",
  "fence-without-op",
  "stale-op",
] as const;
type Case = (typeof cases)[number];

async function fixture(kind: Case) {
  const rig = slotAgreementRig();
  const session = await rig.manager.createSession("id", "fake-device", "android", {
    timeoutMs: 1000,
    stableDeviceId: "stable-id",
  });
  const slots = Reflect.get(rig.manager, "sessionSlots") as Store;
  const sessions = Reflect.get(rig.manager, "sessions") as Map<string, Session>;
  const older: Session = { ...session };
  const op = {
    session,
    promise: Promise.resolve(null),
    reason: { value: "plan-auto-release" },
    options: {},
    stuckDeadlineMs: 1000,
  };
  const snapshot: SessionReleaseSnapshot = {
    sessionId: "id",
    deviceId: "fake-device",
    releaseReason: "explicit-release",
    releasedAtMs: 0,
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
  };
  if (
    [
      "assigning",
      "creating",
      "ended",
      "fenced",
      "absent",
      "residue-absent",
      "residue-ended",
      "residue-fenced",
    ].includes(kind)
  ) {
    sessions.delete("id");
  }
  if (kind === "assigning") {
    slots.recordFinalizedIdentity(session);
    slots.setAssignment("id", Promise.resolve(session));
  }
  if (kind === "creating") {
    slots.recordFinalizedIdentity(session);
    slots.setCreation("id", { promise: Promise.resolve(session) });
    slots.setAssignment("id", Promise.resolve(session));
  }
  if (kind === "rebinding") {
    slots.setRebind("id", { session, promise: Promise.resolve(session) });
  }
  if (kind.startsWith("releasing") || kind === "weakset-cleaned" || kind === "declined") {
    slots.setReleaseOp("id", { ...op, commitDeclined: kind === "declined" });
  }
  if (kind.startsWith("releasing") || kind === "declined") {
    slots.markReleasing(session);
  }
  if (["releasing-terminal", "fenced", "residue-fenced", "fence-without-op"].includes(kind)) {
    slots.setTerminalSnapshot("id", snapshot);
  }
  if (kind === "ended" || kind === "residue-ended") {
    slots.recordFinalizedIdentity(session);
  }
  if (kind.startsWith("residue")) {
    slots.setReleaseOp("id", op);
  }
  if (kind === "residue-absent") {
    slots.deleteReleaseOp("id");
    slots.setReleaseRequest("id", op);
  }
  if (kind === "stale-op") {
    slots.setReleaseOp("id", { ...op, session: older });
    slots.recordFinalizedIdentity(older);
  }
  return { ...rig, slots, sessions, session, older };
}

const predicates = ["current", "admitted", "latest", "recreated", "known", "held"] as const;
test.each(predicates.flatMap((predicate) => cases.map((kind) => ({ predicate, kind }))))(
  "$predicate reads the real manager's $kind slot",
  async ({ predicate, kind }) => {
    const rig = await fixture(kind);
    const { manager, session, older } = rig;
    const view = manager.getLegacyLifecycleView();
    const oracle = slotPredicateOracle(view);
    const expectedTag = kind.startsWith("residue-")
      ? kind.slice(8)
      : kind.startsWith("releasing") ||
          ["weakset-cleaned", "declined", "fence-without-op"].includes(kind)
        ? "releasing"
        : kind === "stale-op"
          ? "live"
          : kind;
    expect(deriveSlot(view, "id").tag).toBe(expectedTag);
    switch (predicate) {
      case "current":
        for (const s of [session, older]) {
          expect(manager.isCurrentSession(s)).toBe(oracle.current(s));
        }
        break;
      case "admitted":
        for (const s of [session, older]) {
          expect(manager.isAdmittedForAutomation(s)).toBe(oracle.admitted(s));
        }
        // The admission wrapper must still dispatch the instance method patched by callers.
        manager.isCurrentSession = () => false;
        expect(manager.isAdmittedForAutomation(session)).toBe(false);
        break;
      case "latest":
        for (const s of [session, older]) {
          expect(manager.isLatestSessionIdentity(s)).toBe(oracle.latest(s));
          expect(manager.isLatestSessionIdentity(s, { ignorePendingAssignment: true })).toBe(
            oracle.latest(s, true),
          );
        }
        break;
      case "recreated": {
        const read = Reflect.get(manager, "isSessionBeingRecreated") as (uuid: string) => boolean;
        expect(read.call(manager, "id")).toBe(oracle.recreated("id"));
        break;
      }
      case "known":
        expect(manager.getAllKnownSessionIds()).toEqual(oracle.knownIds());
        break;
      case "held": {
        const held = view.sessions.get("id") ?? view.releaseOps.get("id")?.session;
        expect(manager.getHeldDeviceSessions()).toEqual(
          held
            ? [
                {
                  deviceId: "fake-device",
                  sessionId: "id",
                  platform: held.platform,
                  stableDeviceId: held.stableDeviceId,
                },
              ]
            : [],
        );
        break;
      }
    }
    expect(rig.timer.getSleepHistory()).toEqual([]);
    rig.timer.reset();
  },
);

test("known UUID union preserves sessions, creations, assignments, rebinds, requests, ops order", async () => {
  const rig = await fixture("live");
  const { slots, session, sessions } = rig;
  sessions.set("second", { ...session, sessionId: "second" });
  slots.setCreation("creation", { promise: Promise.resolve(session) });
  slots.setCreation("id", { promise: Promise.resolve(session) });
  slots.setAssignment("assignment", Promise.resolve(session));
  slots.setAssignment("creation", Promise.resolve(session));
  slots.setRebind("rebind", { session, promise: Promise.resolve(session) });
  const release = {
    session,
    promise: Promise.resolve(null),
    reason: { value: "plan-auto-release" },
    options: {},
    stuckDeadlineMs: 1000,
  };
  slots.setReleaseRequest("request", release);
  slots.setReleaseRequest("rebind", release);
  slots.setReleaseOp("op", release);
  slots.setReleaseOp("request", release);
  expect(rig.manager.getAllKnownSessionIds()).toEqual([
    "id",
    "second",
    "creation",
    "assignment",
    "rebind",
    "request",
    "op",
  ]);
  rig.timer.reset();
});
