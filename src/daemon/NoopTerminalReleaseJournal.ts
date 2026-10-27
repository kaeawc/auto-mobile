import {
  type TerminalReleaseIntent,
  type TerminalReleaseDurability,
  type TerminalReleaseJournal,
} from "./terminalReleaseJournal";

/**
 * Deliberate default outside the daemon: only Daemon.startOn attaches a file journal.
 * Non-daemon use and unit tests therefore have no crash safety.
 */
export class NoopTerminalReleaseJournal implements TerminalReleaseJournal {
  loadUnconfirmed(): TerminalReleaseIntent[] {
    return [];
  }

  record(): TerminalReleaseDurability {
    return "volatile";
  }

  resolve(): void {}
}
