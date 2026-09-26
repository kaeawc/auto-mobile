import { z } from "zod/v4";

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

export const elementContainerSchema = createElementIdTextSelectorSchema({
  elementId: "Container resource ID",
  text: "Container text",
});

export const elementIdTextFieldsSchema = z
  .object({
    elementId: z.string().describe("Resource ID, e.g. com.app:id/btn_login").optional(),
    text: z.string().describe("Text, content-desc, or placeholder").optional(),
  })
  .strict();

export const elementSelectionStrategySchema = z.enum(["first", "random"]);

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

/** Canonical resolver selector. Tools compose this schema as they migrate. */
export interface ResolverSelector {
  elementId?: string;
  text?: string;
  testTag?: string;
  contentDescription?: string;
  className?: string;
  index?: number;
  selectionStrategy?: "first" | "random";
  match?: "exact" | "contains" | "regex";
  caseSensitive?: boolean;
  container?: ResolverSelector;
  sibling?: ResolverSelector;
}

export const resolverSelectorSchema: z.ZodType<ResolverSelector> = z.lazy(() =>
  z
    .object({
      elementId: z.string().min(1).optional(),
      text: z.string().trim().min(1).optional(),
      contentDescription: z.string().trim().min(1).optional(),
      className: z.string().min(1).optional(),
      testTag: z.string().min(1).optional(),
      index: z.number().int().nonnegative().optional(),
      selectionStrategy: elementSelectionStrategySchema.optional(),
      match: z.enum(["exact", "contains", "regex"]).optional(),
      caseSensitive: z.boolean().optional(),
      container: resolverSelectorSchema.optional(),
      sibling: resolverSelectorSchema.optional(),
    })
    .strict()
    .refine(
      (selector) =>
        [
          selector.elementId,
          selector.text,
          selector.testTag,
          selector.contentDescription,
          selector.className,
        ].filter((value) => value !== undefined).length <= 1,
      "Provide at most one of elementId, text, or testTag",
    ),
);
