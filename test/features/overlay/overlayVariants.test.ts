import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  composeVariantCarousel,
  parseVariantSelection,
  MAX_VARIANTS,
  MAX_VARIANT_LABEL_LENGTH,
  VARIANT_PAGER_ID,
  type OverlayVariant,
} from "../../../src/features/overlay/overlayVariants";
import {
  overlaySpecSchema,
  MAX_OVERLAY_SPEC_BYTES,
  type OverlayNode,
} from "../../../src/features/overlay/overlaySpec";
import { validateOverlaySpec } from "../../../src/features/overlay/overlayValidation";
import contract from "../../../schemas/overlay-spec-contract.json";

const image: OverlayVariant = { image: { asset: "existing-asset" } };
function pages(input: unknown) {
  const spec = composeVariantCarousel(input);
  expect(validateOverlaySpec(spec).success).toBe(true);
  expect(overlaySpecSchema.safeParse(spec).success).toBe(true);
  if (spec.root.type !== "pager") {
    throw new Error("Expected pager");
  }
  return spec.root.children;
}
function children(node: OverlayNode): OverlayNode[] {
  if (!("children" in node)) {
    throw new Error("Expected container");
  }
  return node.children;
}
function deepFreeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
}
function rejects(input: unknown, message: string): void {
  expect(() => composeVariantCarousel(input)).toThrow(ActionableError);
  expect(() => composeVariantCarousel(input)).toThrow(message);
}

