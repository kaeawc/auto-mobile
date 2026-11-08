import {
  ABSOLUTE,
  ALIGN_ITEMS,
  ALIGN_SELF,
  BACKGROUND_COLOR,
  BORDER_BOX,
  BORDER_RADIUS,
  BOX_SIZING,
  CENTER,
  COLUMN,
  DATA_PART,
  DATA_TESTID,
  FLEX,
  FLEX_DIRECTION,
  FLEX_SHRINK,
  INLINE_FLEX,
  JUSTIFY_CONTENT,
  MAX_HEIGHT,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  PADDING_INLINE,
  POINTER_EVENTS,
  RELATIVE,
  WHITE_SPACE,
} from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import type { WebRenderKit, WebRenderScope } from "./webRender";
import { hoistedScope, LAYER_CSS, openLayer, roleColor, type WebLayerRenderer } from "./webSheet";
import { rgbaCss, textCss } from "./webStyle";
import { withOverContentLayers } from "./webStylePolish";

type Css = Record<string, string>;

/** What a modal's parts read: the node, its render scope and the shared drawing helpers. */
interface ModalContext {
  readonly node: Raw;
  readonly scope: WebRenderScope;
  readonly kit: WebRenderKit;
}

/** A part's name and the colour role its text takes. */
interface PartLook {
  readonly part: string;
  readonly colorRole: string;
}

/** Android's dialog scrim: the `scrim` role at 0.32, lighter than a sheet's default 0.4. */
const DIALOG_SCRIM_ALPHA = 0.32;

const role = (name: string, scope: WebRenderScope): string => rgbaCss(roleColor(name, scope.style));

/** A dialog or snackbar part's test tag, `<testTag>.<part>`, as the devices tag it. */
function partTag(node: Raw, part: string): Record<string, string> {
  return typeof node.testTag === "string" ? { [DATA_TESTID]: `${node.testTag}.${part}` } : {};
}

/**
 * A Material text button as the dialog and snackbar draw theirs: a 40 px tall label in
 * `labelLarge`, 12 px either side, in the container's action role.
 */
function textButton(
  button: unknown,
  { part, colorRole }: PartLook,
  { node, scope, kit }: ModalContext,
): WebElement[] {
  const label = record(button)?.label;
  if (typeof label !== "string") {
    return [];
  }
  return [
    el(
      "span",
      {
        attrs: { role: "button", [DATA_PART]: part, ...partTag(node, part) },
        style: {
          display: INLINE_FLEX,
          [ALIGN_ITEMS]: CENTER,
          [JUSTIFY_CONTENT]: CENTER,
          [MIN_HEIGHT]: "40px",
          padding: "0 12px",
          [BORDER_RADIUS]: "20px",
          [FLEX_SHRINK]: "0",
          ...textCss({ textStyle: "labelLarge" }, scope.style),
          color: role(colorRole, scope),
        },
      },
      [kit.bound(label, scope)],
    ),
  ];
}

/** The dialog's optional icon, centred in the `secondary` role. */
function dialogIcon(node: Raw, scope: WebRenderScope, kit: WebRenderKit): WebElement[] {
  if (typeof node.icon !== "string") {
    return [];
  }
  const glyph = kit.icon({ type: "icon", name: node.icon }, scope, "");
  return [
    {
      ...glyph,
      style: { ...glyph.style, [ALIGN_SELF]: CENTER, color: role("secondary", scope) },
    },
  ];
}

/** A text line in a type role and colour role, or nothing when the text is absent. */
function line(
  text: unknown,
  { part: textStyle, colorRole }: PartLook,
  { scope, kit }: ModalContext,
) {
  if (typeof text !== "string") {
    return [];
  }
  // Authored and bound newlines break the line, as a device Text does.
  const css: Css = {
    ...textCss({ textStyle }, scope.style),
    color: role(colorRole, scope),
    [WHITE_SPACE]: "pre-wrap",
  };
  return [el("div", { attrs: { [DATA_PART]: textStyle }, style: css }, [kit.bound(text, scope)])];
}

/**
 * Android's in-window dialog: a 0.32 scrim over the window and, centred, a Material alert-dialog
 * surface (28 px corners, `surfaceContainerHigh`, 24 px padding and 16 px gaps, 280 to 560 px wide
 * with 24 px around it) holding the icon, title, body text, the child (which scrolls when tall),
 * then the dismiss and confirm text buttons at the end. Authored style applies to the surface.
 */
