import {
  prototypePlatformSimulationIssue,
  prototypePlatformSimulationUnsupportedMessage,
} from "../features/prototype/prototypePlatformSimulation";
import type { SimulatePrototypePlatformMessage } from "../features/observe/android/ctrlProxyProtocol/prototypeMessages";
import { PROTOTYPE_PUSH_EVENT } from "../features/prototype/prototypePushSimulate";
import {
  PROTOTYPE_TIMERS_CAPABILITY,
  PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY,
  type PrototypeResult,
} from "../features/observe/android/ctrlProxyProtocol";
import type { AndroidPrototypeTransport } from "../features/prototype/androidPrototypeTransport";
import type { IosPrototypeTransport } from "../features/prototype/ios/iosPrototypeTransport";
import {
  simulatePrototypePush,
  type PrototypePushRoutes,
  type PrototypePushSimulateResult,
} from "../features/prototype/prototypePushSimulate";
import {
  isPrototypeMediaSimEvent,
  simulatePrototypeMedia,
  type PrototypeMediaSimRoute,
  type PrototypeMediaSimulateResult,
} from "../features/prototype/prototypeMediaSimulate";
import { prototypeTimersUnsupportedMessage } from "../features/prototype/prototypeTimers";
import type { PrototypeMockBackendRegistry } from "../features/prototype/PrototypeMockBackendRegistry";
import { toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import type { z } from "zod/v4";
import type { prototypeSchema } from "./prototypeTools/schemas";
export interface PrototypeSimulateTarget {
  android?: Pick<
    AndroidPrototypeTransport,
    "supportsCommand" | "advanceClock" | "simulatePlatformEvent"
  >;
  ios?: Pick<
    IosPrototypeTransport,
    "supportsCapability" | "advanceClock" | "simulatePlatformEvent"
  >;
  /** Push delivery routes; no runtime accepts a simulated push yet, so devices supply none. */
  push?: PrototypePushRoutes;
  /** The shown prototype's media module; no runtime exposes one to simulate yet. */
  media?: PrototypeMediaSimRoute;
  /** This session's mock backends: advanceTimeMs also moves their actors' clock (#14211). */
  mocks?: Pick<PrototypeMockBackendRegistry, "advanceClock" | "ids">;
}
/** The simulate slice of the validated prototype input. */
export type PrototypeSimulateInput = Pick<
  z.output<typeof prototypeSchema>,
  "id" | "advanceTimeMs" | "event" | "data" | "transport" | "timeoutMs"
>;
interface PrototypeClockOutput {
  success: boolean;
  error?: string;
  fired?: number;
  /** Mock backend actor steps the advance applied; present while a backend is defined. */
  actorSteps?: number;
}
export type PrototypeSimulateOutput =
  | PrototypeClockOutput
  | PrototypePushSimulateResult
  | PrototypeMediaSimulateResult;
export async function performPrototypeSimulate(
  target: PrototypeSimulateTarget,
  args: PrototypeSimulateInput,
): Promise<PrototypeSimulateOutput> {
  if (args.event !== undefined && isPrototypeMediaSimEvent(args.event)) {
    return simulatePrototypeMedia(target.media, {
      id: args.id!,
      event: args.event,
      data: args.data,
      timeoutMs: args.timeoutMs,
    });
  }
  if (args.event === PROTOTYPE_PUSH_EVENT) {
    return simulatePrototypePush(target.push ?? {}, {
      id: args.id!,
      data: args.data,
      transport: args.transport,
      timeoutMs: args.timeoutMs,
    });
  }
  if (args.event !== undefined) {
    return simulatePlatformEvent(target, args);
  }
  return advancePrototypeClock(target, args);
}
async function simulatePlatformEvent(
  target: PrototypeSimulateTarget,
  args: PrototypeSimulateInput,
): Promise<PrototypeClockOutput> {
  const issue = prototypePlatformSimulationIssue(args.event!, args.data);
  if (issue) {
    return { success: false, error: issue[1] };
  }
  try {
    const supported = target.android
      ? await target.android.supportsCommand(PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY)
      : target.ios?.supportsCapability(PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY);
    if (!supported) {
      return { success: false, error: prototypePlatformSimulationUnsupportedMessage() };
    }
    const runtime = target.android ?? target.ios!;
    const reply = await runtime.simulatePlatformEvent(
      args.id!,
      args.event!,
      args.data as SimulatePrototypePlatformMessage["data"],
      args.timeoutMs,
    );
    return reply.success
      ? { success: true }
      : { success: false, error: reply.error ?? "simulate failed" };
  } catch (error) {
    logger.warn("[prototype] platform simulate request failed", error);
    return { success: false, error: toActionableError(error, "simulate failed").message };
  }
}
async function advancePrototypeClock(
  target: PrototypeSimulateTarget,
  args: PrototypeSimulateInput,
): Promise<PrototypeClockOutput> {
  // Host-side first and whatever the device answers: a scripted reply needs no device timers.
  const actors =
    target.mocks !== undefined && target.mocks.ids().length > 0
      ? { actorSteps: target.mocks.advanceClock(args.advanceTimeMs!) }
      : {};
  return { ...(await advanceDeviceClock(target, args)), ...actors };
}
async function advanceDeviceClock(
  target: PrototypeSimulateTarget,
  args: PrototypeSimulateInput,
): Promise<PrototypeClockOutput> {
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
  if (value.event !== undefined) {
    return simulateEventInputIssue(value.event, value.data, value.transport);
  }
  if (value.data !== undefined || value.transport !== undefined) {
    return [value.data === undefined ? "transport" : "data", "data and transport need event"];
  }
  return undefined;
}
function simulateEventInputIssue(
  event: string,
  data: unknown,
  transport?: string,
): [string, string] | undefined {
  if (data === undefined) {
    return ["data", "simulate event requires data (the event payload)"];
  }
  if (transport !== undefined && event !== PROTOTYPE_PUSH_EVENT) {
    return ["transport", "transport is only for notifications.push"];
  }
  if (event !== PROTOTYPE_PUSH_EVENT && !isPrototypeMediaSimEvent(event)) {
    return prototypePlatformSimulationIssue(event, data);
  }
  return undefined;
}
