import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import {
  defaultSystemAlertPolicyRegistry,
  SYSTEM_ALERT_POLICIES,
  type SystemAlertPolicyRegistry,
} from "../features/action/systemAlerts/SystemAlertPolicy";

const matchEntry = z
  .object({
    textContains: z
      .string()
      .min(1)
      .optional()
      .describe("Answer only an alert whose text contains this (case-insensitive)"),
    buttonText: z
      .string()
      .min(1)
      .describe("Tap the button with exactly this label (case-insensitive), in any language"),
  })
  .strict();

const systemAlertsInput = z.object({
  action: z
    .enum(["setPolicy", "clear", "get"])
    .describe("setPolicy for this device, clear it, or get the current policy"),
  policy: z
    .enum(SYSTEM_ALERT_POLICIES)
    .optional()
    .describe(
      "setPolicy only, default report. report never taps and surfaces the alert in the action result; " +
        "allow, deny and allowOnce tap that button",
    ),
  match: z
    .array(matchEntry)
    .optional()
    .describe(
      "setPolicy only: answer specific alerts by button label, e.g. a localized or app-specific " +
        "alert the built-in permission labels do not cover",
    ),
});

const systemAlertsOutput = z.object({
  success: z.boolean(),
  action: z.enum(["setPolicy", "clear", "get"]),
  deviceId: z.string(),
  active: z.boolean().describe("Whether a policy is set for this device"),
  policy: z.enum(SYSTEM_ALERT_POLICIES),
  match: z.array(z.object({ textContains: z.string().optional(), buttonText: z.string() })),
  clearsOnRelease: z.boolean().describe("Whether the owning daemon session's release clears it"),
  cleared: z.boolean().optional(),
  message: z.string(),
});

type SystemAlertsArgs = z.output<typeof systemAlertsInput>;

/** The session fields `systemAlerts` reads; `SessionManager` satisfies it. */
export interface SystemAlertsSession {
  sessionId: string;
  assignedDevice?: string | null;
}

export interface SystemAlertsSessionHost {
  getSession(sessionId: string): SystemAlertsSession | null;
  isAdmittedForAutomation(session: SystemAlertsSession): boolean;
}

export interface SystemAlertsToolDependencies {
  sessionManager?: () => SystemAlertsSessionHost | undefined;
  registry?: SystemAlertPolicyRegistry;
}

/** The session a policy set under `sessionUuid` belongs to; it must hold the device. */
function policyOwner(
  host: SystemAlertsSessionHost | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
): string | undefined {
  if (!host || !sessionUuid) {
    return undefined;
  }
  const session = host.getSession(sessionUuid);
  if (!session || !host.isAdmittedForAutomation(session) || session.assignedDevice !== deviceId) {
    throw new ActionableError(
      "Cannot set a system-alert policy: session is released, releasing, rebound, or replaced.",
    );
  }
  return session.sessionId;
}

function policyState(
  device: BootedDevice,
  action: SystemAlertsArgs["action"],
  registry: SystemAlertPolicyRegistry,
) {
  const current = registry.get(device.deviceId);
  const policy = current?.policy ?? "report";
  return {
    success: true,
    action,
    deviceId: device.deviceId,
    active: current !== undefined,
    policy,
    match: current?.match ?? [],
    clearsOnRelease: current?.owner !== undefined,
    message: current
      ? `System alerts on ${device.deviceId} are answered with the ${policy} policy before each interaction` +
        (current.owner ? `, until session ${current.owner} is released.` : ", until cleared.")
      : `No system-alert policy on ${device.deviceId}; alerts are left alone.`,
  };
}

export const createSystemAlertsHandler =
  (deps: SystemAlertsToolDependencies = {}): DeviceToolHandler<typeof systemAlertsInput> =>
  async (device, args) => {
    const registry = deps.registry ?? defaultSystemAlertPolicyRegistry;
    if (args.action !== "setPolicy" && (args.policy !== undefined || args.match !== undefined)) {
      throw new ActionableError(
        `systemAlerts ${args.action} takes no policy or match; only setPolicy does.`,
      );
    }
    if (args.action === "clear") {
      const cleared = registry.clear(device.deviceId);
      return createStructuredToolResponse({ ...policyState(device, "clear", registry), cleared });
    }
    if (args.action === "setPolicy") {
      const host = args.sessionUuid
        ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
        : undefined;
      const owner = policyOwner(host, args.sessionUuid, device.deviceId);
      registry.set(device.deviceId, {
        policy: args.policy ?? "report",
        match: args.match ?? [],
        ...(owner ? { owner } : {}),
      });
    }
    return createStructuredToolResponse(policyState(device, args.action, registry));
  };

const systemAlertsTool = defineDeviceTool({
  name: "systemAlerts",
  description:
    "Set how OS permission and system alerts are handled before and after each UI interaction (tapOn, " +
    "tapAt, tapAny, swipeOn, swipeAt, sendKeys, pressButton, dragAndDrop, dragPath, pinchOn, multiTouch) " +
    "on this device, including executePlan steps. iOS: SpringBoard permission prompts; Android: " +
    "permission-controller grant dialogs. report (default) never taps and surfaces the alert in the " +
    "action's warnings; allow, deny and allowOnce tap that button; match names a button by label for " +
    "localized or app-specific alerts. Every alert seen or answered is reported in the action's " +
    "warnings. A policy set in a daemon session clears when the session is released.",
  input: systemAlertsInput,
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    deviceReadOnly: (args: { action?: string }) => args.action === "get",
    deviceReadOnlyArgs: [{ argument: "action", values: ["get"] }],
    outputSchema: systemAlertsOutput,
  },
});

export const systemAlertsSchema = systemAlertsTool.schema;

export function registerSystemAlertTools(deps: SystemAlertsToolDependencies = {}): void {
  systemAlertsTool.register(undefined, createSystemAlertsHandler(deps));
}
