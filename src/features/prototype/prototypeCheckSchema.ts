import { z } from "zod";

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
      format: z.enum(["email", "phone", "digits", "decimal", "url"]),
    })
    .strict(),
  z.object({ message: z.string().min(1), pattern: z.string().max(128) }).strict(),
]);
export type PrototypeCheck = z.infer<typeof prototypeCheckSchema>;