describe("variant carousel composition", () => {
  test.each([1, 2, 9])("%i variants use public schema and static selection payloads", (count) => {
    const variants = Array.from({ length: count }, (_, index) => ({
      ...image,
      ...(index % 2 === 0 ? { label: `Variant ${index}` } : {}),
    }));
    const all = pages({ id: "panel", variants });
    expect(all).toHaveLength(count);
    all.forEach((page, index) => {
      expect(page.testTag).toBe(`variant-${index}-page`);
      const row = children(page).at(-1)!;
      const controls = children(row);
      expect(controls.find((node) => node.testTag === `variant-${index}-prev`)?.onTap).toEqual([
        { type: "setPage", pager: VARIANT_PAGER_ID, page: "prev" },
      ]);
      expect(controls.find((node) => node.testTag === `variant-${index}-next`)?.onTap).toEqual([
        { type: "setPage", pager: VARIANT_PAGER_ID, page: "next" },
      ]);
      expect(controls.find((node) => node.testTag === `variant-${index}-counter`)).toMatchObject({
        type: "text",
        text: "{page}/{pageCount}",
      });
      expect(controls.at(-1)?.onTap).toEqual([
        {
          type: "emit",
          name: "selected",
          payload: {
            index,
            ...(variants[index].label === undefined ? {} : { label: variants[index].label }),
          },
        },
      ]);
      if (variants[index].label !== undefined) {
        expect(controls[0]).toMatchObject({ type: "text", text: variants[index].label });
      }
      expect(children(children(page)[0])[0]).toMatchObject({
        type: "image",
        asset: "existing-asset",
        style: { width: "fill", height: "fill" },
      });
    });
  });
  test("fragments and scaled asset images work without changing input", () => {
    const input = {
      id: "panel",
      variants: [
        { spec: { type: "text" as const, text: "Hello" } },
        { image: { asset: "shared", contentScale: "crop" as const }, label: "B" },
      ],
    };
    const before = structuredClone(input);
    deepFreeze(input);
    const first = composeVariantCarousel(input);
    expect(first).toEqual(composeVariantCarousel(input));
    expect(input).toEqual(before);
    const all = pages(input);
    expect(children(children(all[0])[0])[0]).toEqual(input.variants[0].spec!);
    expect(children(children(all[1])[0])[0]).toMatchObject({ contentScale: "crop" });
    // Returned fragments must also be independent of the caller's objects.
    const content = children(children(all[0])[0])[0];
    if (content.type === "text") {
      content.text = "Changed";
    }
    expect(input).toEqual(before);
  });
  test("floating contains only controls and defaults its placement", () => {
    const input = {
      id: "panel",
      variants: [{ ...image, label: "Live" }],
      presentation: "floating",
    };
    const result = composeVariantCarousel(input);
    expect(result.window).toEqual({
      placement: { type: "floating", gravity: "bottomCenter", offset: { x: 0, y: 0 } },
    });
    for (const page of pages(input)) {
      expect(children(page)).toHaveLength(1);
      expect(children(page)[0].type).toBe("row");
    }
    expect(JSON.stringify(result)).not.toContain('"type":"image"');
    expect(
      composeVariantCarousel({ ...input, gravity: "topStart", offset: { x: 3, y: -4 } }).window
        .placement,
    ).toEqual({ type: "floating", gravity: "topStart", offset: { x: 3, y: -4 } });
  });
  test("opacity passes through and stays omitted when absent", () => {
    const input = { id: "panel", variants: [image] };
    expect(composeVariantCarousel(input).window).not.toHaveProperty("opacity");
    for (const opacity of [0, 45, 100]) {
      expect(composeVariantCarousel({ ...input, opacity }).window.opacity).toBe(opacity);
    }
    for (const opacity of [-1, 101, 1.5]) {
      rejects({ ...input, opacity }, "Invalid showVariants input");
    }
  });
  test("variant count and labels are bounded", () => {
    rejects({ id: "panel", variants: [] }, `1-${MAX_VARIANTS} variants`);
    rejects(
      { id: "panel", variants: Array.from({ length: MAX_VARIANTS + 1 }, () => image) },
      `1-${MAX_VARIANTS} variants`,
    );
    rejects(
      { id: "panel", variants: [{ ...image, label: "x".repeat(MAX_VARIANT_LABEL_LENGTH + 1) }] },
      "labels at most",
    );
    expect(
      pages({
        id: "panel",
        variants: Array.from({ length: MAX_VARIANTS }, () => ({
          ...image,
          label: "x".repeat(MAX_VARIANT_LABEL_LENGTH),
        })),
      }),
    ).toHaveLength(MAX_VARIANTS);
  });
  test.each([{}, { ...image, spec: { type: "spacer" } }])(
    "requires exactly one content field %j",
    (variant) => {
      rejects(
        { id: "panel", variants: [image, variant] },
        "variant 1: supply exactly one of image or spec",
      );
    },
  );
  test.each([
    "/tmp/mockup.png",
    { path: "/tmp/mockup.png" },
    { filePath: "/tmp/mockup.png" },
    { screenshot: "last" },
    { url: "https://example.test/a.png" },
    { asset: "ok", screenshot: "last" },
  ])("rejects transport-dependent image inputs %j", (value) => {
    rejects({ id: "panel", variants: [{ image: value }] }, "missing asset transport (#9301)");
  });
  test("invalid fragments identify the offending variant", () => {
    rejects(
      {
        id: "panel",
        variants: [image, { spec: { type: "image", asset: "ok", unexpected: true } }],
      },
      "variant 1",
    );
    rejects(
      {
        id: "panel",
        variants: [
          {
            spec: {
              type: "text",
              text: "pick",
              onTap: [{ type: "setPage", pager: "missing", page: "next" }],
            },
          },
        ],
      },
      "Unknown pager id",
    );
    rejects(
      {
        id: "panel",
        variants: [
          { spec: { type: "pager", id: VARIANT_PAGER_ID, children: [{ type: "spacer" }] } },
        ],
      },
      "Duplicate pager id",
    );
  });
  test("floating still rejects invalid fragment content before omitting it", () => {
    rejects(
      { id: "panel", presentation: "floating", variants: [{ spec: "/tmp/mockup.png" }] },
      "variant 0",
    );
    rejects(
      {
        id: "panel",
        presentation: "floating",
        variants: [{ spec: { type: "image", asset: "ok", path: "bad" } }],
      },
      "variant 0",
    );
  });
  test("preserves authored fragment defaults without inflating the wire byte budget", () => {
    const fragment = { type: "scroll" as const, child: { type: "text" as const, text: "x" } };
    const input = { id: "panel", variants: [{ spec: fragment }] };
    const result = pages(input);
    expect(children(children(result[0])[0])[0]).toEqual(fragment);
    const base = composeVariantCarousel(input);
    const remaining = MAX_OVERLAY_SPEC_BYTES - Buffer.byteLength(JSON.stringify(base));
    expect(
      Buffer.byteLength(
        JSON.stringify(
          composeVariantCarousel({
            id: "panel",
            variants: [
              { spec: { ...fragment, child: { type: "text", text: "x".repeat(remaining + 1) } } },
            ],
          }),
        ),
      ),
    ).toBe(MAX_OVERLAY_SPEC_BYTES);
  });
  test("composed node and image budgets reuse contract limits", () => {
    rejects(
      {
        id: "panel",
        variants: [
          {
            spec: {
              type: "box",
              children: Array.from({ length: contract.limits.MAX_OVERLAY_NODES }, () => ({
                type: "spacer",
              })),
            },
          },
        ],
      },
      "Node limit exceeded",
    );
    rejects(
      {
        id: "panel",
        variants: [
          {
            spec: {
              type: "box",
              children: Array.from({ length: contract.limits.MAX_OVERLAY_IMAGES + 1 }, () => ({
                type: "image",
                asset: "same",
              })),
            },
          },
        ],
      },
      "Image limit exceeded",
    );
  });
  test("composed byte budget is bounded by the existing spec validator", () => {
    rejects(
      {
        id: "panel",
        variants: [{ spec: { type: "text", text: "x".repeat(MAX_OVERLAY_SPEC_BYTES) } }],
      },
      "Spec byte limit exceeded",
    );
  });
  test("parseVariantSelection accepts only the generated index/label pair", () => {
    const spec = composeVariantCarousel({
      id: "panel",
      variants: [image, { ...image, label: "B" }],
    });
    expect(parseVariantSelection(spec, { index: 0 })).toEqual({ selection: { index: 0 } });
    expect(parseVariantSelection(spec, { index: 1, label: "B" })).toEqual({
      selection: { index: 1, label: "B" },
    });
    for (const forged of [
      { index: 1 },
      { index: 0, label: "B" },
      { index: 2 },
      { index: 1, label: "B", extra: true },
      null,
    ]) {
      expect(parseVariantSelection(spec, forged)).toHaveProperty("error");
    }
  });
  test("rejects fullscreen placement knobs and unknown variant fields", () => {
    rejects(
      { id: "panel", variants: [image], gravity: "bottomCenter" },
      "gravity and offset require",
    );
    rejects({ id: "panel", variants: [{ ...image, path: "a" }] }, "Invalid showVariants input");
  });
});
