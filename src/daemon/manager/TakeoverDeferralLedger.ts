import { z } from "zod";
import type { StartupFailureStore } from "../DaemonStartupFailureTracker";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { resolveDaemonInstallSpecifier } from "../../constants/release";
import { DaemonRestartDeferredError } from "../daemonRestartAdmission";
import { recordedProcessGenerationToken } from "../processGenerationFields";
import type { DaemonStatus } from "../types";

const generationKeySchema = z.object({
  pid: z.number().int().positive().optional(),
  startedAt: z.number().finite().optional(),
  processGenerationToken: z.string().optional(),
});

export type TakeoverGenerationKey = z.infer<typeof generationKeySchema>;

const deferralRecordSchema = z.object({
  key: generationKeySchema,
  attempts: z.number().int().positive().safe(),
  firstDeferredAtMs: z.number().min(-8.64e15).max(8.64e15),
});

type DeferralRecord = z.infer<typeof deferralRecordSchema>;
type DeferralSummary = Pick<DeferralRecord, "attempts" | "firstDeferredAtMs">;
export type TakeoverDeferralKind = "unavailable" | "active_operations";

/** Surface operator guidance after this many failed admissions (#13792); never stop the owner. */
export const TAKEOVER_DEFERRAL_ATTEMPT_BOUND = 3;
/** Surface operator guidance after this long without safe admission (#13792). */
export const TAKEOVER_DEFERRAL_TIME_BOUND_MS = 60_000;
/** Busy hosts may legitimately refuse for longer; only elapsed time bounds their deferrals (#13792). */
export const TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS = 10 * 60_000;

export interface TakeoverDeferralLedger {
  recordDeferral(key: TakeoverGenerationKey, nowMs: number): DeferralSummary;
  clear(): void;
}

export function takeoverDeferralBoundExceeded(
  kind: TakeoverDeferralKind,
  record: DeferralSummary,
  nowMs: number,
): boolean {
  const elapsed = nowMs - record.firstDeferredAtMs;
  return kind === "active_operations"
    ? elapsed >= TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS
    : record.attempts >= TAKEOVER_DEFERRAL_ATTEMPT_BOUND ||
        elapsed >= TAKEOVER_DEFERRAL_TIME_BOUND_MS;
}

/** Record a refused admission without ever authorizing an automatic stop of its owner. */
export function deferredRestartError({
  ledger,
  incumbent,
  kind,
  original,
  nowMs,
  subject,
}: {
  ledger: TakeoverDeferralLedger;
  incumbent: DaemonStatus;
  kind: TakeoverDeferralKind;
  original: DaemonRestartDeferredError;
  nowMs: number;
  subject: "older daemon" | "daemon";
}): DaemonRestartDeferredError {
  const record = ledger.recordDeferral(
    {
      pid: incumbent.pid,
      startedAt: incumbent.startedAt,
      processGenerationToken: recordedProcessGenerationToken(incumbent),
    },
    nowMs,
  );
  if (!takeoverDeferralBoundExceeded(kind, record, nowMs)) {
    return original;
  }
  const action = subject === "older daemon" ? "takeover" : "restart";
  const reason =
    `${subject} pid ${incumbent.pid} (version ${incumbent.version ?? "unknown"}) has deferred this ${action} ` +
    `${record.attempts} times since ${new Date(record.firstDeferredAtMs).toISOString()} (${original.message}); ` +
    `it is never stopped automatically — run \`bunx ${resolveDaemonInstallSpecifier()} --daemon restart\` ` +
    "to replace it once no device operation is active";
  logger.warn(reason);
  return new DaemonRestartDeferredError(reason);
}

/**
 * The start path calls this under the daemon startup lock, so independent CLI launches share one
 * generation count. The proxy's expected-generation restart records without that lock; a lost
 * concurrent update only delays guidance by an attempt and never authorizes a stop.
 */
export class DefaultTakeoverDeferralLedger implements TakeoverDeferralLedger {
  private unpersistedRecord: DeferralRecord | undefined;

  constructor(private readonly store: StartupFailureStore) {}

  recordDeferral(key: TakeoverGenerationKey, nowMs: number): DeferralSummary {
    // Refresh after each lock acquisition: another CLI may have updated the file since our call.
    // If persistence failed, retain this process's progress until a write succeeds.
    const previous = this.unpersistedRecord ?? this.read();
    const sameGeneration =
      previous?.key.pid === key.pid &&
      previous?.key.startedAt === key.startedAt &&
      previous?.key.processGenerationToken === key.processGenerationToken;
    const record = {
      key: { ...key },
      attempts: sameGeneration && previous ? previous.attempts + 1 : 1,
      firstDeferredAtMs: sameGeneration && previous ? previous.firstDeferredAtMs : nowMs,
    };
    try {
      this.store.write(JSON.stringify(record));
    } catch (error) {
      logger.warn(`Failed to persist takeover deferral ledger: ${errorMessage(error)}`, error);
      this.unpersistedRecord = record;
      return { attempts: record.attempts, firstDeferredAtMs: record.firstDeferredAtMs };
    }
    this.unpersistedRecord = undefined;
    return { attempts: record.attempts, firstDeferredAtMs: record.firstDeferredAtMs };
  }

  clear(): void {
    this.unpersistedRecord = undefined;
    this.store.clear();
  }

  private read(): DeferralRecord | undefined {
    try {
      const raw = this.store.read();
      if (raw === null) {
        return undefined;
      }
      const parsed: unknown = JSON.parse(raw);
      const result = deferralRecordSchema.safeParse(parsed);
      return result.success ? result.data : undefined;
    } catch (error) {
      logger.warn(`Failed to read takeover deferral ledger: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
}
