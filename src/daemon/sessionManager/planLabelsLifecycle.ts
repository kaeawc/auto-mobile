import type { DeviceSession } from "../../db/types";
import { PlanLabelRegistry } from "../planLabelRegistry";
import { isRecoverableDaemonReleaseReason, isTerminalReleaseReason } from "../releaseReasons";
import { TerminalSessionError } from "../sessionErrors";
import {
  type DeviceLabelMap,
  PLAN_AUTO_RELEASE_REASON,
  PLAN_LABEL_SESSION_SOURCE,
  type Session,
  type SessionReleaseSnapshot,
} from "../sessionManager";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import { type SessionLifecycleSlots } from "./internalContracts";

export interface SessionPlanLabelsHost {
  refuseLabelMintOutsidePlanAllocation(sessionId: string, deviceId: string): void;
  readonly planLabels: Pick<
    PlanLabelRegistry,
    | "openPlanLabelMints"
    | "creatorSource"
    | "isMintableAndNotLive"
    | "clearEndedBase"
    | "isRunning"
    | "getBaseSessionOfDerivedLabel"
    | "isMinting"
    | "liveBaseOfDerivedId"
    | "takeDerivedLabelSessions"
  >;
  liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence?: boolean,
    afterDelete?: () => void,
  ): void;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  readonly sessionSlots: Pick<SessionLifecycleSlots, "deleteTerminalReasonState" | "hasRecovery">;
  releaseSnapshotFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
    releaseReason: string,
  ): SessionReleaseSnapshot;
  sessionNow(): number;
  peekSession(sessionId: string): Session | null;
  ownershipSessionUuid(sessionId: string): string;
  readonly sessions: Pick<Map<string, Session>, "get">;
  endedBaseOfLabel(label: Session): { baseSessionId: string; releaseReason: string } | undefined;
}

export class SessionPlanLabels {
  constructor(private readonly host: SessionPlanLabelsHost) {}

  /**
   * A plan run is about to allocate the derived `${base}:${label}` sessions in `labels` (#11572).
   * A derived label session lives only as long as its plan run, so however the previous run's
   * session ended (device lost or killed, daemon shutdown, the plan's own release), this run's
   * allocation may mint the name again: {@link createSession} lifts the fence the previous run
   * left and writes over its row. Nothing else may. A call that merely names the label session
   * while it is not live (a late call of the old run, a stray client) is still refused as terminal
   * by {@link getOrCreateSession}. The caller invokes the returned function when its allocation
   * settles.
   */
  openPlanLabelMints(baseSessionId: string, labels: DeviceLabelMap): () => void {
    return this.host.planLabels.openPlanLabelMints(baseSessionId, labels);
  }

  /** The persisted creator of a session being created: a plan run's label mint marks its row. */
  creatorSourceForCreation(
    sessionId: string,
    persistenceSource: string | undefined,
  ): string | undefined {
    return this.host.planLabels.creatorSource(
      sessionId,
      persistenceSource,
      PLAN_LABEL_SESSION_SOURCE,
    );
  }

  /**
   * Lift the terminal fence a derived label session's previous plan run left, for the run that is
   * minting it now (#11572). The pending terminal row write and its journal intent go with it, as
   * when a release is superseded: they belong to the incarnation that ended.
   */
  liftPlanLabelFenceForMint(sessionId: string): void {
    if (!this.host.planLabels.isMintableAndNotLive(sessionId)) {
      return;
    }
    this.host.planLabels.clearEndedBase(sessionId);
    this.host.liftTerminalFence(sessionId, undefined, false, () => {
      this.host.slotShadowProbe.check(sessionId, "plan-label-fence-lifted");
      this.host.sessionSlots.deleteTerminalReasonState(sessionId);
    });
  }

  /**
   * Refuse a call naming a derived label session that is not live and whose plan run is over
   * (#11572): the row a plan run minted, with no plan in this daemon publishing it. Without this a
   * `plan-auto-release` or `daemon-shutdown` row would be re-issued by name as a session of its
   * own, holding a device with no plan, label map or base. The answer is terminal; no fence is
   * raised and the row is left as it is, so the next plan run can mint the name. While the plan
   * run that minted the label is still running, a row waiting out a recoverable handoff (a device
   * restart) is recovered as before.
   */
  refusePlanLabelSessionOutsideItsRun(
    sessionId: string,
    persisted: DeviceSession | undefined,
  ): void {
    if (persisted?.source !== PLAN_LABEL_SESSION_SOURCE) {
      return;
    }
    const recoverable =
      !persisted.release_reason || isRecoverableDaemonReleaseReason(persisted.release_reason);
    // A row this daemon did not mint under a still-running plan is a previous run's, whatever its
    // reason (a restarted daemon finds the old `daemon-shutdown` row): not a handoff to recover.
    if (recoverable && this.host.planLabels.isRunning(sessionId)) {
      return;
    }
    throw new TerminalSessionError(sessionId, {
      ...this.host.releaseSnapshotFromPersisted(
        sessionId,
        persisted,
        persisted.release_reason ?? PLAN_AUTO_RELEASE_REASON,
      ),
      terminal: true,
    });
  }

  /**
   * The base session a derived `${base}:${label}` session was published under, or undefined when
   * `sessionId` is not a known derived label session (#11111).
   */
  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined {
    return this.host.planLabels.getBaseSessionOfDerivedLabel(sessionId);
  }

  /** The live session `sessionId` reads as a `${base}:${label}` of, the longest such prefix. */
  liveBaseOfDerivedId(sessionId: string): string | undefined {
    return this.host.planLabels.liveBaseOfDerivedId(sessionId, (candidate) =>
      Boolean(this.host.peekSession(candidate)),
    );
  }

  /**
   * Whether `sessionId` is live and speaks for the same session as `otherSessionId` wherever
   * ownership is judged: the two are sessions of one plan (#11602). Releases nothing.
   *
   * A label that ended with that plan's base (#11640) still counts: a connection bound to the
   * plan is not told the label is some other session, its call goes on to admission and gets the
   * base's terminal release there.
   */
  isLiveSessionOfSamePlan(sessionId: string, otherSessionId: string): boolean {
    return (
      (this.host.peekSession(sessionId) !== null &&
        this.host.ownershipSessionUuid(sessionId) ===
          this.host.ownershipSessionUuid(otherSessionId)) ||
      this.endedWithPlanOf(sessionId, otherSessionId)
    );
  }

  /** Whether `sessionId` is a label whose ended base is `otherSessionId` or its base. */
  private endedWithPlanOf(sessionId: string, otherSessionId: string): boolean {
    const label = this.host.sessions.get(sessionId);
    const ended = label && this.host.endedBaseOfLabel(label);
    if (!ended) {
      return false;
    }
    const other = this.host.sessions.get(otherSessionId);
    return (
      otherSessionId === ended.baseSessionId ||
      (other !== undefined &&
        this.host.endedBaseOfLabel(other)?.baseSessionId === ended.baseSessionId)
    );
  }

  /**
   * Remove and return every derived `${base}:${label}` session ever published for `baseSessionId`
   * (#11091). Unlike the base's `deviceLabels` cache slot, this index survives the base's removal,
   * so a release of the base can still cascade to its derived sessions. Entries may name sessions
   * that are already gone; the caller checks each one.
   */
  takeDerivedLabelSessions(baseSessionId: string, releaseReason?: string): string[] {
    return this.host.planLabels.takeDerivedLabelSessions(
      baseSessionId,
      releaseReason,
      isTerminalReleaseReason,
    );
  }
}
