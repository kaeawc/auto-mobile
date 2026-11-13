import { z } from "zod/v4";
import { defaultDaemonContext, type DaemonContext } from "../daemon/daemonContext";
import type { SessionBroker } from "../daemon/sessionBroker/broker";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { definePlainTool } from "./defineTool";

const osSelectorSchema = z.object({
  kind: z.enum(["exact", "major", "minimum"]),
  version: z.string().optional(),
  major: z.number().optional(),
});

const runtimeSchema = z.object({ runtime: z.string(), osVersion: z.string() });

export const sessionRequirementCapabilityResultSchema = z.object({
  success: z.boolean(),
  code: z.string().optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
  platform: z.enum(["ios", "android"]).optional(),
  policyVersion: z.string().optional(),
  catalog: z.object({ source: z.string(), revision: z.string() }).optional(),
  resolvedOs: z
    .object({
      source: z.enum(["request", "device-type-default", "platform-default"]),
      selector: osSelectorSchema,
      osVersion: z.string().optional(),
      runtime: z.string().optional(),
    })
    .optional(),
  satisfiable: z.boolean().optional(),
  reason: z
    .object({
      code: z.string(),
      message: z.string(),
      transient: z.boolean(),
      field: z.string().optional(),
    })
    .optional(),
  installedRuntimes: z.array(runtimeSchema).optional(),
  defaultOsSatisfiable: z.boolean().optional(),
  anyOsSatisfiable: z.boolean().optional(),
});

const capabilityInput = z.object({
  device: z
    .record(z.string(), z.unknown())
    .describe(
      'A session device requirement, as prepareSession takes it: {"schemaVersion":1,"platform":"ios"|"android","hardware":{...},"os":{"kind":"omitted"} or an exact/major/minimum selector}.',
    ),
});

export type SessionRequirementCapabilityBroker = () =>
  | Pick<SessionBroker, "requirementCapability">
  | undefined;

/** Read-only (#18180): answers from the broker's catalog and defaults; acquires nothing. */
export const createSessionRequirementCapabilityHandler =
  (broker: SessionRequirementCapabilityBroker) =>
  async (args: z.output<typeof capabilityInput>, _progress?: unknown, signal?: AbortSignal) => {
    const service = broker();
    if (!service) {
      return withIsErrorOnFailure(
        createStructuredToolResponse({
          success: false,
          code: "session_broker_unavailable",
          error: "This daemon is not running the session broker; start it in session-broker mode.",
          retryable: false,
        }),
        false,
      );
    }
    const answer = await service.requirementCapability(args.device, signal);
    if (!answer.ok) {
      return withIsErrorOnFailure(
        createStructuredToolResponse({
          success: false,
          code: answer.error.code,
          error: answer.error.message,
          retryable: answer.error.transient,
        }),
        false,
      );
    }
    return createStructuredToolResponse({ success: true, ...answer.value });
  };

const sessionRequirementCapabilityTool = definePlainTool({
  name: "getSessionRequirementCapability",
  description:
    "Report the OS a session device requirement would resolve to on this broker host and whether it is satisfiable now, without acquiring a device.",
  input: capabilityInput,
  options: {
    defaultEnabled: false,
    readOnly: true,
    outputSchema: sessionRequirementCapabilityResultSchema,
  },
});

export const sessionRequirementCapabilitySchema = sessionRequirementCapabilityTool.schema;

export function registerSessionRequirementCapabilityTool(
  daemon: Pick<DaemonContext, "sessionBrokerService"> = defaultDaemonContext,
): void {
  sessionRequirementCapabilityTool.register(
    undefined,
    createSessionRequirementCapabilityHandler(() => daemon.sessionBrokerService()?.broker),
  );
}
