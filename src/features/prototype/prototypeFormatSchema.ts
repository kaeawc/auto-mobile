import { z } from "zod";
import { keySchema, pointerSchema } from "./prototypeActionValues";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
const fraction = z.number().int().min(0).max(20).optional();
const fractions = { minFraction: fraction, maxFraction: fraction };
const styles = z.enum(["short", "medium", "long"]).optional();
export const prototypeFormatSchema = z.union([
  z
    .object({ number: z.object({ ...fractions, grouping: z.boolean().optional() }).strict() })
    .strict(),
  z
    .object({ compact: z.object({ style: z.enum(["short", "long"]).optional() }).strict() })
    .strict(),
  z
    .object({
      currency: z
        .object({ code: z.string().regex(prototypeContractPatterns.currencyCode) })
        .strict(),
    })
    .strict(),
  z.object({ percent: z.object(fractions).strict() }).strict(),
  z.object({ date: z.object({ style: styles }).strict() }).strict(),
  z.object({ time: z.object({ style: styles }).strict() }).strict(),
  z
    .object({
      relative: z.object({ style: z.enum(["narrow", "short", "long"]).optional() }).strict(),
    })
    .strict(),
]);
const key = keySchema;
const literal = z.union([z.string(), z.number().finite()]);
const of = z.union([
  z.object({ data: pointerSchema }).strict(),
  z.object({ state: key }).strict(),
  z.object({ value: literal }).strict(),
]);
const entry = {
  format: prototypeFormatSchema,
  locale: z.string().max(35).regex(prototypeContractPatterns.formatLocale).optional(),
  timeZone: z.string().max(128).regex(prototypeContractPatterns.formatTimeZone).optional(),
};
export const prototypeDerivedEntrySchema = z.object({ of, ...entry }).strict();
export const prototypeRepeatDerivedEntrySchema = z
  .object({
    of: z.union([z.object({ item: key }).strict(), z.object({ value: literal }).strict()]),
    ...entry,
  })
  .strict();
export const prototypeDeriveSchema = z
  .record(key, prototypeDerivedEntrySchema)
  .refine((value) => Object.keys(value).length <= 32);
export const prototypeRepeatDeriveSchema = z
  .record(key, prototypeRepeatDerivedEntrySchema)
  .refine((value) => Object.keys(value).length <= 8);
export type PrototypeFormat = z.infer<typeof prototypeFormatSchema>;
export type PrototypeDerivedEntry = z.infer<typeof prototypeDerivedEntrySchema>;
export type PrototypeRepeatDerivedEntry = z.infer<typeof prototypeRepeatDerivedEntrySchema>;
