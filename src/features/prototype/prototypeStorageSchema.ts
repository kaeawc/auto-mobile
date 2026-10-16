import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";

/**
 * The typed decode of the spec's `storage` block (#12522). The contract checks the shape first;
 * cross-references (declared state keys, `/data` pointers, byte limit) are `prototypeStorageError`.
 */
export const prototypeStorageSchema = z
  .object({
    version: z.number().int().min(1).max(2147483647),
    keys: z
      .array(z.string().min(1).max(261))
      .min(1)
      .max(contract.limits.MAX_PROTOTYPE_STORAGE_KEYS)
      .refine((keys) => new Set(keys).size === keys.length),
  })
  .strict();
