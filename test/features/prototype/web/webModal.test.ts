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

const dialog = (extra: Spec = {}): Spec => ({
  type: "dialog",
  testTag: "confirmDelete",
  openWhen: { key: "open", equals: true },
  title: "Delete {item}?",
  text: "This cannot be undone.",
  confirm: { label: "Delete" },
  dismiss: { label: "Cancel" },
  ...extra,
});
const snackbar = (extra: Spec = {}): Spec => ({
  type: "snackbar",
  testTag: "saved",
  openWhen: { key: "toast", equals: true },
  text: "Saved {item}",
  ...extra,
});
const specWith = (nodes: Spec[], state: Spec = { open: true, toast: true }): Spec => ({
  id: "s",
  state: { item: "Notes", ...state },
  root: { type: "column", children: [{ type: "text", text: "Body" }, ...nodes] },
});

// Material 3 baseline roles, as rgba() strings.
const SURFACE_CONTAINER_HIGH_LIGHT = "rgba(236,230,240,1)";
const SURFACE_CONTAINER_HIGH_DARK = "rgba(43,41,48,1)";
const ON_SURFACE_LIGHT = "rgba(29,27,32,1)";
const ON_SURFACE_VARIANT_LIGHT = "rgba(73,69,79,1)";
const PRIMARY_LIGHT = "rgba(103,80,164,1)";
const SECONDARY_LIGHT = "rgba(98,91,113,1)";
const INVERSE_SURFACE_LIGHT = "rgba(50,47,53,1)";
const INVERSE_ON_SURFACE_LIGHT = "rgba(245,239,247,1)";
const INVERSE_PRIMARY_LIGHT = "rgba(208,188,255,1)";
const DIALOG_SCRIM = "rgba(0,0,0,0.32)";

describe("web still dialog (#16536)", () => {
  test("a closed dialog draws nothing and is not a placeholder", () => {
    const still = renderPrototypeStill(specWith([dialog()], { open: false }));
    expect(still.unsupportedNodes.map((node) => node.type)).not.toContain("dialog");
    expect(byPart(still.element, "dialogLayer")).toEqual([]);
    expect(byPart(still.element, "scrim")).toEqual([]);
  });

  test("an open dialog is a centred window layer over a 0.32 scrim", () => {
    const still = renderPrototypeStill(specWith([dialog()], { open: true }));
    expect(still.unsupportedNodes).toEqual([]);
    const window = windowOf(still.element);
    const layer = window.children.at(-1) as WebElement;
    expect(layer.attrs["data-part"]).toBe("dialogLayer");
    expect(layer.style).toMatchObject({
      position: "absolute",
      inset: "0",
      display: "flex",
      "justify-content": "center",
      "align-items": "center",
    });
    const [scrim, surface] = layer.children as WebElement[];
    expect(scrim!.style["background-color"]).toBe(DIALOG_SCRIM);
    expect(surface!.attrs).toMatchObject({
      "data-node": "dialog",
      "data-part": "dialog",
      "data-testid": "confirmDelete",
    });
    expect(surface!.style).toMatchObject({
      "border-radius": "28px",
      padding: "24px",
      margin: "24px",
      gap: "16px",
      "min-width": "min(280px, calc(100% - 48px))",
      "max-width": "min(560px, calc(100% - 48px))",
      "background-color": SURFACE_CONTAINER_HIGH_LIGHT,
    });
    // The tree below stays in place.
    expect(textOf(window.children[0]!)).toBe("Body");
  });

  test("draws the bound title, body text, then dismiss before confirm in primary", () => {
    const still = renderPrototypeStill(specWith([dialog()], { open: true }));
    const [title] = byPart(still.element, "headlineSmall");
    const [body] = byPart(still.element, "bodyMedium");
    expect(textOf(title!)).toBe("Delete Notes?");
    expect(title!.style).toMatchObject({ "font-size": "24px", color: ON_SURFACE_LIGHT });
    expect(textOf(body!)).toBe("This cannot be undone.");
    expect(body!.style.color).toBe(ON_SURFACE_VARIANT_LIGHT);
    const [buttons] = byPart(still.element, "buttons");
    expect(buttons!.style).toMatchObject({ display: "flex", "justify-content": "flex-end" });
    const [dismiss, confirm] = buttons!.children as WebElement[];
    expect(dismiss!.attrs).toMatchObject({
      "data-part": "dismiss",
      "data-testid": "confirmDelete.dismiss",
    });
    expect(confirm!.attrs).toMatchObject({
      "data-part": "confirm",
      "data-testid": "confirmDelete.confirm",
    });
    expect(textOf(dismiss!)).toBe("Cancel");
    expect(textOf(confirm!)).toBe("Delete");
    expect(confirm!.style).toMatchObject({ "min-height": "40px", color: PRIMARY_LIGHT });
  });

  test("a confirm-only dialog with an icon and child draws them in device order", () => {
    const node = dialog({
      title: undefined,
      text: undefined,
      dismiss: undefined,
      icon: "delete",
      child: { type: "text", text: "Inside" },
    });
    const still = renderPrototypeStill(specWith([node], { open: true }));
    const [surface] = byPart(still.element, "dialog");
    const parts = (surface!.children as WebElement[]).map(
      (child) => child.attrs["data-part"] ?? child.attrs.role,
    );
    expect(parts).toEqual(["img", "content", "buttons"]);
    expect((surface!.children[0] as WebElement).style.color).toBe(SECONDARY_LIGHT);
    expect(textOf(byPart(surface!, "content")[0]!)).toBe("Inside");
    expect(byPart(surface!, "dismiss")).toEqual([]);
  });

  test("dark mode paints the dark surfaceContainerHigh", () => {
    const still = renderPrototypeStill(specWith([dialog()], { open: true }), { mode: "dark" });
    expect(byPart(still.element, "dialog")[0]!.style["background-color"]).toBe(
      SURFACE_CONTAINER_HIGH_DARK,
    );
  });

  test("an authored style wins on the surface", () => {
    const node = dialog({ style: { background: "#ff0000" } });
    const still = renderPrototypeStill(specWith([node], { open: true }));
    expect(byPart(still.element, "dialog")[0]!.style["background-color"]).toBe("rgba(255,0,0,1)");
  });
});

