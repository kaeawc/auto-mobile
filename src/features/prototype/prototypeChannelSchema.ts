import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { keySchema, pointerSchema, type PrototypeDataActionValue } from "./prototypeActionValues";
import { prototypeJsonSchema, type PrototypeJson } from "./prototypeJson";
import { requestActionSchema } from "./prototypeRequestSchema";

export const prototypeEventPointerSchema = z.union([z.literal(""), pointerSchema]);
/** Channel output stays independent of the Zod object graph used to validate it. */
export type PrototypeChannel = {
  kind: "websocket" | "sse";
  url: string;
  protocols?: string[];
  headers?: Record<string, string | PrototypeDataActionValue>;
  via?: "host" | "device";
  connect?: "onShow" | "manual";
  statusKey?: string;
  reconnect?: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
  decode?: "json" | "text";
  routes?: {
    when?:
      | { pointer: string; equals: PrototypeJson }
      | { pointer: string; exists: boolean }
      | { event: string };
    actions: z.output<z.ZodTypeAny>[];
  }[];
  onOpen?: z.output<z.ZodTypeAny>[];
  onClose?: z.output<z.ZodTypeAny>[];
  onError?: z.output<z.ZodTypeAny>[];
};

export function prototypeChannelsSchema(
  action: () => z.ZodTypeAny,
): z.ZodType<Record<string, PrototypeChannel>, z.ZodTypeDef, unknown> {
  const actions = (min: number) => z.array(z.lazy(action)).min(min).max(32);
  const when = z.union([
    z.object({ pointer: prototypeEventPointerSchema, equals: prototypeJsonSchema }).strict(),
    z.object({ pointer: prototypeEventPointerSchema, exists: z.boolean() }).strict(),
    z.object({ event: z.string().min(1) }).strict(),
  ]);
  return z
    .record(
      keySchema,
      z
        .object({
          kind: z.enum(["websocket", "sse"]),
          url: requestActionSchema.shape.url,
          protocols: z.array(z.string().min(1)).max(4).optional(),
          headers: requestActionSchema.shape.headers,
          via: z.enum(["host", "device"]).optional(),
          connect: z.enum(["onShow", "manual"]).optional(),
          statusKey: keySchema.optional(),
          reconnect: z
            .object({
              maxAttempts: z.number().int().min(0).max(20),
              initialDelayMs: z.number().int().min(100).max(60000),
              maxDelayMs: z.number().int().min(100).max(60000),
            })
            .strict()
            .optional(),
          decode: z.enum(["json", "text"]).optional(),
          routes: z
            .array(z.object({ when: when.optional(), actions: actions(1) }).strict())
            .max(16)
            .optional(),
          onOpen: actions(0).optional(),
          onClose: actions(0).optional(),
          onError: actions(0).optional(),
        })
        .strict(),
    )
    .and(z.unknown())
    .refine((channels) => Object.keys(channels).length <= contract.limits.MAX_PROTOTYPE_CHANNELS);
}
