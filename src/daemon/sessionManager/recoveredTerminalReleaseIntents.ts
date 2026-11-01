import type {
  DeviceSessionPersistence,
  MarkReleasedOptions,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { SessionSlots } from "../sessionSlots";
import { isTerminalReleaseReason, releasedRowStatus } from "../releaseReasons";
import { SessionReleasePersistTimeoutError } from "../releaseErrors";
import { SESSION_RELEASE_PERSIST_TIMEOUT_MS, type SessionReleaseSnapshot } from "../sessionManager";
import type { TerminalReleaseIntent, TerminalReleaseJournal } from "../terminalReleaseJournal";

export interface RecoveredTerminalReleaseIntentsPort {
  terminalReleaseJournal(): Pick<TerminalReleaseJournal, "readDeadDaemon" | "discardDeadDaemon">;
  setJournal(journal: TerminalReleaseJournal): void;
  daemonSessionId(): string | undefined;
  liveDaemonSessionIds(): (() => ReadonlySet<string>) | undefined;
  sessionSlots(): Pick<
    SessionSlots<
      unknown,
      unknown,
      unknown,
      object,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      object,
      unknown,
      unknown,
      unknown,
      TerminalReleaseIntent
    >,
    | "setRecoveredTerminalIntent"
    | "recoveredTerminalIntents"
    | "deleteRecoveredTerminalIntent"
    | "deleteAdoptedTerminalOwner"
    | "getRecoveredTerminalIntent"
    | "getAdoptedTerminalOwner"
    | "hasAdoptedDeadJournal"
    | "addAdoptedDeadJournal"
    | "setAdoptedTerminalOwner"
    | "adoptedTerminalOwners"
  >;
  deviceSessionRepository(): Pick<DeviceSessionPersistence, "getSession" | "markReleased">;
  timer: Timer;
  sessionNow(): number;
  wallToSessionClock(at: number): number;
  checkSlotShadow(sessionId: string, event: string): void;
  liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence?: boolean,
  ): void;
}

export class RecoveredTerminalReleaseIntents {
  constructor(private readonly port: RecoveredTerminalReleaseIntentsPort) {}

  /**
   * Attach the terminal release journal (#10959) and adopt the intents a previous daemon left
   * unconfirmed. From here those UUIDs read as terminally released; startup rehydration then
   * writes their rows ({@link applyRecoveredTerminalReleaseIntents}).
   */
  attachTerminalReleaseJournal(journal: TerminalReleaseJournal): void {
    this.port.setJournal(journal);
    for (const intent of journal.loadUnconfirmed()) {
      // The journal holds wall ms, like the rows it backs (#11162).
      this.port.sessionSlots().setRecoveredTerminalIntent(intent.sessionId, {
        ...intent,
        at: this.port.wallToSessionClock(intent.at),
      });
    }
  }

  /**
   * Write the terminal row of every recovered intent whose row is not terminal yet, and drop the
   * intents whose rows already are. A write that fails keeps its intent (and the UUID fenced) for
   * the next startup.
   */
  async applyRecoveredTerminalReleaseIntents(deadlineAt?: number): Promise<string[]> {
    const applied: string[] = [];
    for (const intent of Array.from(this.port.sessionSlots().recoveredTerminalIntents.values())) {
      if (deadlineAt !== undefined && this.port.sessionNow() >= deadlineAt) {
        // The rest stay fenced in memory and are applied by the next startup.
        break;
      }
      try {
        const persisted = await this.port.deviceSessionRepository().getSession(intent.sessionId);
        if (
          persisted &&
          !(persisted.release_reason && isTerminalReleaseReason(persisted.release_reason)) &&
          this.adoptedTerminalReleaseApplies(persisted)
        ) {
          await raceWithDeadline(
            this.port
              .deviceSessionRepository()
              .markReleased(intent.sessionId, releasedRowStatus(intent.reason), intent.at, {
                reason: intent.reason,
                ...this.adoptedTerminalReleaseFence(intent.sessionId),
              }),
            {
              timer: this.port.timer,
              timeoutMs: SESSION_RELEASE_PERSIST_TIMEOUT_MS,
              unref: true,
              label: "Recovered terminal session release",
              timeoutError: () =>
                new SessionReleasePersistTimeoutError(
                  intent.sessionId,
                  intent.reason,
                  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
                ),
            },
          );
          applied.push(intent.sessionId);
        }
      } catch (error) {
        logger.warn(
          `[SessionManager] Failed to apply the unconfirmed terminal release of session ` +
            `${intent.sessionId} (${intent.reason}); it stays fenced: ${errorMessage(error)}`,
          error,
        );
        continue;
      }
      this.port.sessionSlots().deleteRecoveredTerminalIntent(intent.sessionId);
      this.port.checkSlotShadow(intent.sessionId, "recovered-terminal-intent-deleted");
      this.port.sessionSlots().deleteAdoptedTerminalOwner(intent.sessionId);
      this.port.liftTerminalFence(intent.sessionId, { releaseReason: intent.reason }, true);
    }
    if (applied.length > 0) {
      logger.warn(
        `[SessionManager] Terminalized ${applied.length} session(s) whose terminal release a ` +
          `previous daemon never persisted: ${applied.join(", ")}`,
      );
    }
    return applied;
  }

