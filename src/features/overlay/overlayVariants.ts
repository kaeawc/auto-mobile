import { z } from "zod";
import { ActionableError } from "../../models/ActionableError";
import {
  overlayNodeSchema,
  placementSchema,
  type OverlayNode,
  type OverlaySpec,
} from "./overlaySpec";
import { validateOverlaySpec } from "./overlayValidation";

// Twelve labeled image pages use 109 nodes and 12 images, leaving room for
// fragments within the contract's 500-node/32-image budgets. The final spec
// validator also enforces the byte, depth and aggregate fragment budgets.
export const MAX_VARIANTS = 12;
export const MAX_VARIANT_LABEL_LENGTH = 256;
export const VARIANT_PAGER_ID = "variants";
const assetImageSchema = z
  .object({
    asset: z.string().min(1),
    contentScale: z.enum(["fit", "crop", "fill"]).optional(),
  })
  .strict();
const variantBaseSchema = z
  .object({
    label: z.string().max(MAX_VARIANT_LABEL_LENGTH).optional(),
    image: assetImageSchema.optional(),
    spec: overlayNodeSchema.optional(),
  })
  .strict();
// Export the public input vocabulary for MCP advertisement; composition validates
// fragments in context through the bounded canonical spec validator instead.
export const variantListSchema = z.array(variantBaseSchema).min(1).max(MAX_VARIANTS);
const envelopeVariantSchema = variantBaseSchema.extend({
  image: z.unknown().optional(),
  spec: z.custom<OverlayNode>().optional(),
});
const floatingPlacement = placementSchema.options[2];
const inputSchema = z
  .object({
    id: z.string().min(1),
    variants: z.array(envelopeVariantSchema).min(1).max(MAX_VARIANTS),
    presentation: z.enum(["fullscreen", "floating"]).optional(),
    opacity: z.number().finite().int().min(0).max(100).optional(),
    gravity: floatingPlacement.shape.gravity.optional(),
    offset: floatingPlacement.shape.offset.optional(),
  })
  .strict();

/** Exactly one image (existing opaque asset reference) or spec (public node fragment). */
export type OverlayVariant = { label?: string } & (
  | { image: z.infer<typeof assetImageSchema>; spec?: never }
  | { spec: OverlayNode; image?: never }
);
export interface VariantCarouselInput {
  id: string;
  variants: OverlayVariant[];
  presentation?: "fullscreen" | "floating";
  opacity?: number;
  gravity?: z.infer<typeof floatingPlacement>["gravity"];
  offset?: { x: number; y: number };
}

function variantContent(
  variant: z.infer<typeof envelopeVariantSchema>,
  index: number,
): OverlayNode {
  if ((variant.image !== undefined) === (variant.spec !== undefined)) {
    throw new ActionableError(
      `Invalid showVariants variant ${index}: supply exactly one of image or spec.`,
    );
  }
  if (variant.spec !== undefined) {
    return variant.spec;
  }
  const image = assetImageSchema.safeParse(variant.image);
  if (!image.success) {
    throw new ActionableError(
      `Invalid showVariants variant ${index} image: use {asset: "opaque-id", contentScale?}. File paths, URLs and screenshot references are not accepted inside a variant; upload them with the call's assets ({id, path|observation}) and reference the id, or supply an existing opaque asset id. ${image.error.message}`,
    );
  }
  return { type: "image", ...image.data, style: { width: "fill", height: "fill" } };
}

// The control row sits at the window edge, which on a device is usually under a system bar: the
// status bar for a top-gravity floating window, the navigation bar for fullscreen (#10086). The
// row keeps its background behind the bars and pads its content into the safe area, so the
// controls stay reachable, readable over any app, and inside the window's own bounds.
const CONTROL_BACKGROUND = "#CC000000";
const CONTROL_TEXT_COLOR = "#FFFFFFFF";

function controlText(
  text: string,
  testTag: string,
  onTap?: NonNullable<OverlayNode["onTap"]>,
): OverlayNode {
  return {
    type: "text",
    text,
    testTag,
    style: { color: CONTROL_TEXT_COLOR, textSize: 20 },
    ...(onTap === undefined ? {} : { onTap }),
  };
}

function control(variant: Pick<OverlayVariant, "label">, index: number): OverlayNode {
  return {
    type: "row",
    testTag: `variant-${index}-control`,
    safeAreaPadding: {
      types: ["systemBars", "cutout"],
      edges: ["top", "bottom", "start", "end"],
    },
    style: {
      spacing: 12,
      width: "fill",
      arrangement: "center",
      background: CONTROL_BACKGROUND,
      padding: { top: 8, bottom: 8, start: 16, end: 16 },
    },
    children: [
      ...(variant.label === undefined
        ? []
        : [controlText(variant.label, `variant-${index}-label`)]),
      controlText("◀", `variant-${index}-prev`, [
        { type: "setPage", pager: VARIANT_PAGER_ID, page: "prev" },
      ]),
      controlText("{page}/{pageCount}", `variant-${index}-counter`),
      controlText("▶", `variant-${index}-next`, [
        { type: "setPage", pager: VARIANT_PAGER_ID, page: "next" },
      ]),
      controlText("✓", `variant-${index}-pick`, [
        {
          type: "emit",
          name: "selected",
          payload: { index, ...(variant.label === undefined ? {} : { label: variant.label }) },
        },
      ]),
    ],
  };
}

