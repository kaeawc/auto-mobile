import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { z } from "zod/v3";
import { prototypeOwnKeyRecordV3 } from "./prototypeOwnKeyRecord";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeJsonSchema } from "./prototypeJson";
import { BOUND_STATE_KEY_PATTERN } from "./prototypeTemplate";

/**
 * The small schemas shared by the data actions (#12519) and the `request` action (#12523): a
 * literal key, a (possibly repeat-bound) state key, a `/data` pointer and the value-binding forms.
 * They live here so the request schema can be built before the action union without a cycle.
 */
export const keySchema = z.string().regex(prototypeContractPatterns.stateKey);
// State-key fields also take repeat placeholders such as `liked_{item.id}` (#11051).
export const stateKeySchema = z.string().regex(BOUND_STATE_KEY_PATTERN);
export const pointerSchema = z
  .string()
  .min(1)
  .max(contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH)
  .regex(prototypeContractPatterns.pointer);
/** The emit.context binding forms except `page`; `{value: literal}` is the literal form. */
export const prototypeGeneratedValueSchema = z.union([
  z.object({ generate: z.literal("id") }).strict(),
  z.object({ now: z.enum(["epochMs", "iso"]) }).strict(),
  z.object({ lastGenerated: z.literal(true) }).strict(),
]);
/** Read bindings shared by data actions and route params; excludes generated and literal values. */
export const prototypeReadBindingSchema = z.union([
  z.object({ state: stateKeySchema }).strict(),
  z.object({ item: keySchema }).strict(),
  z.object({ index: z.literal(true) }).strict(),
  z.object({ data: pointerSchema }).strict(),
]);
const prototypeExistingDataValueSchema = z.union([
  ...prototypeReadBindingSchema.options,
  z.object({ value: prototypeJsonSchema }).strict(),
  z.object({ link: keySchema }).strict(),
]);
export const prototypeDataActionValueSchema = z.union([
  ...prototypeGeneratedValueSchema.options,
  ...prototypeExistingDataValueSchema.options,
]);
/** A single unescaped object member; never interpreted as a pointer. */
export const dataMemberSchema = z
  .string()
  .min(1)
  .max(contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH)
  .regex(prototypeContractPatterns.dataMember);
export const dataWhereSchema = z
  .object({
    field: dataMemberSchema,
    equals: prototypeDataActionValueSchema,
  })
  .strict();
export type PrototypeDataActionValue = z.infer<typeof prototypeDataActionValueSchema>;
/**
 * `{match: "text" | "kind"}` (#14233): the tapped linkify match, valid only inside
 * `linkify.onTap`, where the runtime replaces it with the match before the actions run.
 */
export const prototypeMatchBindingSchema = z.object({ match: z.enum(["text", "kind"]) }).strict();

// A data action path is `/data` plus a pointer; a repeat binds a whole `{index}` segment.
export const dataActionPathSchema = z
  .string()
  .min(1)
  .max(contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH + 5);
type PrototypeDataActionBinding =
  | PrototypeDataActionValue
  | z.infer<typeof prototypeMatchBindingSchema>
  | { event: string }
  | { platform: string };
export const dataActionFields: {
  path: z.ZodString;
  value: z.ZodType<PrototypeDataActionBinding>;
} = {
  path: dataActionPathSchema,
  value: z.union([
    ...prototypeDataActionValueSchema.options,
    prototypeMatchBindingSchema,
    z.object({ event: z.union([z.literal(""), pointerSchema]) }).strict(),
    z.object({ platform: pointerSchema }).strict(),
  ]),
};

export const setDataActionSchema = z
  .object({
    type: z.enum(["setData"]),
    ...dataActionFields,
    where: dataWhereSchema.optional(),
    member: dataMemberSchema.optional(),
  })
  .strict();
export const removeDataActionSchema = z
  .object({
    type: z.enum(["removeData"]),
    path: dataActionPathSchema,
    where: dataWhereSchema.optional(),
  })
  .strict();

export const appendDataActionSchema = z
  .object({
    type: z.enum(["appendData"]),
    ...dataActionFields,
    maxItems: z
      .number()
      .int()
      .min(1)
      // The largest runtime budget (#18804); the validator applies the target's own limit.
      .max(contract.runtimeBudgets.prototype_large_budget_v1.MAX_PROTOTYPE_DATA_ARRAY_ITEMS)
      .optional(),
  })
  .strict();
export const upsertDataActionSchema = z
  .object({
    type: z.enum(["upsertData"]),
    ...dataActionFields,
    key: pointerSchema,
    maxItems: z
      .number()
      .int()
      .min(1)
      // The largest runtime budget (#18804); the validator applies the target's own limit.
      .max(contract.runtimeBudgets.prototype_large_budget_v1.MAX_PROTOTYPE_DATA_ARRAY_ITEMS)
      .optional(),
  })
  .strict();

export type PrototypeEmitContextBinding =
  | z.infer<typeof prototypeExistingDataValueSchema>
  | { page: string }
  | z.infer<typeof prototypeMatchBindingSchema>;
export const prototypeEmitContextBindingSchema: z.ZodType<PrototypeEmitContextBinding> = z.union([
  ...prototypeExistingDataValueSchema.options,
  z.object({ page: z.string().min(1) }).strict(),
  prototypeMatchBindingSchema,
]);
// Retain arbitrary context names, including an own __proto__ that a plain record drops.
export const prototypeEmitContextSchema: z.ZodType<Record<string, PrototypeEmitContextBinding>> =
  prototypeOwnKeyRecordV3(z.string().min(1), prototypeEmitContextBindingSchema).refine(
    (context) => Object.keys(context).length <= contract.limits.MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES,
  );

/** Bound action lists expose parsed actions without propagating the union's Zod internals. */
export function buildPrototypeActionListSchema<Action extends z.ZodTypeAny>(
  actionSchema: Action,
): z.ZodType<z.output<Action>[], z.ZodTypeDef, unknown> {
  return z.array(actionSchema).min(1).max(32);
}

/** A `setState` value: a scalar, a match binding, or (with the realtime gate) an event or platform read. */
export const setStateValueSchema = z.union([
  ...prototypeGeneratedValueSchema.options,
  z.string(),
  z.number().finite(),
  z.boolean(),
  prototypeMatchBindingSchema,
  z.object({ link: keySchema }).strict(),
  z.object({ event: z.union([z.literal(""), pointerSchema]) }).strict(),
  z.object({ platform: pointerSchema }).strict(),
]);
