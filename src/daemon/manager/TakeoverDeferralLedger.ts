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

function sameGeneration(left: TakeoverGenerationKey, right: TakeoverGenerationKey): boolean {
  return (
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.processGenerationToken === right.processGenerationToken
  );
}

/**
 * The start path calls this under the daemon startup lock, so independent CLI launches share one
 * generation count. The proxy's expected-generation restart records without that lock; a lost
 * concurrent update only delays guidance by an attempt and never authorizes a stop.
 */
export class DefaultTakeoverDeferralLedger implements TakeoverDeferralLedger {
  /** This process's latest record and how many of its attempts never reached the file. */
  private unpersisted: { record: DeferralRecord; attempts: number } | undefined;

  constructor(private readonly store: StartupFailureStore) {}

  recordDeferral(key: TakeoverGenerationKey, nowMs: number): DeferralSummary {
    // Refresh after each lock acquisition: another CLI may have updated the file since our call.
    // Attempts a failed write kept in memory are added to the latest persisted same-generation
    // record, so a peer's progress written meanwhile is never overwritten (#14401).
    const buffered =
      this.unpersisted && sameGeneration(this.unpersisted.record.key, key)
        ? this.unpersisted
        : undefined;
    const previous = this.previousProgress(key, buffered);
    const record = {
      key: { ...key },
      attempts: (previous?.attempts ?? 0) + 1,
      firstDeferredAtMs: previous?.firstDeferredAtMs ?? nowMs,
    };
    try {
      this.store.write(JSON.stringify(record));
    } catch (error) {
      logger.warn(`Failed to persist takeover deferral ledger: ${errorMessage(error)}`, error);
      this.unpersisted = { record, attempts: (buffered?.attempts ?? 0) + 1 };
      return { attempts: record.attempts, firstDeferredAtMs: record.firstDeferredAtMs };
    }
    this.unpersisted = undefined;
    return { attempts: record.attempts, firstDeferredAtMs: record.firstDeferredAtMs };
  }

  /** The latest persisted same-generation record plus this process's unpersisted attempts. */
  private previousProgress(
    key: TakeoverGenerationKey,
    buffered: { record: DeferralRecord; attempts: number } | undefined,
  ): DeferralSummary | undefined {
    const persisted = this.read();
    if (!persisted || !sameGeneration(persisted.key, key)) {
      return buffered?.record;
    }
    return {
      attempts: persisted.attempts + (buffered?.attempts ?? 0),
      firstDeferredAtMs: Math.min(
        persisted.firstDeferredAtMs,
        buffered?.record.firstDeferredAtMs ?? persisted.firstDeferredAtMs,
      ),
    };
  }

  clear(): void {
    this.unpersisted = undefined;
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
