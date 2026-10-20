import { z } from "zod";

export type PrototypeJson =
  | null
  | string
  | number
  | boolean
  | PrototypeJson[]
  | { [key: string]: PrototypeJson };
// zod v3 calls a lazy schema's getter on every parse, so each getter builds its schema once and
// returns that same instance afterwards instead of rebuilding it for every nested value.
let jsonValueUnion: z.ZodType<PrototypeJson> | undefined;
const jsonValueSchema: z.ZodType<PrototypeJson> = z.lazy(
  () =>
    (jsonValueUnion ??= z.union([
      z.null(),
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.array(jsonValueSchema),
      z.record(jsonValueSchema),
    ])),
);
// Preserve arbitrary JSON keys: Zod record decoding deliberately drops __proto__.
export const prototypeJsonSchema = z.custom<PrototypeJson>(
  (value) => jsonValueSchema.safeParse(value).success,
);
export const prototypeJsonObjectSchema = z.record(prototypeJsonSchema).and(z.unknown());
