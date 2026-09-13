import { z } from "zod/v4";
import type { SessionToolSelectionService } from "../features/toolSelection/SessionToolSelectionService";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";
import { getSessionToolSelectionService } from "../features/toolSelection/SessionToolSelectionService";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { ActionableError } from "../models";
import { withJsonSchemaOverride } from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ToolRegistry } from "./toolRegistry";

export { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";

/**
 * The tool-selection service as a caller may hold it: either the real
 * singleton, or the narrower object `ToolSelectionContext` /
 * `createMcpServer(options)` inject in tests.
 */
export type ToolSelectionServiceLike =
  | (Pick<SessionToolSelectionService, "isEnabled"> &
      Partial<Pick<SessionToolSelectionService, "setEnabled" | "setEnabledMany">>)
  | undefined;

/**
 * #6869 — the `enableTools` request field shared by the device-acquisition
 * tools (`getAndroid`, `getApple`, `provisionDevice`), which apply it while
 * minting the session so acquisition and capability declaration are one call.
 * Same vocabulary and same validation as `setToolEnabled`'s `toolNames`.
 */
export const enableToolsSchemaField = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    "Exact case-sensitive AutoMobile tool names to enable for the session this call mints, " +
      "applied before the response is built so the returned enabledTools/gatedTools reflect them. " +
      "An unknown or non-configurable name rejects the call before any device work starts.",
  );

export const setToolEnabledSchema = withJsonSchemaOverride(
  z
    .object({
      toolName: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Exact case-sensitive AutoMobile tool name to enable or disable. The listed choices include optional tools absent from tools/list until enabled. Provide either toolName or toolNames.",
        ),
      toolNames: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          "Exact case-sensitive AutoMobile tool names to enable or disable in ONE call, applied all-or-nothing: an unknown or non-configurable name rejects the whole request before anything is written. Provide either toolName or toolNames.",
        ),
      enabled: z
        .boolean()
        .default(true)
        .optional()
        .describe("Whether to enable the tools (default: true)."),
      sessionUuid: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Active connection or routing-session profile to update. Omit to update this MCP connection's profile.",
        ),
    })
    .superRefine((value, ctx) => {
      if ((value.toolName === undefined) === (value.toolNames === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "Provide exactly one of toolName (one tool) or toolNames (a batch).",
          path: ["toolName"],
        });
      }
    }),
  // The runtime refinement above only protects a caller that already sent the
  // request. Zod emits no JSON Schema for `.superRefine`, so without this
  // override `tools/list` and schemas/tool-definitions.json would advertise both
  // a nameless request and a `toolName` + `toolNames` request as valid while
  // invocation rejects them. `if`/`then`/`else` encodes the exclusive-or exactly
  // and — unlike a top-level `oneOf` — keeps the advertised schema free of
  // top-level combinators, which `schema.integration.test.ts` gates repo-wide
  // (same convention as setDeviceState's reset exclusivity).
  (jsonSchema) => {
    jsonSchema.if = { required: ["toolName"] };
    jsonSchema.then = { not: { required: ["toolNames"] } };
    jsonSchema.else = { required: ["toolNames"] };
  },
);

function resolveSelectionSessionUuid(
  requestedSessionUuid: string | undefined,
  connectionProfileUuid: string | undefined,
  routingSessionUuid: string | undefined,
): string {
  const sessionUuid = requestedSessionUuid ?? connectionProfileUuid ?? routingSessionUuid;
  if (!sessionUuid) {
    throw new ActionableError("Unable to establish an MCP session profile for this tool update.");
  }
  if (
    requestedSessionUuid !== undefined &&
    requestedSessionUuid !== connectionProfileUuid &&
    requestedSessionUuid !== routingSessionUuid
  ) {
    throw new ActionableError(
      "sessionUuid must identify this connection's active tool-selection or routing session profile.",
    );
  }
  return sessionUuid;
}

/**
 * Reject every name that is not a user-configurable tool, naming them all at
 * once. This runs BEFORE the first write (and, for `enableTools`, before the
 * device work starts), which is what makes a batch all-or-nothing: a caller
 * never has to reason about which prefix of its list landed.
 */