  /** A row a previous daemon terminally released without persisting it reads as released. */
  withRecoveredTerminalRelease(persisted: DeviceSession): DeviceSession {
    const intent = this.port.sessionSlots().getRecoveredTerminalIntent(persisted.session_uuid);
    if (
      !intent ||
      (persisted.release_reason !== null && isTerminalReleaseReason(persisted.release_reason)) ||
      !this.adoptedTerminalReleaseApplies(persisted)
    ) {
      return persisted;
    }
    return {
      ...persisted,
      status: releasedRowStatus(intent.reason),
      released_at_ms: intent.at,
      release_reason: intent.reason,
    };
  }

  /**
   * Whether the recovered intent for this row may terminalize it. An intent adopted from a peer
   * that died after this daemon started (#11355) applies only while the row is still that peer's.
   */
  private adoptedTerminalReleaseApplies(persisted: DeviceSession): boolean {
    const adoptedFrom = this.port.sessionSlots().getAdoptedTerminalOwner(persisted.session_uuid);
    return adoptedFrom === undefined || (persisted.daemon_session_id ?? null) === adoptedFrom;
  }

  /**
   * The write fence of an intent adopted after startup (#11355): the check above is a prior read,
   * so the release itself is conditioned on the row still being the dead daemon's. A row another
   * survivor recovered meanwhile, or one this write reaches only after parking, is left alone.
   */
  private adoptedTerminalReleaseFence(sessionId: string): MarkReleasedOptions {
    const adoptedFrom = this.port.sessionSlots().getAdoptedTerminalOwner(sessionId);
    return adoptedFrom === undefined ? {} : { onlyIfOwnedByDaemon: adoptedFrom };
  }

  /**
   * Adopt the terminal-release journal of this row's owner daemon once that daemon is known to be
   * dead (#11355). Startup adoption skips a peer that is live at the time, so a peer that parked a
   * terminal release and then died left a row a survivor would recover. Reading one of its rows
   * reads its whole journal first: the intents fence their UUIDs in memory at once, and their rows
   * are written before the read returns. The dead daemon's file stays in place until every one of
   * its intents is settled, so another survivor (or this daemon's successor) still finds it when
   * a write here parks or fails; a failed write is retried when a row of that daemon is next read. A
   * daemon whose liveness cannot be confirmed is left alone, because a live daemon's intents can
   * still be lifted. Resolves true when rows may have been written, so the caller re-reads.
   */
  async adoptDeadOwnerTerminalReleases(stored: DeviceSession): Promise<boolean> {
    const owner = this.confirmedDeadOwner(stored);
    if (owner === undefined) {
      return false;
    }
    const firstRead = !this.port.sessionSlots().hasAdoptedDeadJournal(owner);
    if (firstRead && !this.fenceDeadDaemonIntents(owner)) {
      // Unreadable for now; the next read of one of this daemon's rows retries.
      return false;
    }
    const unsettled = this.hasUnsettledAdoptedIntent(owner);
    if (!firstRead && !unsettled) {
      return false;
    }
    if (unsettled) {
      await this.applyRecoveredTerminalReleaseIntents();
    }
    if (!this.hasUnsettledAdoptedIntent(owner)) {
      // Every row is terminal (or no longer the dead daemon's): nobody needs the file again.
      this.port.terminalReleaseJournal().discardDeadDaemon?.(owner);
    }
    return true;
  }

  /** Read `owner`'s journal and fence its intents; false when it cannot be read yet. */
  private fenceDeadDaemonIntents(owner: string): boolean {
    const intents = this.port.terminalReleaseJournal().readDeadDaemon?.(owner);
    if (intents === undefined) {
      return false;
    }
    this.port.sessionSlots().addAdoptedDeadJournal(owner);
    for (const intent of intents) {
      // The journal holds wall ms, like the rows it backs (#11162).
      this.port.sessionSlots().setRecoveredTerminalIntent(intent.sessionId, {
        ...intent,
        at: this.port.wallToSessionClock(intent.at),
      });
      this.port.sessionSlots().setAdoptedTerminalOwner(intent.sessionId, owner);
    }
    if (intents.length > 0) {
      logger.warn(
        `[SessionManager] Adopted ${intents.length} unconfirmed terminal release(s) of dead ` +
          `daemon ${owner}: ${intents.map((intent) => intent.sessionId).join(", ")}`,
      );
    }
    return true;
  }

  private hasUnsettledAdoptedIntent(owner: string): boolean {
    for (const adoptedFrom of this.port.sessionSlots().adoptedTerminalOwners.values()) {
      if (adoptedFrom === owner) {
        return true;
      }
    }
    return false;
  }

  /** The row's owner daemon, when it is a confirmed-dead peer whose journal can be adopted. */
  private confirmedDeadOwner(stored: DeviceSession): string | undefined {
    const owner = stored.daemon_session_id ?? null;
    if (
      owner === null ||
      this.port.daemonSessionId() === undefined ||
      owner === this.port.daemonSessionId()
    ) {
      return undefined;
    }
    if (
      !this.port.terminalReleaseJournal().readDeadDaemon ||
      (stored.release_reason !== null && isTerminalReleaseReason(stored.release_reason))
    ) {
      return undefined;
    }
    return this.isConfirmedDeadDaemonSession(owner) ? owner : undefined;
  }

  /** True only when the live-daemon listing succeeded and does not name `daemonSessionId`. */
  private isConfirmedDeadDaemonSession(daemonSessionId: string): boolean {
    const liveDaemonSessionIds = this.port.liveDaemonSessionIds();
    if (!liveDaemonSessionIds) {
      return false;
    }
    try {
      return !liveDaemonSessionIds().has(daemonSessionId);
    } catch (error) {
      logger.warn(
        `[SessionManager] Cannot list live daemons to check journal owner ${daemonSessionId}; ` +
          `its journal is not adopted yet: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }
}
