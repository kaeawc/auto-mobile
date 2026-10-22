import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import type { PrototypeCheckFormat } from "./prototypeChecks";

/** Per-field validation rules a prototype input node can declare. */
export const prototypeCheckSchema = z.union([
  z.object({ message: z.string().min(1), required: z.literal(true) }).strict(),
  z.object({ message: z.string().min(1), minLength: z.number().finite().int().min(0) }).strict(),
  z.object({ message: z.string().min(1), maxLength: z.number().finite().int().min(0) }).strict(),
  z.object({ message: z.string().min(1), min: z.number().finite() }).strict(),
  z.object({ message: z.string().min(1), max: z.number().finite() }).strict(),
  z
    .object({
      message: z.string().min(1),
      format: z.enum(
        contract.definitions.check.fields.format.rule.values as [
          PrototypeCheckFormat,
          ...PrototypeCheckFormat[],
        ],
      ),
    })
    .strict(),
  z
    .object({
      message: z.string().min(1),
      pattern: z.string().max(contract.definitions.check.fields.pattern.rule.max),
    })
    .strict(),
]);
export type PrototypeCheck = z.infer<typeof prototypeCheckSchema>;
