import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { keySchema, pointerSchema, prototypeDataActionValueSchema } from "./prototypeActionValues";

/**
 * Realtime channels (#14261): the root `channels` block. The contract
 * (`schemas/prototype-spec-contract.json`, `definitions.channel` and friends) is the shared
 * definition; this is its Zod mirror. Rules the contract cannot express (the URL scheme per kind,
 * forbidden headers, `requires.platform`, the `statusKey` type, which actions a route may run) live
 * in `prototypeChannels.ts`.
 */
const limits = contract.limits;

// Zod cannot name the union the actions are part of, so action lists are bound after it exists.
let actions: (() => z.ZodTypeAny) | undefined;
export function bindPrototypeChannelActions(actionSchema: () => z.ZodTypeAny): void {
  actions = actionSchema;
}
const actionSchema = z.lazy((): z.ZodTypeAny => (actions ? actions() : z.never()));
const actionList = z.array(actionSchema).min(1).max(32);

const headerValue = z.union([z.string().max(4096), prototypeDataActionValueSchema]);

export const channelWhenSchema = z.union([
  z
    .object({
      pointer: pointerSchema,
      equals: z.union([z.string(), z.number().finite(), z.boolean()]),
    })
    .strict(),
  z.object({ pointer: pointerSchema, exists: z.boolean() }).strict(),
  z.object({ event: z.string().min(1).max(128) }).strict(),
]);

export const channelRouteSchema = z
  .object({ when: channelWhenSchema.optional(), actions: actionList })
  .strict();

const reconnectDelay = z.number().finite().int().min(100).max(60000);

export const channelReconnectSchema = z
  .object({
    maxAttempts: z.number().finite().int().min(0).max(20).optional(),
    initialDelayMs: reconnectDelay.optional(),
    maxDelayMs: reconnectDelay.optional(),
  })
  .strict();

export const channelSchema = z
  .object({
    kind: z.enum(["websocket", "sse"]),
    url: z.string().min(1).max(2048),
    protocols: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(limits.MAX_PROTOTYPE_CHANNEL_PROTOCOLS)
      .optional(),
    headers: z
      .record(z.string().min(1), headerValue)
      .refine((headers) => Object.keys(headers).length <= limits.MAX_PROTOTYPE_CHANNEL_HEADERS)
      .optional(),
    via: z.enum(["host", "device"]).optional(),
    connect: z.enum(["onShow", "manual"]).optional(),
    statusKey: keySchema.optional(),
    reconnect: channelReconnectSchema.optional(),
    decode: z.enum(["json", "text"]).optional(),
    routes: z.array(channelRouteSchema).min(1).max(limits.MAX_PROTOTYPE_CHANNEL_ROUTES).optional(),
    onOpen: z.array(actionSchema).max(32).optional(),
    onClose: z.array(actionSchema).max(32).optional(),
    onError: z.array(actionSchema).max(32).optional(),
  })
  .strict();

export const channelsSchema = z
  .record(z.string().min(1), channelSchema)
  .refine((channels) => Object.keys(channels).length <= limits.MAX_PROTOTYPE_CHANNELS);
