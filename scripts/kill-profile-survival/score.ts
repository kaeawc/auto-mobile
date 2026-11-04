import {
  SURVIVAL_EVENT_IDS,
  type SurvivalEventId,
  type SurvivalOutcome,
} from "../../src/features/utility/KillProfileExpectedScores";

/** Allow scheduler/adb dispatch jitter, without treating minute-scale deferral as on time. */
export const DISPATCH_GRACE_MS = 10_000;
/** WorkManager's minimum periodic interval; the fixture deliberately delays its first run too. */
export const PERIODIC_INTERVAL_MS = 15 * 60_000;
export const FIRST_WORK_DELAY_MS = 60_000;
export const FOREGROUND_HEARTBEAT_MS = 30_000;
/** One full periodic interval plus two minutes of dispatch allowance. */
export const PRIMARY_WINDOW_MS = PERIODIC_INTERVAL_MS + 2 * 60_000;
/** Observe released Doze queues for two minutes before calling an unseen event never. */
export const RECOVERY_WINDOW_MS = 2 * 60_000;
/** Move RTC alarms past their deadlines; elapsed-time jobs still require real observation time. */
export const CLOCK_ADVANCE_MS = 5 * 60_000;

export interface SurvivalEvent {
  eventId: SurvivalEventId;
  epochMillis: number;
}

export interface EventTiming {
  firstDueMs: number;
  /** Omit for one-shot work. */
  intervalMs?: number;
}

export interface ScoringWindow {
  startMs: number;
  /** At and after this instant, work is recovery-only and therefore delayed. */
  deferralMs: number;
  endMs: number;
  timing: Record<SurvivalEventId, EventTiming>;
}

export type SurvivalScore = Record<SurvivalEventId, SurvivalOutcome>;

export function isSurvivalEventId(value: string): value is SurvivalEventId {
  return SURVIVAL_EVENT_IDS.some((id) => id === value);
}

/** Strict parsing makes a corrupt/mismatched fixture a harness error, rather than a false never. */
export function parseEvents(log: string): SurvivalEvent[] {
  return log
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^(\S+) (\d+)$/.exec(line);
      if (!match || !isSurvivalEventId(match[1]) || !Number.isSafeInteger(Number(match[2]))) {
        throw new Error(`Invalid survival event: ${line}`);
      }
      return { eventId: match[1], epochMillis: Number(match[2]) };
    });
}

function eventOutcome(
  events: readonly SurvivalEvent[],
  window: ScoringWindow,
  id: SurvivalEventId,
): SurvivalOutcome {
  const times = events
    .filter(
      (event) =>
        event.eventId === id &&
        event.epochMillis >= window.startMs &&
        event.epochMillis <= window.endMs,
    )
    .map((event) => event.epochMillis)
    .sort((a, b) => a - b);
  if (times.length === 0) {
    return "never";
  }
  const timing = window.timing[id];
  const first = times[0];
  if (first >= window.deferralMs || first > timing.firstDueMs + DISPATCH_GRACE_MS) {
    return "delayed";
  }
  if (timing.intervalMs !== undefined) {
    // Only evaluate intervals before recovery; the intentional RTC jump is not scheduler jitter.
    const primary = times.filter((time) => time < window.deferralMs);
    for (let index = 1; index < primary.length; index += 1) {
      if (primary[index] - primary[index - 1] > timing.intervalMs + DISPATCH_GRACE_MS) {
        return "delayed";
      }
    }
  }
  return "ran";
}

export function scoreEvents(
  events: readonly SurvivalEvent[],
  window: ScoringWindow,
): SurvivalScore {
  if (
    ![window.startMs, window.deferralMs, window.endMs].every(Number.isSafeInteger) ||
    window.startMs >= window.deferralMs ||
    window.deferralMs > window.endMs
  ) {
    throw new Error(
      "Scoring window must have start < deferral <= end (integer epoch milliseconds)",
    );
  }
  // Explicit record keeps additions to the stable event enum typechecked without unsafe casts.
  return {
    "workmanager-periodic": eventOutcome(events, window, "workmanager-periodic"),
    "workmanager-oneshot": eventOutcome(events, window, "workmanager-oneshot"),
    jobscheduler: eventOutcome(events, window, "jobscheduler"),
    "alarm-exact": eventOutcome(events, window, "alarm-exact"),
    "alarm-inexact": eventOutcome(events, window, "alarm-inexact"),
    "foreground-service": eventOutcome(events, window, "foreground-service"),
    "boot-receiver": eventOutcome(events, window, "boot-receiver"),
    "push-broadcast": eventOutcome(events, window, "push-broadcast"),
  };
}
