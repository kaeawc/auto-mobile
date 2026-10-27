import { z } from "zod";

export const iosNamespaceSchema = z
  .object({
    buttonStyle: z.enum(["glass", "glassProminent"]).optional(),
    tab: z
      .object({ role: z.enum(["search"]) })
      .strict()
      .optional(),
    sheet: z
      .object({ sizing: z.enum(["form", "page", "fitted"]) })
      .strict()
      .optional(),
    hover: z.enum(["lift", "highlight"]).optional(),
    navigationTitle: z.enum(["large", "inline"]).optional(),
  })
  .strict();

export const androidNamespaceSchema = z
  .object({
    predictiveBack: z
      .object({ style: z.enum(["default", "crossActivity", "none"]) })
      .strict()
      .optional(),
    indication: z.enum(["ripple", "none"]).optional(),
  })
  .strict();

export const prototypePlatformNamespaceShape = {
  ios: iosNamespaceSchema.optional(),
  android: androidNamespaceSchema.optional(),
};
