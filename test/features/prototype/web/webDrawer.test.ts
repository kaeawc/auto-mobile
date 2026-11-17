import { describe, expect, test } from "bun:test";
import type { WebChild, WebElement } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

type Spec = Record<string, unknown>;

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
const byPart = (element: WebElement, part: string) =>
  find(element, (candidate) => candidate.attrs["data-part"] === part);
const windowOf = (element: WebElement) =>
  find(element, (candidate) => candidate.attrs["data-window"] !== undefined)[0]!;

const drawer = (extra: Spec = {}): Spec => ({
  type: "drawer",
  testTag: "nav",
  openWhen: { key: "menu", equals: true },
  child: { type: "text", text: "Inbox for {user}" },
  ...extra,
});
const specWith = (nodes: Spec[], state: Spec = { menu: true }, window?: Spec): Spec => ({
  id: "s",
  state: { user: "Ada", ...state },
  ...(window ? { window } : {}),
  root: { type: "column", children: [{ type: "text", text: "Body" }, ...nodes] },
});

// surface (254,247,255) under primary (103,80,164) at (4.5 ln 4 + 2) / 100.
const TONAL_SURFACE_3_LIGHT = "rgba(242,233,248,1)";
const SHEET_SCRIM = "rgba(0,0,0,0.4)";

describe("web still drawer (#16536)", () => {
  test("a closed drawer draws nothing and is not a placeholder", () => {
    const still = renderPrototypeStill(specWith([drawer()], { menu: false }));
    expect(still.unsupportedNodes.map((node) => node.type)).not.toContain("drawer");
    expect(byPart(still.element, "drawerLayer")).toEqual([]);
  });

  test("an open drawer is a window layer: scrim, then an end-edge surface", () => {
    const still = renderPrototypeStill(specWith([drawer()]));
    expect(still.unsupportedNodes).toEqual([]);
    const layer = windowOf(still.element).children.at(-1) as WebElement;
    expect(layer.attrs["data-part"]).toBe("drawerLayer");
    expect(layer.style).toMatchObject({ position: "absolute", inset: "0" });
    expect(layer.style.padding).toContain("var(--safe-top, 0px)");
    const [frame] = layer.children as WebElement[];
    expect(frame!.style["justify-content"]).toBe("flex-end");
    const [scrim, surface] = frame!.children as WebElement[];
    expect(scrim!.attrs["data-testid"]).toBe("nav.close");
    expect(scrim!.style["background-color"]).toBe(SHEET_SCRIM);
    expect(surface!.attrs["data-part"]).toBe("drawer");
    expect(surface!.style).toMatchObject({
      width: "max(0px, min(320px, calc(100% - 56px)))",
      height: "100%",
      "background-color": TONAL_SURFACE_3_LIGHT,
    });
    expect(textOf(surface!)).toBe("Inbox for Ada");
  });

  test("a start-edge drawer sits at the start; a hex scrim keeps its colour", () => {
    const still = renderPrototypeStill(specWith([drawer({ edge: "start", scrim: "#33000000" })]));
    const [frame] = byPart(still.element, "drawerFrame");
    expect(frame!.style["justify-content"]).toBe("flex-start");
    const [scrim] = byPart(frame!, "scrim");
    expect(scrim!.style["background-color"]).not.toBe(SHEET_SCRIM);
  });

  test("an authored background wins on the surface", () => {
    const still = renderPrototypeStill(specWith([drawer({ style: { background: "#ff0000" } })]));
    const [surface] = byPart(still.element, "drawer");
    expect(surface!.style["background-color"]).toBe("rgba(255,0,0,1)");
  });
});

describe("web still fullscreen scrim (#16536)", () => {
  test("a fullscreen placement scrim paints behind the window's content", () => {
    const still = renderPrototypeStill(
      specWith([], {}, { placement: { type: "fullscreen", scrim: "scrim" } }),
    );
    expect(windowOf(still.element).style["background-color"]).toBe(SHEET_SCRIM);
  });

  test("a fullscreen window without a scrim stays transparent", () => {
    const still = renderPrototypeStill(specWith([], {}, { placement: { type: "fullscreen" } }));
    expect(windowOf(still.element).style["background-color"]).toBeUndefined();
  });
});
