import { z } from "zod";
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
