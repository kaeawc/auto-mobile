import { z } from "zod/v4";

/**
 * `setToolEnabled`: the applied selection for this MCP session's profile, then
 * either the resulting tools/list set or why it could not be read back (the
 * change still applies). Unknown or hidden names throw before anything is written.
 */
export const setToolEnabledResultSchema = z
  .object({
    sessionUuid: z.string(),
    scope: z.enum(["connection-profile", "device-session"]),
    toolName: z.string().optional(),
    toolNames: z.array(z.string()).optional(),
    enabled: z.boolean(),
    skipped: z.array(z.object({ toolName: z.string(), reason: z.literal("always-on") })).optional(),
    enabledTools: z.array(z.string()).optional(),
    enabledToolsError: z.string().optional(),
  })
  .passthrough();