export function assertUserConfigurableToolNames(toolNames: readonly string[]): void {
  const unknown = toolNames.filter((toolName) => !ToolRegistry.isUserConfigurableTool(toolName));
  if (unknown.length === 1) {
    throw new ActionableError(`Tool '${unknown[0]}' is not user-configurable.`);
  }
  if (unknown.length > 1) {
    throw new ActionableError(
      `Tools ${unknown.map((toolName) => `'${toolName}'`).join(", ")} are not user-configurable.`,
    );
  }
}

function resolveSelectionService(
  service: ToolSelectionServiceLike,
): Pick<SessionToolSelectionService, "isEnabled" | "setEnabled"> &
  Partial<Pick<SessionToolSelectionService, "setEnabledMany">> {
  if (service && !service.setEnabled) {
    throw new ActionableError(
      "This MCP server's injected tool-selection service is read-only and cannot update tools.",
    );
  }
  return (service ?? getSessionToolSelectionService()) as Pick<
    SessionToolSelectionService,
    "isEnabled" | "setEnabled"
  > &
    Partial<Pick<SessionToolSelectionService, "setEnabledMany">>;
}

/**
 * Persist one enable/disable decision for every requested name. Names are
 * validated and the service is resolved up front, so nothing is written unless
 * the whole request is applicable; duplicates collapse to one write.
 *
 * The writes themselves go through `setEnabledMany`, one repository operation
 * for the whole batch (a transaction in SQLite), so the advertised
 * all-or-nothing contract also survives a mid-batch STORAGE failure and a
 * concurrent batch for the same session — not just an unknown name (#6886
 * review). A narrower injected service that only offers `setEnabled` keeps the
 * per-name loop; only tests inject one.
 */
export async function applyToolSelection(
  service: ToolSelectionServiceLike,
  sessionUuid: string,
  toolNames: readonly string[],
  enabled: boolean,
): Promise<string[]> {
  const requested = [...new Set(toolNames)];
  assertUserConfigurableToolNames(requested);
  const resolved = resolveSelectionService(service);
  if (resolved.setEnabledMany) {
    await resolved.setEnabledMany(sessionUuid, requested, enabled);
    return requested;
  }
  for (const toolName of requested) {
    await resolved.setEnabled(sessionUuid, toolName, enabled);
  }
  return requested;
}

/**
 * The user-configurable tools currently enabled for `sessionUuid` — the exact
 * complement of the `gatedTools` array the acquisition tools already return, so
 * a caller can confirm the resulting capability set in one look (#6869).
 */
export async function listEnabledToolNames(
  service: ToolSelectionServiceLike,
  sessionUuid: string,
): Promise<string[]> {
  const resolved = service ?? getSessionToolSelectionService();
  const names = await Promise.all(
    ToolRegistry.getAllTools()
      .filter((tool) => ToolRegistry.isUserConfigurableTool(tool.name))
      .map(async (tool) =>
        (await resolved.isEnabled(sessionUuid, tool.name, tool.defaultEnabled ?? true))
          ? tool.name
          : undefined,
      ),
  );
  return names.filter((toolName): toolName is string => toolName !== undefined).sort();
}

export function registerToolSelectionTools(): void {
  ToolRegistry.register(
    SET_TOOL_ENABLED_TOOL_NAME,
    "Enable or disable AutoMobile tools for this MCP session: one exact name via toolName, or a whole batch in one call via toolNames. Returns the resulting enabled set.",
    setToolEnabledSchema,
    async (args) => {
      const context = getToolSelectionContext();
      const sessionUuid = resolveSelectionSessionUuid(
        args.sessionUuid,
        context?.toolSelectionProfileUuid,
        context?.routingSessionUuid,
      );
      const enabled = args.enabled ?? true;
      const requested = await applyToolSelection(
        context?.sessionToolSelectionService,
        sessionUuid,
        args.toolNames ?? [args.toolName!],
        enabled,
      );
      ToolRegistry.notifyToolListChanged();
      return createJSONToolResponse({
        sessionUuid,
        // The single-name request keeps its original `toolName` echo; a batch
        // echoes the applied `toolNames` instead (#6869).
        ...(args.toolNames ? { toolNames: requested } : { toolName: args.toolName }),
        enabled,
        enabledTools: await listEnabledToolNames(context?.sessionToolSelectionService, sessionUuid),
      });
    },
    { defaultEnabled: true },
  );
}
