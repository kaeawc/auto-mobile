import type { SessionManagerCollaboratorHost } from "./host";

export interface SessionManagerCleanupLifecycle {
  CLEANUP_INTERVAL_MS: number;
  cleanupExpiredSessions(): void;
  rehydrationFollowUpTimer: NodeJS.Timeout | null;
}
/** Owns the cleanup interval and the shutdown cancellation of follow-up and restore work. */
export class SessionManagerCleanup {
  private cleanupTimer: NodeJS.Timeout | null = null;
  constructor(
    private readonly host: SessionManagerCollaboratorHost,
    private readonly lifecycle: SessionManagerCleanupLifecycle,
  ) {}

  /**
   * Start periodic cleanup of expired sessions
   */
  startCleanupTimer(): void {
    this.cleanupTimer = this.host.timer.setInterval(() => {
      this.lifecycle.cleanupExpiredSessions();
    }, this.lifecycle.CLEANUP_INTERVAL_MS);

    // Allow process to exit even if timer is running
    if (
      this.cleanupTimer &&
      typeof (this.cleanupTimer as { unref?: () => void }).unref === "function"
    ) {
      this.cleanupTimer.unref();
    }
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      this.host.timer.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.lifecycle.rehydrationFollowUpTimer) {
      this.host.timer.clearTimeout(this.lifecycle.rehydrationFollowUpTimer);
      this.lifecycle.rehydrationFollowUpTimer = null;
    }
    this.host.rowWriter.stopRetryTimers();
    this.host.superseded.stopTimers();
    // Cancel any armed per-condition network TTLs so a stopped manager leaves no
    // dangling timer (issue #6085 item 2).
    this.host.stateRestore.stopAll();
    this.host.rowWriter.clearPendingNonTerminalReleases();
    this.host.superseded.clearRowsUnderPendingRelease();
  }
}
