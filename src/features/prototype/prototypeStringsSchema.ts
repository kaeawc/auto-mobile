import { z } from "zod/v3";
import { prototypeStringsTableError, type PrototypeStrings } from "./prototypeStrings";

/**
 * The spec `strings` field; the shared table check decides validity. Kept apart from
 * `prototypeStrings.ts` so the still renderer's browser bundle never carries zod (#16451).
 */
export const prototypeStringsSchema = z.custom<PrototypeStrings>(
  (value) => prototypeStringsTableError(value) === undefined,
);
