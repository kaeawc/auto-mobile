import {
  PROTOTYPE_TIMERS_CAPABILITY,
  type PrototypeResult,
} from "../features/observe/android/ctrlProxyProtocol";
import type { AndroidPrototypeTransport } from "../features/prototype/androidPrototypeTransport";
import type { IosPrototypeTransport } from "../features/prototype/ios/iosPrototypeTransport";
import { prototypeTimersUnsupportedMessage } from "../features/prototype/prototypeTimers";
import { toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import type { z } from "zod/v4";
export interface PrototypeSimulateTarget {
  android?: Pick<AndroidPrototypeTransport, "supportsCommand" | "advanceClock">;
  ios?: Pick<IosPrototypeTransport, "supportsCapability" | "advanceClock">;
}
export async function performPrototypeSimulate(
  target: PrototypeSimulateTarget,
  args: { id?: string; advanceTimeMs?: number; timeoutMs?: number },
): Promise<{ success: boolean; error?: string; fired?: number }> {
  try {
    const supported = target.android
      ? await target.android.supportsCommand(PROTOTYPE_TIMERS_CAPABILITY)
      : target.ios?.supportsCapability(PROTOTYPE_TIMERS_CAPABILITY);
    if (!supported) {
      return {
        success: false,
        error: prototypeTimersUnsupportedMessage([], target.android ? "android" : "ios"),
      };
    }
    const reply: PrototypeResult = target.android
      ? await target.android.advanceClock(args.id!, args.advanceTimeMs!, args.timeoutMs)
      : await target.ios!.advanceClock(args.id!, args.advanceTimeMs!, args.timeoutMs);
    return reply.success
      ? { success: true, ...(reply.fired === undefined ? {} : { fired: reply.fired }) }
      : { success: false, error: reply.error ?? "simulate failed" };
  } catch (error) {
    logger.warn("[prototype] simulate request failed", error);
    return { success: false, error: toActionableError(error, "simulate failed").message };
  }
}
export function validatePrototypeSimulateInput(
  value: { action: string; id?: string; advanceTimeMs?: number },
  ctx: z.RefinementCtx,
): void {
  if (
    value.action === "simulate" &&
    (value.id === undefined || value.advanceTimeMs === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: [value.id === undefined ? "id" : "advanceTimeMs"],
      message: "simulate requires id and advanceTimeMs",
    });
  }
}
