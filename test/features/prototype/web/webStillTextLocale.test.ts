import { describe, expect, test } from "bun:test";
import {
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { PrototypeWebInputError } from "../../../../src/features/prototype/web/prototypeWebInputError";

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}
const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byTag = (element: WebElement, tag: string): WebElement =>
  find(element, (candidate) => candidate.attrs["data-testid"] === tag)[0]!;
const screenOf = (element: WebElement): WebElement =>
  find(element, (candidate) => candidate.attrs["data-chrome"] === "screen")[0]!;
const windowOf = (element: WebElement): WebElement =>
  find(element, (candidate) => candidate.attrs["data-window"] !== undefined)[0]!;

const spec = (window: Record<string, unknown> = {}) => ({
  id: "text-locale",
  window: { placement: { type: "fullscreen" }, ...window },
  root: {
    type: "column",
    children: [
      { type: "text", testTag: "body", text: "{t:greeting}", style: { textStyle: "bodyLarge" } },
      { type: "text", testTag: "sized", text: "Sized", style: { textSize: 14, letterSpacing: 1 } },
    ],
  },
  strings: { default: { greeting: "Hello" }, ar: { greeting: "مرحبا" } },
});

describe("still font scale and Dynamic Type (#16552)", () => {
  test("an Android frame scales type-scale roles and explicit sizes through the 200 % table", () => {
    const still = renderPrototypeStill(spec(), { frame: "pixel-9", textSize: { fontScale: 2 } });
    // bodyLarge is 16 sp on a 24 sp line.
    expect(byTag(still.element, "body").style["font-size"]).toBe("28px");
    expect(byTag(still.element, "body").style["line-height"]).toBe("36px");
    expect(byTag(still.element, "sized").style["font-size"]).toBe("26px");
    expect(byTag(still.element, "sized").style["letter-spacing"]).toBe("2px");
    // The unstyled 14 sp default scales too.
    expect(screenOf(still.element).style["font-size"]).toBe("26px");
  });

  test("a multiline field's line bounds are whole scaled lines", () => {
    const field = {
      ...spec(),
      root: { type: "textField", testTag: "notes", multiline: true, minLines: 2, maxLines: 2 },
    };
    const still = renderPrototypeStill(field, { frame: "pixel-9", textSize: { fontScale: 2 } });
    const lines = find(byTag(still.element, "notes"), (el) => el.style["max-height"] !== undefined);
    // 24 sp is 36 dp at 200 %, so two lines are 72 dp, not the converted 48 sp.
    expect(lines[0]!.style["line-height"]).toBe("36px");
    expect(lines[0]!.style["min-height"]).toBe("72px");
    expect(lines[0]!.style["max-height"]).toBe("72px");
  });

  test("an iOS frame scales every size by the content size and keeps tracking", () => {
    const still = renderPrototypeStill(spec(), {
      frame: "iphone-16",
      textSize: { contentSize: "accessibility-extra-extra-extra-large" },
    });
    expect(byTag(still.element, "body").style["font-size"]).toBe("49.882px");
    expect(byTag(still.element, "sized").style["letter-spacing"]).toBe("1px");
  });

  test("the default size renders the same bytes as no option", () => {
    const plain = toHtml(renderPrototypeStill(spec(), { frame: "pixel-9" }).element);
    const unit = renderPrototypeStill(spec(), { frame: "pixel-9", textSize: { fontScale: 1 } });
    expect(toHtml(unit.element)).toBe(plain);
  });

  test("refuses the other platform's text size option", () => {
    expect(() =>
      renderPrototypeStill(spec(), { frame: "iphone-16", textSize: { fontScale: 2 } }),
    ).toThrow(PrototypeWebInputError);
  });
});

describe("still locale and layout direction (#16552)", () => {
  test("an RTL locale picks its string table and mirrors a window with no direction", () => {
    const still = renderPrototypeStill(spec(), { frame: "pixel-9", locale: "ar" });
    expect(textOf(byTag(still.element, "body"))).toBe("مرحبا");
    expect(windowOf(still.element).attrs.dir).toBe("rtl");
    expect(windowOf(still.element).style["--safe-start"]).toBe("var(--safe-right)");
    // The device chrome is never mirrored.
    expect(screenOf(still.element).attrs.dir).toBeUndefined();
  });

  test("an explicit layoutDirection wins over the locale", () => {
    const still = renderPrototypeStill(spec({ layoutDirection: "ltr" }), {
      frame: "iphone-16",
      locale: "he-IL",
    });
    expect(windowOf(still.element).attrs.dir).toBe("ltr");
  });

  test("the default locale keeps the default table and sets no direction", () => {
    const still = renderPrototypeStill(spec(), { frame: "pixel-9" });
    expect(textOf(byTag(still.element, "body"))).toBe("Hello");
    expect(windowOf(still.element).attrs.dir).toBeUndefined();
  });

  test("refuses an invalid locale tag", () => {
    expect(() => renderPrototypeStill(spec(), { locale: "not a locale" })).toThrow(
      PrototypeWebInputError,
    );
  });
});
