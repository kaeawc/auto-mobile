import { z } from "zod/v4";

type ElementIdTextDescriptions = {
  elementId: string;
  text: string;
};

export const createElementIdTextSelectorSchema = (
  descriptions: ElementIdTextDescriptions
) => z.union([
  z.object({
    elementId: z.string().describe(descriptions.elementId)
  }).strict(),
  z.object({
    text: z.string().describe(descriptions.text)
  }).strict()
]);

export const elementContainerSchema = createElementIdTextSelectorSchema({
  elementId: "Container resource ID",
  text: "Container text"
});


export const elementIdTextFieldsSchema = z.object({
  elementId: z.string().describe("Resource ID, e.g. com.app:id/btn_login").optional(),
  text: z.string().describe("Text, content-desc, or placeholder").optional()
}).strict();

export const elementSelectionStrategySchema = z.enum(["first", "random"]);

export const validateElementIdTextSelector = (
  value: { elementId?: string; text?: string },
  ctx: z.RefinementCtx,
  message: string = "Provide exactly one of elementId or text"
): void => {
  const hasElementId = value.elementId !== undefined;
  const hasText = value.text !== undefined;

  if (hasElementId === hasText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message
    });
  }
};