describe("web still snackbar (#16536)", () => {
  test("a closed snackbar draws nothing", () => {
    const still = renderPrototypeStill(specWith([snackbar()], { toast: false }));
    expect(still.unsupportedNodes).toEqual([]);
    expect(byPart(still.element, "snackbarLayer")).toEqual([]);
  });

  test("an open snackbar sits at the bottom without a scrim, in the inverse roles", () => {
    const still = renderPrototypeStill(specWith([snackbar()], { toast: true }));
    const [layer] = byPart(still.element, "snackbarLayer");
    expect(layer!.style).toMatchObject({
      "justify-content": "flex-end",
      "align-items": "center",
      "pointer-events": "none",
    });
    expect(byPart(still.element, "scrim")).toEqual([]);
    const [bar] = byPart(layer!, "snackbar");
    expect(bar!.attrs).toMatchObject({ "data-node": "snackbar", "data-testid": "saved" });
    expect(bar!.style).toMatchObject({
      margin: "12px",
      "max-width": "600px",
      "min-height": "48px",
      "border-radius": "4px",
      "padding-inline": "16px",
      "background-color": INVERSE_SURFACE_LIGHT,
      color: INVERSE_ON_SURFACE_LIGHT,
      "font-size": "14px",
      "pointer-events": "auto",
    });
    expect(textOf(bar!)).toBe("Saved Notes");
  });

  test("an action draws in inversePrimary and narrows the end padding", () => {
    const node = snackbar({ action: { label: "Undo" } });
    const still = renderPrototypeStill(specWith([node], { toast: true }));
    const [bar] = byPart(still.element, "snackbar");
    expect(bar!.style["padding-inline"]).toBe("16px 8px");
    const [action] = byPart(bar!, "action");
    expect(action!.attrs["data-testid"]).toBe("saved.action");
    expect(action!.style.color).toBe(INVERSE_PRIMARY_LIGHT);
    expect(textOf(action!)).toBe("Undo");
  });

  test("layers keep tree order: a dialog before a later snackbar", () => {
    const still = renderPrototypeStill(specWith([dialog(), snackbar()]));
    const window = windowOf(still.element);
    const parts = (window.children.slice(1) as WebElement[]).map(
      (child) => child.attrs["data-part"],
    );
    expect(parts).toEqual(["dialogLayer", "snackbarLayer"]);
  });

  test("modal text keeps authored newlines", () => {
    const still = renderPrototypeStill(
      specWith([dialog({ title: "One\nTwo", text: "A\nB" }), snackbar({ text: "X\nY" })]),
    );
    for (const part of ["headlineSmall", "bodyMedium", "text"]) {
      expect(byPart(still.element, part)[0]!.style["white-space"]).toBe("pre-wrap");
    }
    expect(textOf(byPart(still.element, "headlineSmall")[0]!)).toBe("One\nTwo");
  });

  test("an open dialog with a shader lists it as a shader fallback; a closed one does not", () => {
    const node = dialog({ style: { shader: { type: "noise" } } });
    const reasons = (open: boolean) =>
      renderPrototypeStill(specWith([node], { open })).unsupportedNodes.map((n) => n.reason);
    expect(reasons(true)).toEqual(["shaderFallback"]);
    expect(reasons(false)).toEqual([]);
  });
});
