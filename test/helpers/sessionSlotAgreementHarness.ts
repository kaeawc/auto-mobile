import {
  SessionManager,
  type Session,
  type SessionDeviceAssigner,
  TerminalSessionError,
  SessionTerminalReleaseInProgressError,
  SessionRebindingError,
} from "../../src/daemon/sessionManager";
import { SessionReleasedDuringCreationError } from "../../src/daemon/deviceAcquisitionRefusals";
import { FileTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { deriveSlot, isSlotKnown, type LegacyLifecycleView } from "../../src/daemon/sessionSlots";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { SeededRandom } from "../fakes/SeededRandom";

export function slotAgreementRig(
  persistence = new FakeDeviceSessionPersistence(),
  fs = new FakeTerminalReleaseJournalFileSystem(),
  timer = new FakeTimer(),
  keepAwake?: ConstructorParameters<typeof SessionManager>[3],
) {
  const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier(), keepAwake);
  manager.stopCleanupTimer();
  manager.attachDaemonSessionId("shadow-daemon");
  manager.attachTerminalReleaseJournal(new FileTerminalReleaseJournal("/shadow/journal", fs));
  manager.setSlotShadowProbeMode("throw");
  const oracle = slotPredicateOracle(manager.getLegacyLifecycleView());
  const readRecreated = Reflect.get(manager, "isSessionBeingRecreated") as (
    uuid: string,
  ) => boolean;
  const compare = (name: string, actual: boolean, expected: boolean) => {
    if (actual !== expected) {
      throw new Error(`hook: ${name} disagrees with pre-S7 oracle`);
    }
    return expected;
  };
  // The production hook probe gets its reference only from tests. Compare the real wrappers
  // at every hook as well as each external microtask checkpoint, not derivation against itself.
  const probe = Reflect.get(manager, "slotShadowProbe") as SessionManager["slotShadowProbe"];
  probe.setReferencePredicates({
    isCurrentSession: (s) => compare("current", manager.isCurrentSession(s), oracle.current(s)),
    isAdmittedForAutomation: (s) =>
      compare("admitted", manager.isAdmittedForAutomation(s), oracle.admitted(s)),
    isLatestSessionIdentity: (s) =>
      compare("latest", manager.isLatestSessionIdentity(s), oracle.latest(s)),
    isSessionBeingRecreated: (id) =>
      compare("recreated", readRecreated.call(manager, id), oracle.recreated(id)),
    isKnownSessionId: (id) =>
      compare(
        "known",
        manager.getAllKnownSessionIds().includes(id),
        oracle.knownIds().includes(id),
      ),
  });
  const pool: SessionDeviceAssigner = {
    assignDeviceToSession: async (uuid) => {
      await manager.createSession(
        uuid,
        `device-${uuid}`,
        "android",
        1000,
        undefined,
        `stable-${uuid}`,
      );
      return `device-${uuid}`;
    },
  };
  return { manager, persistence, fs, timer, pool };
}

export type SlotAgreementRig = ReturnType<typeof slotAgreementRig>;

/** Every checkpoint checks both the bounded production probe and the real legacy union. */
export function assertSlotAgreement(
  rig: SlotAgreementRig,
  ids: readonly string[],
  identities: readonly Session[],
  event: string,
): void {
  const view = rig.manager.getLegacyLifecycleView();
  const oracle = slotPredicateOracle(view);
  const actualIds = rig.manager.getAllKnownSessionIds();
  if (JSON.stringify(actualIds) !== JSON.stringify(oracle.knownIds())) {
    throw new Error(`${event}: known order disagrees`);
  }
  const recreated = Reflect.get(rig.manager, "isSessionBeingRecreated") as (
    uuid: string,
  ) => boolean;
  for (const session of new Set([
    ...identities,
    ...view.sessions.values(),
    ...[...view.releaseOps.values()].map((op) => op.session),
  ])) {
    if (
      rig.manager.isCurrentSession(session) !== oracle.current(session) ||
      rig.manager.isAdmittedForAutomation(session) !== oracle.admitted(session) ||
      rig.manager.isLatestSessionIdentity(session) !== oracle.latest(session) ||
      rig.manager.isLatestSessionIdentity(session, { ignorePendingAssignment: true }) !==
        oracle.latest(session, true)
    ) {
      throw new Error(`${event}: identity predicates disagree for ${session.sessionId}`);
    }
  }
  const known = new Set(actualIds);
  for (const uuid of ids) {
    if (recreated.call(rig.manager, uuid) !== oracle.recreated(uuid)) {
      throw new Error(`${event}: recreation disagrees for ${uuid}`);
    }
    rig.manager.checkSlotShadowAgreement(
      uuid,
      event,
      identities.filter((s) => s.sessionId === uuid),
    );
    if (isSlotKnown(deriveSlot(view, uuid)) !== known.has(uuid)) {
      throw new Error(`${event}: known membership disagrees for ${uuid}`);
    }
  }
}

