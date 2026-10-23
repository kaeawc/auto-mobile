import { getAbortSignal } from "../../../utils/AbortContext";
import type { BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import type { PowerDeviceClient } from "./AndroidPowerClient";
import type { DozeMode, DozeReading } from "./PowerTypes";

export interface DozeSettlement {
  reading: DozeReading;
  /** Poll attempts after the initial snapshot, excluding that snapshot. */
  polls: number;
  waitedMs: number;
  settled: boolean;
}

/** Wait after an already-observed mismatch, retaining the last complete reading on failure. */
export async function settleDoze(
  client: Pick<PowerDeviceClient, "readDoze">,
  wanted: DozeMode,
  ctx: {
    timer: Pick<Timer, "sleep" | "now">;
    backoff: BackoffPolicy;
    budgetMs: number;
    reading: DozeReading;
  },
): Promise<DozeSettlement> {
  const started = ctx.timer.now();
  let reading = ctx.reading;
  let polls = 0;
  while (reading.mode !== wanted && !getAbortSignal()?.aborted) {
    const remaining = ctx.budgetMs - (ctx.timer.now() - started);
    if (remaining <= 0) {
      break;
    }
    await ctx.timer.sleep(Math.min(ctx.backoff.delayForAttempt(polls + 1), remaining));
    if (getAbortSignal()?.aborted) {
      break;
    }
    try {
      polls++;
      reading = await client.readDoze();
    } catch (error) {
      logger.warn(`[power] Could not read Doze while settling: ${errorMessage(error)}`, error);
      break;
    }
  }
  return {
    reading,
    polls,
    waitedMs: ctx.timer.now() - started,
    settled: reading.mode === wanted,
  };
}
