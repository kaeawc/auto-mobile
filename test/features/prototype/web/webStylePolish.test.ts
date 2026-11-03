import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prototypeRolePalette } from "../../../../src/features/prototype/prototypeContrast";
import {
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { nodeCss } from "../../../../src/features/prototype/web/webStyle";
import {
  fadeEdgesCss,
  gradientCss,
  overContentLayers,
} from "../../../../src/features/prototype/web/webStylePolish";

const context = { mode: "light" as const, palette: prototypeRolePalette({}, "light") };

const reference = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}

const stillOf = (root: unknown, extra: Record<string, unknown> = {}, frame = "pixel-9") =>
  renderPrototypeStill({ ...reference, ...extra, root }, { frame });
const tagged = (still: { element: WebElement }, tag: string) =>
  find(still.element, (element) => element.attrs["data-testid"] === tag)[0]!;

describe("gradients (#16540)", () => {
  test("a linear angle runs clockwise from left-to-right, so CSS gets it plus 90", () => {
    expect(
      gradientCss(
        {
          type: "linear",
          angle: 0,
          stops: [{ color: "#FF0000" }, { color: "#0000FF" }],
        },
        context,
      ),
    ).toBe("linear-gradient(90deg,rgba(255,0,0,1),rgba(0,0,255,1))");
    expect(
      gradientCss(
        { type: "linear", angle: 90, stops: [{ color: "#000" }, { color: "#fff" }] },
        context,
      ),
    ).toStartWith("linear-gradient(180deg,");
  });

  test("positions apply only when every stop has one, and never decrease", () => {
    const stops = [
      { color: "primary", position: 0.5 },
      { color: "#00FF00", position: 0.2 },
    ];
    expect(gradientCss({ type: "radial", stops }, context)).toBe(
      "radial-gradient(circle farthest-corner at 50% 50%,rgba(103,80,164,1) 50%,rgba(0,255,0,1) 50%)",
    );
    expect(gradientCss({ type: "radial", stops: [stops[0], { color: "#00FF00" }] }, context)).toBe(
      "radial-gradient(circle farthest-corner at 50% 50%,rgba(103,80,164,1),rgba(0,255,0,1))",
    );
  });

  test("the node's gradient paints over its background across the whole node", () => {
    expect(
      nodeCss(
        {
          background: "#FFFFFF",
          gradient: { type: "radial", stops: [{ color: "#000" }, { color: "#fff" }] },
        },
        context,
      ),
    ).toMatchObject({
      "background-color": "rgba(255,255,255,1)",
      "background-origin": "border-box",
      "background-image": expect.stringMatching(/^radial-gradient\(/),
    });
  });
});

describe("shadows and elevation (#16540)", () => {
  test("layered drop shadows list top-most first, with blur as the CSS blur radius", () => {
    expect(
      nodeCss(
        {
          shadows: [
            { color: "#000000", radius: 8, offset: { x: 1, y: 2 } },
            { color: "#FF0000", radius: 4, spread: 2 },
            { color: "#00FF00", radius: 3, inner: true },
          ],
        },
        context,
      )["box-shadow"],
    ).toBe("0px 0px 4px 2px rgba(255,0,0,1),1px 2px 8px 0px rgba(0,0,0,1)");
  });

  test("elevation takes shadowColor's tint", () => {
    expect(nodeCss({ elevation: 4, shadowColor: "#FF0000" }, context)["box-shadow"]).toBe(
      "0 2px 4px rgba(255,0,0,0.25)",
    );
    expect(nodeCss({ elevation: 4 }, context)["box-shadow"]).toBe("0 2px 4px rgba(0,0,0,0.25)");
  });

  test("inner shadows and a gradient border paint over the content, border first", () => {
    const style = {
      border: {
        width: 2,
        gradient: { type: "linear", angle: 0, stops: [{ color: "#000" }, { color: "#fff" }] },
      },
      shadows: [{ color: "#000000", radius: 6, inner: true }],
    };
    expect(nodeCss(style, context)).not.toHaveProperty("border");
    const layers = overContentLayers(style, context);
    expect(layers.map((layer) => layer.attrs["data-layer"])).toEqual(["border", "innerShadow"]);
    expect(layers[0]!.style).toMatchObject({ padding: "2px", "mask-composite": "exclude" });
    expect(layers[1]!.style["box-shadow"]).toBe("inset 0px 0px 6px 0px rgba(0,0,0,1)");
  });

  test("a still appends the layers after the node's children and positions the node", () => {
    const card = tagged(
      stillOf({
        type: "box",
        testTag: "card",
        style: { shadows: [{ color: "#000000", radius: 6, inner: true }] },
        children: [{ type: "text", text: "Hi" }],
      }),
      "card",
    );
    expect(card.style.position).toBe("relative");
    expect((card.children.at(-1) as WebElement).attrs["data-layer"]).toBe("innerShadow");
  });
});

test("an open bottom sheet carries the layers too (#16540)", () => {
  const still = stillOf(
    {
      type: "column",
      children: [
        {
          type: "bottomSheet",
          openWhen: { key: "open", equals: true },
          style: { shadows: [{ color: "#000000", radius: 4, inner: true }] },
          child: { type: "text", text: "sheet" },
        },
      ],
    },
    { state: { open: true } },
  );
  const [sheet] = find(still.element, (element) => element.attrs["data-part"] === "sheet");
  expect((sheet!.children.at(-1) as WebElement).attrs["data-layer"]).toBe("innerShadow");
});

test("a captioned text field layers its box, not the caption (#16540)", () => {
  const still = stillOf({
    type: "textField",
    testTag: "name",
    supportingText: "Required",
    style: { shadows: [{ color: "#000000", radius: 4, inner: true }] },
  });
  const box = tagged(still, "name");
  expect((box.children.at(-1) as WebElement).attrs["data-layer"]).toBe("innerShadow");
  expect(find(still.element, (element) => element.attrs["data-layer"] !== undefined)).toHaveLength(
    1,
  );
});

test("only an open bottom sheet is listed as a shader fallback (#16540)", () => {
  const sheet = (open: boolean) =>
    stillOf(
      {
        type: "column",
        children: [
          {
            type: "bottomSheet",
            id: "sheet",
            openWhen: { key: "open", equals: true },
            style: { shader: { asset: "ripple" } },
            child: { type: "text", text: "sheet" },
          },
        ],
      },
      { state: { open } },
    ).unsupportedNodes;
  expect(sheet(false)).toEqual([]);
  expect(sheet(true)).toEqual([
    { type: "bottomSheet", id: "sheet", path: "root.children[0]", reason: "shaderFallback" },
  ]);
});

describe("glass (#16540)", () => {
  const glassy = { surface: "glass", glass: { tint: "#0000FF" } };

  test("an Android frame draws the tonal fallback, a capsule without a corner radius", () => {
    expect(nodeCss(glassy, { ...context, platform: "android" })).toMatchObject({
      "background-color": "rgba(0,0,255,0.85)",
      "border-radius": "9999px",
    });
    expect(nodeCss({ surface: "glass" }, context)["background-color"]).toMatch(/0\.85\)$/);
  });

  test("an iOS frame blurs the backdrop under a translucent tint", () => {
    const css = nodeCss({ ...glassy, cornerRadius: 12 }, { ...context, platform: "ios" });
    expect(css).toMatchObject({
      "background-color": "rgba(0,0,255,0.32)",
      "backdrop-filter": "blur(16px) saturate(1.8)",
      "border-radius": "12px",
    });
  });

  test("an authored background keeps its colour", () => {
    expect(
      nodeCss({ ...glassy, background: "#FF0000" }, { ...context, platform: "ios" })[
        "background-color"
      ],
    ).toBe("rgba(255,0,0,1)");
  });
});