function variantWindow(value: z.infer<typeof inputSchema>) {
  const floating = value.presentation === "floating";
  return {
    placement: floating
      ? {
          type: "floating",
          gravity: value.gravity ?? "bottomCenter",
          offset: value.offset ?? { x: 0, y: 0 },
        }
      : { type: "fullscreen" },
    ...(value.opacity === undefined ? {} : { opacity: value.opacity }),
  };
}

/** Pure, deterministic composition using only the public overlay vocabulary. */
export function composeVariantCarousel(input: unknown): OverlaySpec {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ActionableError(
      `Invalid showVariants input (1-${MAX_VARIANTS} variants; labels at most ${MAX_VARIANT_LABEL_LENGTH} characters): ${parsed.error.message}`,
    );
  }
  const value = parsed.data;
  const floating = value.presentation === "floating";
  if (!floating && (value.gravity !== undefined || value.offset !== undefined)) {
    throw new ActionableError(
      "Invalid showVariants input: gravity and offset require presentation: floating.",
    );
  }
  const children = value.variants.map((variant, index): OverlayNode => {
    const content = variantContent(variant, index);
    const controls = control(variant, index);
    return {
      type: "box",
      testTag: `variant-${index}-page`,
      style: {
        width: floating ? "wrap" : "fill",
        height: floating ? "wrap" : "fill",
        alignment: "bottomCenter",
      },
      children: [
        {
          type: "box",
          testTag: `variant-${index}-content`,
          style: { width: "fill", height: "fill" },
          children: [content],
        },
        controls,
      ],
    };
  });
  const spec = {
    id: value.id,
    window: variantWindow(value),
    root: {
      type: "pager",
      id: VARIANT_PAGER_ID,
      testTag: "variant-carousel",
      style: { width: floating ? "wrap" : "fill", height: floating ? "wrap" : "fill" },
      children,
    },
  };
  validateCarouselSpec(spec);
  if (floating) {
    // Even unused floating content must be a bounded, valid fragment. Validate
    // in carousel context before omitting it from the actual device spec.
    for (const page of children) {
      if (page.type === "box") {
        page.children = page.children.slice(-1);
      }
    }
    validateCarouselSpec(spec);
  }
  // Keep authored defaults omitted; validator decoding must not inflate the
  // already checked wire byte budget or rewrite supplied spec fragments.
  return structuredClone(spec) as OverlaySpec;
}

function validateCarouselSpec(spec: unknown): void {
  const validated = validateOverlaySpec(spec);
  if (!validated.success) {
    const { path, message } = validated.error;
    // Interpret only the validator's deterministic path, never serialized input.
    const page = /^root\.children\[(\d+)\]/.exec(path)?.[1];
    throw new ActionableError(
      `Invalid showVariants${page === undefined ? " composed spec" : ` variant ${page}`} at ${path}: ${message}. Reduce or correct the variants to fit the overlay contract.`,
    );
  }
}

/** A picked variant: its zero-based position and the label it was shown with, when it had one. */
export const variantSelectionSchema = z
  .object({
    index: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_VARIANTS - 1),
    label: z.string().max(MAX_VARIANT_LABEL_LENGTH).optional(),
  })
  .strict();
export type VariantSelection = z.infer<typeof variantSelectionSchema>;

function variantPickPayload(page: OverlayNode | undefined): unknown {
  const controls = page?.type === "box" ? page.children.at(-1) : undefined;
  const pick = controls?.type === "row" ? controls.children.at(-1) : undefined;
  const action = pick?.onTap?.[0];
  return action?.type === "emit" ? action.payload : undefined;
}

/**
 * Validates a device `selected` payload against the carousel that was shown. The generated pick
 * action is the canonical index/label pair (not `event.pages`): fragments may emit other events,
 * so a forged or stale pair is rejected rather than reported as a pick.
 */
export function parseVariantSelection(
  spec: OverlaySpec,
  payload: unknown,
): { selection: VariantSelection } | { error: string } {
  const selection = variantSelectionSchema.safeParse(payload);
  const pages = spec.root.type === "pager" ? spec.root.children : [];
  if (!selection.success || selection.data.index >= pages.length) {
    return {
      error:
        "Invalid selected payload: expected {index: integer within the shown variants, label?: string}.",
    };
  }
  const expected = variantSelectionSchema.safeParse(
    variantPickPayload(pages[selection.data.index]),
  );
  if (
    !expected.success ||
    expected.data.index !== selection.data.index ||
    expected.data.label !== selection.data.label
  ) {
    return { error: "Invalid selected payload: index and label must match a shown variant." };
  }
  return { selection: selection.data };
}
