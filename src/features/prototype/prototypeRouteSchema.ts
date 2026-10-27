import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeDataActionValueSchema } from "./prototypeActionValues";

// Reuse the neighbouring value bindings; routes accept flat scalar literals, never {value: JSON}.
export const routeParamsSchema = z
  .record(
    z.string().regex(prototypeContractPatterns.pathKey),
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      ...prototypeDataActionValueSchema.options.slice(0, 4),
    ]),
  )
  .and(z.unknown())
  .refine((value) => Object.keys(value).length <= 16);

export const setStackActionSchema = z
  .object({
    type: z.enum(["setStack"]),
    stack: z.string().min(1),
    path: z
      .array(z.object({ screen: z.string().min(1), params: routeParamsSchema.optional() }).strict())
      .min(1)
      .max(contract.limits.MAX_PROTOTYPE_STACK_DEPTH),
  })
  .strict();

export function buildRouteSchema<Action extends z.ZodTypeAny>(actionSchema: Action) {
  return z
    .object({
      params: z
        .record(
          z.string().regex(prototypeContractPatterns.pathKey),
          z.enum(["string", "number", "boolean"]),
        )
        .and(z.unknown())
        .refine((value) => Object.keys(value).length <= 16)
        .optional(),
      onEnter: z.array(actionSchema).min(1).max(32).optional(),
      onBack: z.array(actionSchema).min(1).max(32).optional(),
    })
    .strict();
}
