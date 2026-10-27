import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import {
  buildPrototypeActionListSchema,
  prototypeDataActionValueSchema,
  type PrototypeDataActionValue,
} from "./prototypeActionValues";

// Reuse the neighbouring value bindings; routes accept flat scalar literals, never {value: JSON}.
type RouteParams = Record<string, string | number | boolean | PrototypeDataActionValue>;

// Preserve the parsed union without copying every binding schema into navigation actions.
export const routeParamsSchema: z.ZodType<RouteParams, z.ZodTypeDef, unknown> = z
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

// Keep the action union's parsed type without propagating its full Zod implementation
// through every recursive stack node and every consumer of PrototypeNode.
interface Route<Action> {
  params?: Record<string, "string" | "number" | "boolean">;
  onEnter?: Action[];
  onBack?: Action[];
}

export function buildRouteSchema<Action extends z.ZodTypeAny>(
  actionSchema: Action,
): z.ZodType<Route<z.output<Action>>, z.ZodTypeDef, unknown> {
  const actions = buildPrototypeActionListSchema(actionSchema);
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
      onEnter: actions.optional(),
      onBack: actions.optional(),
    })
    .strict();
}
