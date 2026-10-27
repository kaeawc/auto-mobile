import type { AdvanceBindingJournalInput, BindingJournalEntry } from "./bindingRegistry";

/**
 * How often a quarantined delete (#14018) is probed for the device having gone away. A probe only
 * lists devices: it never re-sends the delete whose process-level escalation already failed.
 */
export const BINDING_JOURNAL_QUARANTINE_PROBE_MS = 600_000;

type QuarantineAdvance = Pick<AdvanceBindingJournalInput, "target" | "attempt">;

/** The delete's escalation was exhausted: mark the entry and schedule the first probe. */
export function quarantineFailure(nowMs: number, error: string): QuarantineAdvance {
  return {
    target: { quarantinedAtMs: nowMs },
    attempt: { error, nextAttemptAtMs: nowMs + BINDING_JOURNAL_QUARANTINE_PROBE_MS },
  };
}

/** A due probe still found the quarantined device: keep the recorded error and re-arm the probe. */
export function quarantineProbe(
  nowMs: number,
  entry: BindingJournalEntry,
  stableId: string,
): { advance: QuarantineAdvance; message: string } {
  const error = entry.lastError ?? "its emulator would not stop";
  return {
    advance: {
      attempt: { error, nextAttemptAtMs: nowMs + BINDING_JOURNAL_QUARANTINE_PROBE_MS },
    },
    message: `Device '${stableId}' is quarantined: ${error}`,
  };
}