export interface SlotAgreementRun {
  seed: number;
  trace: string[];
  violations: string[];
  incarnations: number;
  observed: string[];
}

/** Small in-memory model: several operations may be outstanding at each microtask checkpoint. */
export async function runSlotAgreement(seed: number): Promise<SlotAgreementRun> {
  const random = new SeededRandom(seed);
  let rig = slotAgreementRig();
  const ids = ["shadow-a", "shadow-b", "shadow-c", "shadow-restart"];
  const observed = new Set<string>();
  const identities: Session[] = [];
  const trace: string[] = [];
  const violations: string[] = [];
  const pending = new Set<Promise<void>>();
  const check = (event: string) => {
    for (const session of rig.manager.getLegacyLifecycleView().sessions.values()) {
      if (!identities.includes(session)) {
        identities.push(session);
      }
    }
    const view = rig.manager.getLegacyLifecycleView();
    for (const uuid of ids) {
      if (deriveSlot(view, uuid).residue) {
        observed.add("residue");
      }
      if (
        !view.sessions.has(uuid) &&
        !view.pendingCreations.has(uuid) &&
        !view.pendingAssignments.has(uuid)
      ) {
        if (view.pendingReleases.has(uuid)) {
          observed.add("orphan-release");
        }
        if (view.pendingRebinds.has(uuid)) {
          observed.add("orphan-rebind");
        }
      }
      if (
        view.sessions.has(uuid) &&
        view.terminalSnapshots.has(uuid) &&
        !view.releaseOps.has(uuid)
      ) {
        observed.add("published-fence-without-op");
      }
    }
    try {
      assertSlotAgreement(rig, ids, identities, event);
    } catch (error) {
      violations.push(`${trace.join(" > ")}: ${errorMessage(error)}`);
    }
  };
  const issue = (name: string, work: Promise<unknown>) => {
    trace.push(name);
    const tracked = work
      .then(
        () => {
          observed.add(name);
        },
        (error: unknown) => {
          // Conflicting random requests may be refused; a probe disagreement is always fatal.
          trace.push(`refused: ${errorMessage(error)}`);
          if (
            !(
              error instanceof TerminalSessionError ||
              error instanceof SessionTerminalReleaseInProgressError ||
              error instanceof SessionRebindingError ||
              error instanceof SessionReleasedDuringCreationError ||
              (name === "rebind" &&
                /^Cannot rebind released session shadow-[abc]\.$/.test(errorMessage(error)))
            )
          ) {
            violations.push(errorMessage(error));
          }
        },
      )
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
    check(name);
  };
  const turns = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await Promise.resolve();
      check(`microtask-${i}`);
    }
  };
  const settle = async () => {
    await turns(180);
    if (pending.size) {
      throw new Error(`seed ${seed}: work did not settle: ${trace.join(",")}`);
    }
    const view = rig.manager.getLegacyLifecycleView();
    for (const uuid of ids) {
      if (
        !view.sessions.has(uuid) &&
        !view.pendingCreations.has(uuid) &&
        !view.pendingAssignments.has(uuid) &&
        (view.pendingReleases.has(uuid) || view.pendingRebinds.has(uuid))
      ) {
        violations.push(`seed ${seed}: orphan work remained after settling ${uuid}`);
      }
    }
  };
  // Guaranteed reincarnation coverage, independent of the generator's choices.
  for (let i = 0; i < 3; i++) {
    issue("create", rig.manager.getOrCreateSession(ids[0], rig.pool, "android"));
    await settle();
    issue("graceful", rig.manager.releaseSession(ids[0], "plan-auto-release"));
    await settle();
  }
  for (let step = 0; step < 36; step++) {
    const uuid = random.pick(ids.slice(0, 3));
    const op = random.pick([
      "create",
      "rebind",
      "graceful",
      "force",
      "supersede",
      "reissue",
      "expiry",
    ]);
    const published = rig.manager.getLegacyLifecycleView().sessions.get(uuid);
    switch (op) {
      case "create":
        issue(
          op,
          rig.manager.createSession(
            uuid,
            `device-${uuid}`,
            "android",
            1000,
            undefined,
            `stable-${uuid}`,
          ),
        );
        break;
      case "reissue":
        issue(op, rig.manager.getOrCreateSession(uuid, rig.pool, "android"));
        break;
      case "rebind":
        if (published) {
          issue(op, rig.manager.rebindSession(uuid, `rebound-${uuid}`, "android"));
        }
        break;
      case "force":
        issue(op, rig.manager.releaseSession(uuid, "plan-auto-release", true));
        if (rig.manager.forceStuckRelease(uuid)) {
          observed.add("forced");
        }
        check("forced");
        break;
      case "supersede":
        issue(
          op,
          rig.manager.releaseSessionUnlessSuperseded(
            uuid,
            "device-disconnected:shadow",
            () => false,
            true,
          ),
        );
        break;
      case "graceful":
        issue(op, rig.manager.releaseSession(uuid, "plan-auto-release", true));
        break;
      case "expiry":
        rig.timer.advanceTime(1001);
        rig.manager.cleanupExpiredSessions();
        observed.add(op);
        check(op);
        break;
    }
    await turns(random.pick([1, 2, 5, 20]));
  }
  await settle();
  // Shutdown handoff + restart use only the injected in-memory row store and journal.
  issue(
    "restart-fixture",
    rig.manager.createSession(
      ids[3],
      "device-restart",
      "android",
      1000,
      undefined,
      "stable-restart",
    ),
  );
  await settle();
  rig.manager.stopAcceptingSessionCreations();
  for (const uuid of rig.manager.getAllKnownSessionIds()) {
    issue("shutdown", rig.manager.releaseSession(uuid, "daemon-shutdown", true));
  }
  await settle();
  await rig.manager.drainReleasePromises(1000);
  rig.manager.stopCleanupTimer();
  rig = slotAgreementRig(rig.persistence, rig.fs, rig.timer);
  issue("restart", rig.manager.rehydratePersistedSessions(rig.pool));
  await settle();
  if (rig.manager.getLegacyLifecycleView().sessions.has(ids[3])) {
    observed.add("rehydrated");
  }
  rig.manager.stopCleanupTimer();
  rig.timer.reset();
  return {
    seed,
    trace,
    violations,
    observed: [...observed],
    incarnations: identities.filter((s) => s.sessionId === ids[0]).length,
  };
}

