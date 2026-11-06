import { z } from "zod";

/**
 * Data decoders for the `cast` platform module's events (#14239), the TypeScript reference that
 * the Kotlin `PrototypeCastEvents` and Swift `PrototypeCastEvents` twins mirror. All three replay
 * `test/fixtures/prototype-spec/cast/events.json`.
 *
 * Every event's data is a closed object: unknown keys are refused, so a runtime that grows a field
 * has to grow it here and in both twins first.
 */
export const PROTOTYPE_CAST_EVENTS = [
  "routesChanged",
  "sessionStarting",
  "sessionStarted",
  "sessionEnded",
  "sessionFailed",
  "remoteVolume",
] as const;

/** Why a session failed. `media_not_castable`: the player source is not an absolute http(s) URL. */
export const PROTOTYPE_CAST_FAILURE_REASONS = [
  "media_not_castable",
  "play_services_unavailable",
  "network",
  "receiver",
] as const;

const castState = z.enum(["unavailable", "noDevices", "notConnected", "connecting", "connected"]);
const castProtocol = z.enum(["googleCast", "airplay"]);
const player = z.string().min(1).max(64);
const deviceName = z.string().max(256);
const count = z.number().int().nonnegative();

const session = { player, protocol: castProtocol, deviceName };
const sessionWithPosition = z.object({ ...session, positionMs: count }).strict();

const castEventDataSchemas = {
  routesChanged: z.object({ state: castState, routeCount: count }).strict(),
  sessionStarting: z.object(session).strict(),
  sessionStarted: sessionWithPosition,
  sessionEnded: sessionWithPosition,
  sessionFailed: z
    .object({
      player,
      reason: z.enum(PROTOTYPE_CAST_FAILURE_REASONS),
      protocol: castProtocol.optional(),
    })
    .strict(),
  remoteVolume: z.object({ volume: z.number().min(0).max(1) }).strict(),
} satisfies Record<(typeof PROTOTYPE_CAST_EVENTS)[number], z.ZodType>;

type CastEventDataSchemas = typeof castEventDataSchemas;

/** A decoded `cast.*` event: its short name and its typed data. */
export type PrototypeCastEvent = {
  [Name in keyof CastEventDataSchemas]: { name: Name; data: z.infer<CastEventDataSchemas[Name]> };
}[keyof CastEventDataSchemas];

function isCastEventName(name: string): name is keyof CastEventDataSchemas {
  return (PROTOTYPE_CAST_EVENTS as readonly string[]).includes(name);
}

/**
 * Decode a delivered platform event's `data` for a qualified `cast.<event>` name. Returns
 * undefined for another module's event, an unknown cast event or data of the wrong shape.
 */
export function decodePrototypeCastEvent(
  event: string,
  data: unknown,
): PrototypeCastEvent | undefined {
  const prefix = "cast.";
  const name = event.startsWith(prefix) ? event.slice(prefix.length) : "";
  if (!isCastEventName(name)) {
    return undefined;
  }
  const parsed = castEventDataSchemas[name].safeParse(data);
  // The cast to the union is sound: `name` selected the schema `parsed.data` came from.
  return parsed.success ? ({ name, data: parsed.data } as PrototypeCastEvent) : undefined;
}
