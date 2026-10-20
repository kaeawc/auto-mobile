import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeDataActionValueSchema, stateKeySchema } from "./prototypeActionValues";
import { PROTOTYPE_REQUEST_METHODS } from "./prototypeRequestProtocol";

/**
 * The `request` action (#12523): an HTTP call whose response is written to `/data` and whose
 * lifecycle is reported through a state key. The contract
 * (`schemas/prototype-spec-contract.json`, `definitions.action.variants.request`) is the shared
 * definition; this is its Zod mirror. Rules the contract cannot express (URL scheme, `into` path,
 * `statusKey` type, bodies on GET) live in `prototypeRequest.ts`.
 *
 * Header and query values are a literal string or a value binding; `body` is a binding, so a
 * literal body is `{value: json}`. `onSuccess` and `onError` are action lists; their nesting is
 * bounded by `MAX_PROTOTYPE_ACTION_DEPTH` in the contract walk, not in Zod.
 */
const bindingValueSchema = z.union([z.string().max(4096), prototypeDataActionValueSchema]);
// Zod cannot name the union it is part of, so the follow-up lists are typed loosely here and
// validated structurally by the contract walk and by the union itself at parse time.
let followUps: (() => z.ZodTypeAny) | undefined;
export function bindPrototypeRequestFollowUps(actionSchema: () => z.ZodTypeAny): void {
  followUps = actionSchema;
}
const followUpSchema = z.lazy((): z.ZodTypeAny => (followUps ? followUps() : z.never()));
const followUpList = z.array(followUpSchema).min(1).max(32).optional();

export const requestActionSchema = z
  .object({
    type: z.enum(["request"]),
    method: z.enum(PROTOTYPE_REQUEST_METHODS).optional(),
    url: z.string().min(1).max(2048),
    headers: z.record(z.string().min(1), bindingValueSchema).optional(),
    query: z.record(z.string().min(1), bindingValueSchema).optional(),
    body: prototypeDataActionValueSchema.optional(),
    into: z
      .string()
      .min(1)
      .max(contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH + 5)
      .optional(),
    statusKey: stateKeySchema.optional(),
    via: z.enum(["host", "device"]).optional(),
    timeoutMs: z
      .number()
      .finite()
      .int()
      .min(1)
      .max(contract.limits.MAX_PROTOTYPE_REQUEST_TIMEOUT_MS)
      .optional(),
    onSuccess: followUpList,
    onError: followUpList,
  })
  .strict();
