import {
  defaultSystemAlertGate,
  type SystemAlertGate,
} from "../features/action/systemAlerts/SystemAlertGate";
import type { DeviceAwareToolHandler } from "./toolRegistryTypes";

type GateProvider = () => Pick<SystemAlertGate, "beforeAction">;

/** Appends the gate's warnings to a tool response's `structuredContent.warnings` and text. */
export function withSystemAlertWarnings<T>(response: T, warnings: readonly string[]): T {
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
 * (and answered, per policy) before the action, and every one is reported in its result. Wraps the
 * registered handler, so direct calls, plan steps and journaled multi-device steps all pass it.
 */
export function withSystemAlertGate(
  handler: DeviceAwareToolHandler,
  gate: GateProvider = defaultSystemAlertGate,
): DeviceAwareToolHandler {
  return async (device, args, progress, signal) => {
    const warnings = await gate().beforeAction(device, signal);
    try {
      return withSystemAlertWarnings(await handler(device, args, progress, signal), warnings);
    } catch (error) {
      // The action failed after the gate answered an alert: keep that in the error it surfaces.
      if (warnings.length > 0 && error instanceof Error) {
        error.message = `${error.message} (system alerts: ${warnings.join(" ")})`;
      }
      throw error;
    }
  };
}

/**
 * Gate an erased registration's handler when it declares `recordsNavigation`. Wrapping the
 * registered handler covers routed calls, plan steps and journaled multi-device steps alike.
 */
export function gateUiInteraction<
  T extends { handler: DeviceAwareToolHandler; options: { recordsNavigation?: boolean } },
>(registration: T, gate: GateProvider = defaultSystemAlertGate): T {
  return registration.options.recordsNavigation
    ? { ...registration, handler: withSystemAlertGate(registration.handler, gate) }
    : registration;
}
