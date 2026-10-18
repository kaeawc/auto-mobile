import { z } from "zod";
import type { DaemonRequest } from "./types";

/**
 * Shared zod envelope for frames arriving on the daemon control socket (#11813). It validates only
 * the routing fields every frame needs (`id`, `type`, `method`); `params` stays `unknown` here and
 * each route narrows it with its own schema (see `inputRouteParams.ts`). Unknown envelope fields
 * pass through so additive client fields keep working.
 */
export const daemonRequestEnvelopeSchema = z
  .object({
    id: z.string(),
    type: z.enum(["mcp_request", "daemon_request"]),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();

/** Type guard form of the envelope check, for the socket's raw-frame path. */
export function isDaemonRequestEnvelope(parsed: unknown): parsed is DaemonRequest {
  return daemonRequestEnvelopeSchema.safeParse(parsed).success;
}

const platformHintSchema = z.object({ platform: z.enum(["android", "ios"]) }).passthrough();

/**
 * The `platform` an `input/*` frame names, or undefined when params are absent, not an object, or
 * name anything but android/ios. Route parsers own the refusal text for a malformed platform.
 */
export function readFramePlatformHint(params: unknown): "android" | "ios" | undefined {
  const parsed = platformHintSchema.safeParse(params);
  return parsed.success ? parsed.data.platform : undefined;
}