/** Frozen pre-S7 hand semantics. Deliberately independent of all derivation helpers. */
export function slotPredicateOracle(view: LegacyLifecycleView<Session>) {
  const current = (session: Session) =>
    view.sessions.get(session.sessionId) === session &&
    !view.terminalSnapshots.has(session.sessionId);
  return {
    current,
    admitted: (session: Session) => current(session) && !view.isReleasing(session),
    latest: (session: Session, ignorePendingAssignment = false): boolean => {
      const uuid = session.sessionId;
      const published = view.sessions.get(uuid);
      if (published) {
        return published === session;
      }
      if (
        view.pendingCreations.has(uuid) ||
        (!ignorePendingAssignment && view.pendingAssignments.has(uuid))
      ) {
        return false;
      }
      const op = view.releaseOps.get(uuid);
      if (op) {
        return op.session === session;
      }
      return view.latestFinalizedIdentities.get(uuid)?.deref() === session;
    },
    recreated: (uuid: string) =>
      view.sessions.has(uuid) ||
      view.pendingCreations.has(uuid) ||
      view.pendingAssignments.has(uuid),
    knownIds: () => [
      ...new Set([
        ...view.sessions.keys(),
        ...view.pendingCreations.keys(),
        ...view.pendingAssignments.keys(),
        ...view.pendingRebinds.keys(),
        ...view.pendingReleases.keys(),
        ...view.releaseOps.keys(),
      ]),
    ],
  };
}
