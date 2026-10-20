import { expect, test } from "bun:test";
import {
  prototypeCarouselFields,
  prototypeCarouselUnsupportedMessage,
} from "../../../src/features/prototype/prototypeCarousel";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const card = { type: "card", children: [{ type: "text", text: "x" }] };
const wrap = (root: object) => ({ id: "c", window: { placement: { type: "fullscreen" } }, root });

test("discovery lists carousel nodes and pager indicators in document order, not payloads", () => {
  const spec = {
    root: {
      type: "column",
      children: [
        { type: "pager", id: "p", indicator: "dots", children: [card] },
        { type: "pager", id: "q", children: [card] },
        { type: "carousel", itemWidth: 100, children: [card] },
      ],
      onTap: [{ type: "emit", name: "x", payload: { type: "carousel" } }],
    },
    components: { c: { root: { type: "carousel", itemWidth: 90, children: [card] } } },
  };
  expect(prototypeCarouselFields(spec)).toEqual([
    "root.children[0].indicator",
    "root.children[2]",
    "components.c.root",
  ]);
  expect(prototypeCarouselFields(null)).toEqual([]);
});

test("carousel validates its items, width and variant and counts nodes like a container", () => {
  expect(
    validatePrototypeSpec(
      wrap({ type: "carousel", variant: "hero", itemWidth: 280, itemSpacing: 8, children: [card] }),
    ).success,
  ).toBe(true);
  for (const [root, path] of [
    [{ type: "carousel", itemWidth: 10, children: [] }, "root.children"],
    [{ type: "carousel", children: [card] }, "root.itemWidth"],
    [{ type: "carousel", itemWidth: 0, children: [card] }, "root.itemWidth"],
    [{ type: "carousel", itemWidth: 10, variant: "x", children: [card] }, "root.variant"],
  ] as const) {
    const result = validatePrototypeSpec(wrap(root));
    expect(result.success ? "" : result.error.path).toBe(path);
  }
});

test("a carousel repeat binds placeholders in its template like row and column", () => {
  const spec = wrap({
    type: "carousel",
    itemWidth: 100,
    repeat: { as: "item", items: [{ id: "a" }, { id: "b" }] },
    children: [{ type: "text", text: "{item.id}" }],
  });
  expect(validatePrototypeSpec(spec).success).toBe(true);
  const missing = validatePrototypeSpec({
    ...spec,
    root: { ...spec.root, children: [{ type: "text", text: "{item.nope}" }] },
  });
  expect(missing.success).toBe(false);
});

test("the refusal names the capability, the feature and the platform's update step", () => {
  const android = prototypeCarouselUnsupportedMessage(["root"], "android");
  expect(android).toContain("prototype_carousel_v1");
  expect(android).toContain("carousel node at root");
  const ios = prototypeCarouselUnsupportedMessage(["root.indicator", "root.b.indicator"], "ios");
  expect(ios).toContain("pager indicator at root.indicator (and 1 more)");
  expect(ios).toContain("launchApp prototype: true");
});
