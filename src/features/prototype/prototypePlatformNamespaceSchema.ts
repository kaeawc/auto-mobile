import { z } from "zod";
import { prototypeNodeSchema, type PrototypeNode } from "./prototypeSpec";

export type PrototypeIosNamespace = {
  buttonStyle?: "glass" | "glassProminent";
  bottomAccessory?: PrototypeNode;
  tab?: { role: "search" };
  sheet?: { sizing: "form" | "page" | "fitted" };
  hover?: "lift" | "highlight";
  navigationTitle?: "large" | "inline";
};

export const iosPresentationNamespaceSchema = z
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

export const iosNamespaceSchema: z.ZodType<PrototypeIosNamespace, z.ZodTypeDef, unknown> = z
  .object({
    buttonStyle: iosPresentationNamespaceSchema.shape.buttonStyle,
    bottomAccessory: z.lazy(() => prototypeNodeSchema).optional(),
    ...iosPresentationNamespaceSchema.omit({ buttonStyle: true }).shape,
  })
  .strict();

export const prototypePresentationNamespaceShape = {
  ios: iosPresentationNamespaceSchema.optional(),
  android: androidNamespaceSchema.optional(),
};

export const prototypePlatformNamespaceShape = {
  ios: iosNamespaceSchema.optional(),
  android: androidNamespaceSchema.optional(),
};
