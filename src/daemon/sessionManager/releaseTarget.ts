import { isTerminalReleaseReason } from "../releaseReasons";
import type { Session, SessionReleaseOperation, SessionReleaseSnapshot } from "../sessionManager";
import type { ForcedStuckRelease } from "./forcedStuckRelease";
import type { ReleaseReasonState, SessionLifecycleSlots } from "./internalContracts";

/** The first applicable branch for a UUID with no published session. */
export type ReleaseTarget =
  | { kind: "forced-in-flight"; release: SessionReleaseOperation }
  | { kind: "terminal-fenced"; snapshot: SessionReleaseSnapshot; reasonState?: ReleaseReasonState }
  | { kind: "row-pending"; snapshot: SessionReleaseSnapshot }
  | { kind: "pending-work"; pendingSession: Promise<Session> }
  | { kind: "persisted-only" };

export interface UnpublishedReleaseReader {
  readonly forcedStuckRelease: Pick<ForcedStuckRelease, "inFlightReleaseStillOwning">;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "getTerminalSnapshot" | "getTerminalReasonState" | "getAssignment" | "getCreation"
  >;
  readonly rowWriter: {
    pendingNonTerminalReleases(): Pick<ReadonlyMap<string, SessionReleaseSnapshot>, "get">;
  };
}

/** Read in release precedence order; the executor owns every write and await. */
export function classifyUnpublishedRelease(
  reader: UnpublishedReleaseReader,
  sessionId: string,
  releaseReason: string,
): ReleaseTarget {
  const release = reader.forcedStuckRelease.inFlightReleaseStillOwning(sessionId);
  if (release) {
    return { kind: "forced-in-flight", release };
  }
  const snapshot = reader.sessionSlots.getTerminalSnapshot(sessionId);
  if (snapshot && isTerminalReleaseReason(releaseReason)) {
    const reasonState = reader.sessionSlots.getTerminalReasonState(sessionId);
    return { kind: "terminal-fenced", snapshot, reasonState };
  }
  const pendingSnapshot = reader.rowWriter.pendingNonTerminalReleases().get(sessionId);
  if (pendingSnapshot) {
    return { kind: "row-pending", snapshot: pendingSnapshot };
  }
  // Both reads are intentional even when an assignment wins (#11800).
  const pendingAssignment = reader.sessionSlots.getAssignment(sessionId);
  const pendingCreation = reader.sessionSlots.getCreation(sessionId);
  const pendingSession = pendingAssignment ?? pendingCreation?.promise;
  return pendingSession ? { kind: "pending-work", pendingSession } : { kind: "persisted-only" };
}

export type OwnedReleaseVerdict = "release" | "decline" | "finalized";

export interface OwnedReleaseReader {
  readonly sessions: Pick<ReadonlyMap<string, Session>, "get">;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "hasAssignment" | "hasCreation" | "getReleaseOp"
  >;
}

/** Finalized identity checks remain in the executor, after these current-work reads. */
export function classifyOwnedRelease(
  reader: OwnedReleaseReader,
  sessionId: string,
  expectedSession: Session,
  expectedDeviceId: string,
): OwnedReleaseVerdict {
  const session = reader.sessions.get(sessionId);
  if (session === expectedSession && session.assignedDevice === expectedDeviceId) {
    return "release";
  }
  if (session) {
    return "decline";
  }
  if (reader.sessionSlots.hasAssignment(sessionId) || reader.sessionSlots.hasCreation(sessionId)) {
    return "decline";
  }
  const inFlightRelease = reader.sessionSlots.getReleaseOp(sessionId);
  if (inFlightRelease) {
    return inFlightRelease.session === expectedSession &&
      expectedSession.assignedDevice === expectedDeviceId
      ? "release"
      : "decline";
  }
  return "finalized";
}
