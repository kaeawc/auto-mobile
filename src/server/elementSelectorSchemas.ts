import { z } from "zod/v4";
import type { ElementQuery } from "../models/ElementQuery";
import { withJsonSchemaOverride } from "./toolSchemaHelpers";

type ElementIdTextDescriptions = {
  elementId: string;
  text: string;
};

export const createElementIdTextSelectorSchema = (descriptions: ElementIdTextDescriptions) =>
  z.union([
    z
      .object({
        elementId: z.string().describe(descriptions.elementId),
      })
      .strict(),
    z
      .object({
        text: z.string().describe(descriptions.text),
      })
      .strict(),
  ]);

export const elementSelectionStrategySchema = z.enum(["first", "random", "unique"]);

/** Reused by every public scoped selector, including recursive ancestors. */
export const elementContainerSchema: z.ZodType<ElementQuery> = withJsonSchemaOverride(
  z
    .lazy(() => {
      const scopeFields = {
        container: elementContainerSchema
          .optional()
          .describe("Strict ancestor scope; wrappers may intervene"),
        index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Zero-based scoped occurrence; overrides uniqueness at this level"),
        selectionStrategy: elementSelectionStrategySchema
          .optional()
          .describe("Inherited from the query; unique is recommended"),
      };
      return z.union([
        z.object({ elementId: z.string().min(1), ...scopeFields }).strict(),
        z.object({ text: z.string().min(1), ...scopeFields }).strict(),
        z
          .object({
            testTag: z.string().min(1).describe("Android accessibility test tag"),
            ...scopeFields,
          })
          .strict(),
      ]);
    })
    .meta({ id: "ElementQuery" }),
  (schema) => {
    // Zod 3.25's v4 registry name also leaks as draft-04 `id`; retain the
    // generated $defs key, but do not advertise that obsolete keyword.
    delete schema.id;
  },
);

export const elementIdTextFieldsSchema = z
  .object({
    elementId: z.string().describe("Resource ID, e.g. com.app:id/btn_login").optional(),
    text: z.string().describe("Text, content-desc, or placeholder").optional(),
  })
  .strict();

export const validateElementIdTextSelector = (
  value: { elementId?: string; text?: string },
  ctx: z.RefinementCtx,
  message: string = "Provide exactly one of elementId or text",
): void => {
  const hasElementId = value.elementId !== undefined;
  const hasText = value.text !== undefined;

  if (hasElementId === hasText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
    });
  }
};
