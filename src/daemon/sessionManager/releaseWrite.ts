import { type MarkReleasedOptions } from "../../db/deviceSessionRepository";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import {} from "../deviceStateRestoreQueue";
import { SessionReleasePersistTimeoutError } from "../releaseErrors";
import { SESSION_RELEASE_PERSIST_TIMEOUT_MS, SessionReleaseSnapshot } from "../sessionManager";
import { type SessionRowWriter } from "../sessionRowWriter";
import { type TerminalReleaseJournal } from "../terminalReleaseJournal";

export interface SessionReleaseWriteHost {
  isSessionBeingRecreated(sessionId: string): boolean;
  readonly rowWriter: SessionRowWriter;
  readonly terminalReleaseJournal: TerminalReleaseJournal;
  sessionClockToWall(sessionClockMs: number): number;
  readonly volatileTerminalReleaseIntents: Map<string, string>;
  releaseWritePrecondition(snapshot: SessionReleaseSnapshot): MarkReleasedOptions;
  issueReleaseRow(snapshot: SessionReleaseSnapshot, options: MarkReleasedOptions): Promise<void>;
  releaseRowFallback(
    snapshot: SessionReleaseSnapshot,
    precondition: MarkReleasedOptions,
    issueWrite: (options: MarkReleasedOptions) => Promise<void>,
  ): (error: unknown) => Promise<void>;
  readonly timer: Timer;
  trackLateReleaseWrite(write: Promise<void>, snapshot: SessionReleaseSnapshot): void;
  confirmReleaseWrite(snapshot: SessionReleaseSnapshot): void;
  handleReleaseWriteFailure(
    error: unknown,
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean,
  ): boolean;
}

export class SessionReleaseWrite {
  constructor(private readonly host: SessionReleaseWriteHost) {}

  async persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean = false,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean> {
    // A retry yields to a reissue until publish ends it or failed creation leaves it owed (#11557).
    if (retryPending && this.host.isSessionBeingRecreated(snapshot.sessionId)) {
      return false;
    }
    this.host.rowWriter.noteRelease(snapshot);
    try {
      if (snapshot.terminal) {
        // Record before issuing the row write; volatile intents cannot protect a crash at timeout.
        const durability = this.host.terminalReleaseJournal.record({
          sessionId: snapshot.sessionId,
          reason: snapshot.releaseReason,
          // Read back by the next daemon on its own session clock: stored as wall ms (#11162).
          at: this.host.sessionClockToWall(snapshot.releasedAtMs),
        });
        if (durability === "volatile") {
          this.host.volatileTerminalReleaseIntents.set(snapshot.sessionId, snapshot.releaseReason);
        } else {
          this.host.volatileTerminalReleaseIntents.delete(snapshot.sessionId);
        }
      }
      const precondition = {
        ...this.host.releaseWritePrecondition(snapshot),
        ...statementConditions,
      };
      const issueWrite = (options: MarkReleasedOptions) =>
        this.host.issueReleaseRow(snapshot, options);
      const fallback = this.host.releaseRowFallback(snapshot, precondition, issueWrite);
      const deadlineNow = () => this.host.timer.monotonicNow?.() ?? this.host.timer.now();
      const startedAtMs = deadlineNow();
      let deadlineExpired = false;
      let write = issueWrite(precondition);
      const deadlineOptions = {
        timer: this.host.timer,
        timeoutMs: SESSION_RELEASE_PERSIST_TIMEOUT_MS,
        unref: true,
        label: "Session release persistence",
        timeoutError: () =>
          new SessionReleasePersistTimeoutError(
            snapshot.sessionId,
            snapshot.releaseReason,
            SESSION_RELEASE_PERSIST_TIMEOUT_MS,
          ),
        // Attach fallback only after timeout: a late refusal still needs classification, while
        // a successful first statement retains the repository promise's original timing.
        onTimeout: () => {
          deadlineExpired = true;
          this.host.trackLateReleaseWrite(write.catch(fallback), snapshot);
        },
      };
      try {
        await raceWithDeadline(write, deadlineOptions);
      } catch (error) {
        write = fallback(error);
        if (deadlineExpired) {
          // A first refusal can win its race in the turn that also fired the deadline.
          // Its fallback is already observed by onTimeout; it cannot extend the release.
          throw deadlineOptions.timeoutError();
        }
        await raceWithDeadline(write, {
          ...deadlineOptions,
          // The first race clears its timer on rejection; spend only its remaining budget.
          timeoutMs: Math.max(
            0,
            SESSION_RELEASE_PERSIST_TIMEOUT_MS - (deadlineNow() - startedAtMs),
          ),
          onTimeout: () => this.host.trackLateReleaseWrite(write, snapshot),
        });
      }
      this.host.confirmReleaseWrite(snapshot);
      return true;
    } catch (error) {
      return this.host.handleReleaseWriteFailure(error, snapshot, retryPending);
    }
  }
}
