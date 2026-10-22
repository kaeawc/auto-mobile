import {
  defaultSystemAlertGate,
  type SystemAlertGate,
} from "../features/action/systemAlerts/SystemAlertGate";
import type { DeviceAwareToolHandler } from "./toolRegistryTypes";
import { logger } from "../utils/logger";

type GateProvider = () => Pick<SystemAlertGate, "beforeAction" | "afterAction">;

/** Appends the gate's warnings to a tool response's `structuredContent.warnings` and text. */
function withSystemAlertWarnings<T>(response: T, warnings: readonly string[]): T {
  if (warnings.length === 0 || !response || typeof response !== "object") {
    return response;
  }
  const envelope = response as {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: unknown;
  };
  const structured = envelope.structuredContent;
  const content = [
    ...(envelope.content ?? []),
    { type: "text", text: `System alerts: ${warnings.join(" ")}` },
  ];
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    return { ...envelope, content } as T;
  }
  const existing = (structured as { warnings?: unknown }).warnings;
  return {
    ...envelope,
    content,
    structuredContent: {
      ...structured,
      warnings: [...(Array.isArray(existing) ? existing : []), ...warnings],
    },
  } as T;
}

/**
 * Run a UI-interaction tool behind the device's `systemAlerts` policy (#14106): alerts are checked
 * (and answered, per policy) before the action and again after it, and every one is reported in
 * its result. Wraps the registered handler, so direct calls, plan steps and journaled
 * multi-device steps all pass it.
 */
export function withSystemAlertGate(
  handler: DeviceAwareToolHandler,
  gate: GateProvider = defaultSystemAlertGate,
): DeviceAwareToolHandler {
  return async (device, args, progress, signal) => {
    const before = await gate().beforeAction(device, signal);
    let response: unknown;
    try {
      response = await handler(device, args, progress, signal);
    } catch (error) {
      // Rethrown unchanged (an abort's DOMException message is read-only); the log keeps what
      // the gate did before the action failed.
      if (before.length > 0) {
        logger.warn(`[systemAlerts] ${device.deviceId}: action failed after: ${before.join(" ")}`);
      }
      throw error;
    }
    const after = signal?.aborted ? [] : await gate().afterAction(device, signal);
    return withSystemAlertWarnings(response, [...before, ...after]);
  };
}

/**
 * Gate an erased registration's handler when it declares `answersSystemAlerts`. Wrapping the
 * registered handler covers routed calls, plan steps and journaled multi-device steps alike.
 */
export function gateUiInteraction<
  T extends { handler: DeviceAwareToolHandler; options: { answersSystemAlerts?: boolean } },
>(registration: T, gate: GateProvider = defaultSystemAlertGate): T {
  return registration.options.answersSystemAlerts
    ? { ...registration, handler: withSystemAlertGate(registration.handler, gate) }
    : registration;
}