function dialogLayer(node: Raw, scope: WebRenderScope, path: string, kit: WebRenderKit) {
  const ctx: ModalContext = { node, scope, kit };
  const hoisted = hoistedScope(scope);
  const { attrs, style } = kit.base(node, hoisted, {
    display: FLEX,
    [FLEX_DIRECTION]: COLUMN,
    gap: "16px",
    position: RELATIVE,
    [BOX_SIZING]: BORDER_BOX,
    margin: "24px",
    padding: "24px",
    [MIN_WIDTH]: "min(280px, calc(100% - 48px))",
    [MAX_WIDTH]: "min(560px, calc(100% - 48px))",
    [MAX_HEIGHT]: "calc(100% - 48px)",
    [BORDER_RADIUS]: "28px",
    [BACKGROUND_COLOR]: role("surfaceContainerHigh", scope),
  });
  const inner = kit.child(hoisted, {
    style: { ...hoisted.style, parentAxis: COLUMN, weightsChildren: false },
  });
  const content = kit.renderNode(node.child, inner, `${path}.child`);
  const body = content
    ? [
        el(
          "div",
          {
            attrs: { [DATA_PART]: "content" },
            style: {
              display: FLEX,
              [FLEX_DIRECTION]: COLUMN,
              gap: "16px",
              flex: "0 1 auto",
              [MIN_HEIGHT]: "0",
              "overflow-y": "auto",
            },
          },
          [content],
        ),
      ]
    : [];
  const buttons = el(
    "div",
    {
      attrs: { [DATA_PART]: "buttons" },
      style: { display: FLEX, [JUSTIFY_CONTENT]: "flex-end", gap: "8px", width: "100%" },
    },
    [
      ...textButton(node.dismiss, { part: "dismiss", colorRole: "primary" }, ctx),
      ...textButton(node.confirm, { part: "confirm", colorRole: "primary" }, ctx),
    ],
  );
  // A gradient border and inner shadows paint over the surface's content, as on any other node.
  const surface = withOverContentLayers(
    el("div", { attrs: { ...attrs, [DATA_PART]: "dialog" }, style }, [
      ...dialogIcon(node, scope, kit),
      ...line(node.title, { part: "headlineSmall", colorRole: "onSurface" }, ctx),
      ...line(node.text, { part: "bodyMedium", colorRole: "onSurfaceVariant" }, ctx),
      ...body,
      buttons,
    ]),
    node.style,
    scope.style,
  );
  const scrim = el("div", {
    attrs: { [DATA_PART]: "scrim" },
    style: {
      position: ABSOLUTE,
      inset: "0",
      [BACKGROUND_COLOR]: rgbaCss({ ...roleColor("scrim", scope.style), a: DIALOG_SCRIM_ALPHA }),
    },
  });
  return el(
    "div",
    {
      attrs: { [DATA_PART]: "dialogLayer" },
      style: { ...LAYER_CSS, [JUSTIFY_CONTENT]: CENTER, [ALIGN_ITEMS]: CENTER },
    },
    [scrim, surface],
  );
}

/**
 * Android's snackbar: no scrim, since it is not modal, and at the window's bottom with 12 px
 * around it a Material snackbar (4 px corners, `inverseSurface`, at least 48 px tall, as wide as
 * the window up to 600 px) holding the `bodyMedium` text and an optional `inversePrimary` action.
 */
function snackbarLayer(node: Raw, scope: WebRenderScope, _path: string, kit: WebRenderKit) {
  const hoisted = hoistedScope(scope);
  const ctx: ModalContext = { node, scope, kit };
  const action = textButton(node.action, { part: "action", colorRole: "inversePrimary" }, ctx);
  const { attrs, style } = kit.base(node, hoisted, {
    display: FLEX,
    [ALIGN_ITEMS]: CENTER,
    position: RELATIVE,
    [BOX_SIZING]: BORDER_BOX,
    margin: "12px",
    width: "calc(100% - 24px)",
    [MAX_WIDTH]: "600px",
    [MIN_HEIGHT]: "48px",
    [PADDING_INLINE]: action.length > 0 ? "16px 8px" : "16px",
    [BORDER_RADIUS]: "4px",
    [BACKGROUND_COLOR]: role("inverseSurface", scope),
    color: role("inverseOnSurface", scope),
    ...textCss({ textStyle: "bodyMedium" }, scope.style),
    [POINTER_EVENTS]: "auto",
  });
  const text = el(
    "span",
    {
      attrs: { [DATA_PART]: "text" },
      style: { flex: "1 1 auto", padding: "14px 0", [WHITE_SPACE]: "pre-wrap" },
    },
    [kit.bound(node.text, scope)],
  );
  const snackbar = withOverContentLayers(
    el("div", { attrs: { ...attrs, [DATA_PART]: "snackbar" }, style }, [text, ...action]),
    node.style,
    scope.style,
  );
  return el(
    "div",
    {
      attrs: { [DATA_PART]: "snackbarLayer" },
      // Not modal: the layer passes touches through to the tree, only the snackbar takes them.
      style: { ...LAYER_CSS, [ALIGN_ITEMS]: CENTER, [POINTER_EVENTS]: "none" },
    },
    [snackbar],
  );
}

export function webModalLayers(kit: WebRenderKit): Readonly<Record<string, WebLayerRenderer>> {
  return {
    dialog: openLayer((node, scope, path) => dialogLayer(node, scope, path, kit)),
    snackbar: openLayer((node, scope, path) => snackbarLayer(node, scope, path, kit)),
  };
}
