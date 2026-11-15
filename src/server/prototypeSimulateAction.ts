import {
  PROTOTYPE_TIMERS_CAPABILITY,
  type PrototypeResult,
} from "../features/observe/android/ctrlProxyProtocol";
import type { AndroidPrototypeTransport } from "../features/prototype/androidPrototypeTransport";
import type { IosPrototypeTransport } from "../features/prototype/ios/iosPrototypeTransport";
import {
  simulatePrototypePush,
  type PrototypePushRoutes,
  type PrototypePushSimulateResult,
  type PrototypePushTransport,
} from "../features/prototype/prototypePushSimulate";
import { prototypeTimersUnsupportedMessage } from "../features/prototype/prototypeTimers";
import { toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import type { z } from "zod/v4";
export interface PrototypeSimulateTarget {
  android?: Pick<AndroidPrototypeTransport, "supportsCommand" | "advanceClock">;
  ios?: Pick<IosPrototypeTransport, "supportsCapability" | "advanceClock">;
  /** Push delivery routes; no runtime accepts a simulated push yet, so devices supply none. */
  push?: PrototypePushRoutes;
}
export interface PrototypeSimulateArgs {
  id?: string;
  advanceTimeMs?: number;
  event?: string;
  data?: unknown;
  transport?: PrototypePushTransport;
  timeoutMs?: number;
}
export type PrototypeSimulateOutput =
  | { success: boolean; error?: string; fired?: number }
  | PrototypePushSimulateResult;
export async function performPrototypeSimulate(
  target: PrototypeSimulateTarget,
  args: PrototypeSimulateArgs,
): Promise<PrototypeSimulateOutput> {
  if (args.event !== undefined) {
    return simulatePrototypePush(target.push ?? {}, {
      id: args.id!,
      data: args.data,
      transport: args.transport,
      timeoutMs: args.timeoutMs,
    });
  }
  return advancePrototypeClock(target, args);
}
async function advancePrototypeClock(
  target: PrototypeSimulateTarget,
  args: PrototypeSimulateArgs,
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
      : {
          success: false,
          error: reply.error ?? "simulate failed",
          ...(reply.fired === undefined ? {} : { fired: reply.fired }),
        };
  } catch (error) {
    logger.warn("[prototype] simulate request failed", error);
    return { success: false, error: toActionableError(error, "simulate failed").message };
  }
}
export function validatePrototypeSimulateInput(
  value: {
    action: string;
    id?: string;
    advanceTimeMs?: number;
    event?: string;
    data?: unknown;
    transport?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.action !== "simulate") {
    return;
  }
  const issue = simulateInputIssue(value);
  if (issue) {
    ctx.addIssue({ code: "custom", path: [issue[0]], message: issue[1] });
  }
}
function simulateInputIssue(value: {
  id?: string;
  advanceTimeMs?: number;
  event?: string;
  data?: unknown;
  transport?: string;
}): [string, string] | undefined {
  if (value.id === undefined) {
    return ["id", "simulate requires id"];
  }
  if ((value.advanceTimeMs === undefined) === (value.event === undefined)) {
    return ["advanceTimeMs", "simulate requires exactly one of advanceTimeMs or event"];
  }
  if (value.event !== undefined && value.data === undefined) {
    return ["data", "simulate event requires data (the push payload)"];
  }
  if (value.event === undefined && (value.data !== undefined || value.transport !== undefined)) {
    return [value.data === undefined ? "transport" : "data", "data and transport need event"];
  }
  return undefined;
}
