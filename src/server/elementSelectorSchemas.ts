import { z } from "zod/v4";
import {
  ELEMENT_SELECTION_STRATEGIES,
  type ElementSelectionStrategy,
} from "../models/ElementSelectionStrategy";
import type { ElementContainerSelector } from "../models/PinchOnOptions";

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

export const resolverSelectionStrategySchema = z.enum(ELEMENT_SELECTION_STRATEGIES);

export const nestedElementContainerSchema: z.ZodType<ElementContainerSelector> = z.lazy(() =>
  z.union([
    z
      .object({
        elementId: z.string().min(1).describe("Container resource ID"),
        index: z.number().int().nonnegative().optional(),
        selectionStrategy: resolverSelectionStrategySchema.optional(),
        container: nestedElementContainerSchema.optional(),
      })
      .strict(),
    z
      .object({
        text: z.string().trim().min(1).describe("Container text"),
        index: z.number().int().nonnegative().optional(),
        selectionStrategy: resolverSelectionStrategySchema.optional(),
        container: nestedElementContainerSchema.optional(),
      })
      .strict(),
  ]),
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

/** Canonical resolver selector. Tools compose this schema as they migrate. */
export interface ResolverSelector {
  elementId?: string;
  text?: string;
  testTag?: string;
  contentDescription?: string;
  className?: string;
  index?: number;
  selectionStrategy?: ElementSelectionStrategy;
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
      selectionStrategy: resolverSelectionStrategySchema.exclude(["unique"]).optional(),
      match: z.enum(["exact", "contains", "regex"]).optional(),
      caseSensitive: z.boolean().optional(),
      container: resolverSelectorSchema.optional(),
      sibling: resolverSelectorSchema.optional(),
    })
    .strict()
    .refine(
      (selector) => selector.elementId === undefined || selector.match !== "regex",
      "Element ID selectors do not support regular expressions",
    )
    .refine(
      (selector) =>
        (selector.testTag === undefined && selector.className === undefined) ||
        selector.match === undefined ||
        selector.match === "exact",
      "Test tag and class selectors support exact matching only",
    )
    .refine(
      (selector) =>
        [
          selector.elementId,
          selector.text,
          selector.testTag,
          selector.contentDescription,
          selector.className,
        ].filter((value) => value !== undefined).length <= 1,
      "Provide at most one of elementId, text, testTag, contentDescription, or className",
    ),
);

export const tapOnSelectorSchema = z
  .union([
    z
      .object({ elementId: z.string().min(1).describe("Resource ID, e.g. com.app:id/btn_login") })
      .strict(),
    z.object({ testTag: z.string().min(1).describe("Android accessibility test tag") }).strict(),
    z.object({ text: z.string().min(1).describe("Text, content-desc, or placeholder") }).strict(),
    z
      .object({
        accessibilityLink: z
          .string()
          .trim()
          .min(1)
          .describe("Exact visible text of a semantic accessibility link"),
      })
      .strict(),
    z
      .object({
        textAny: z
          .array(z.string().min(1))
          .min(1)
          .describe("Ordered text variants; first visible match wins"),
      })
      .strict(),
  ])
  .describe(
    "Element to tap: elementId, Android testTag, text, semantic accessibility link, or ordered text variants",
  );