describe("fade edges (#16540)", () => {
  test("a still opens at the start, so only the trailing edge fades", () => {
    expect(fadeEdgesCss({ fadeEdges: { top: 8, bottom: 24 } }, context)).toEqual({
      "mask-image": "linear-gradient(to top,rgba(0,0,0,0) 0,#000 min(24px,100%))",
    });
    expect(fadeEdgesCss({ fadeEdges: { top: 8 } }, context)).toEqual({});
    expect(fadeEdgesCss({ reverse: true, fadeEdges: { top: 8 } }, context)).toEqual({
      "mask-image": "linear-gradient(to bottom,rgba(0,0,0,0) 0,#000 min(8px,100%))",
    });
  });

  test("horizontal end fades the physical right, mirrored in RTL", () => {
    const node = { axis: "horizontal", fadeEdges: { end: 16 } };
    expect(fadeEdgesCss(node, context)["mask-image"]).toStartWith("linear-gradient(to left,");
    expect(fadeEdgesCss(node, { ...context, rtl: true })["mask-image"]).toStartWith(
      "linear-gradient(to right,",
    );
  });

  test("a still's scroll carries the mask", () => {
    const still = stillOf({
      type: "scroll",
      testTag: "list",
      fadeEdges: { bottom: 12 },
      child: { type: "text", text: "rows" },
    });
    expect(tagged(still, "list").style["mask-image"]).toContain("#000 min(12px,100%)");
  });
});

describe("links (#16540)", () => {
  test("linkify splits the resolved text into styled link runs", () => {
    const still = stillOf(
      {
        type: "text",
        testTag: "post",
        text: "hi @{handle} see #news",
        linkify: {
          kinds: ["mention", "hashtag"],
          style: { color: "#FF0000" },
          onTap: [{ type: "setState", key: "tapped", value: { match: "text" } }],
        },
      },
      { state: { handle: "ana" } },
    );
    const post = tagged(still, "post");
    const links = find(post, (element) => element.attrs["data-link"] === "true");
    expect(links.map((link) => link.children[0])).toEqual(["@ana", "#news"]);
    expect(links[0]!.style.color).toBe("rgba(255,0,0,1)");
    expect(post.children[0]).toBe("hi ");
  });

  test("text without a match stays plain, and a tappable span is marked as a link", () => {
    const still = stillOf({
      type: "column",
      children: [
        { type: "text", testTag: "plain", text: "nothing", linkify: { kinds: ["url"], onTap: [] } },
        {
          type: "text",
          testTag: "spans",
          spans: [{ text: "a" }, { text: "b", onTap: [{ type: "setState", key: "k", value: 1 }] }],
        },
      ],
    });
    expect(tagged(still, "plain").children).toEqual(["nothing"]);
    const links = tagged(still, "spans").children.map((span) =>
      typeof span === "string" ? "text" : (span.attrs["data-link"] ?? "plain"),
    );
    expect(links).toEqual(["plain", "true"]);
  });
});

describe("shader fallback (#16540)", () => {
  test("a shaded node draws without the shader and is listed with reason shaderFallback", () => {
    const still = stillOf({
      type: "column",
      children: [
        {
          type: "box",
          id: "hero",
          testTag: "hero",
          style: { background: "#FF0000", shader: { asset: "ripple" } },
          children: [],
        },
      ],
    });
    expect(still.unsupportedNodes).toEqual([
      { type: "box", id: "hero", path: "root.children[0]", reason: "shaderFallback" },
    ]);
    expect(toHtml(tagged(still, "hero"))).toContain("background-color:rgba(255,0,0,1)");
  });
});
