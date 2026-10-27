import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { z } from "zod";
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
export const prototypeDataActionValueSchema = z.union([
  z.object({ state: stateKeySchema }).strict(),
  z.object({ item: keySchema }).strict(),
  z.object({ index: z.literal(true) }).strict(),
  z.object({ data: pointerSchema }).strict(),
  z.object({ value: prototypeJsonSchema }).strict(),
]);
export type PrototypeDataActionValue = z.infer<typeof prototypeDataActionValueSchema>;
/**
 * `{match: "text" | "kind"}` (#14233): the tapped linkify match, valid only inside
 * `linkify.onTap`, where the runtime replaces it with the match before the actions run.
 */
export const prototypeMatchBindingSchema = z.object({ match: z.enum(["text", "kind"]) }).strict();

/**
 * `{event: pointer}` (#14261): a value read from the event or channel frame that is being handled,
 * valid only inside a `platform.on` handler or a channel `routes` / hook action list. The pointer
 * is RFC 6901 against the decoded frame, and the empty pointer is the whole frame.
 */
export const prototypeEventBindingSchema = z
  .object({ event: z.union([z.literal(""), pointerSchema]) })
  .strict();
