import {
  ALIGN_ITEMS,
  ALIGN_SELF,
  ARIA_CHECKED,
  ARIA_LABEL,
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
  MARGIN_INLINE_START,
  MIN_HEIGHT,
  PADDING_INLINE,
  STRETCH,
} from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import { defaultFillAxes, filling, type WebAxis } from "./webCollections";
import { el, type WebChild, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { webPickerRenderers } from "./webPickers";
import { cssColor, textCss } from "./webStyle";

type Css = Record<string, string>;

interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

/** A choice control's options with their labels bound; malformed entries are skipped. */
function choiceOptions(node: Raw, scope: WebRenderScope, kit: WebRenderKit): ChoiceOption[] {
  const options = Array.isArray(node.options) ? node.options : [];
  return options.flatMap((entry) => {
    const option = record(entry);
    return typeof option?.value === "string"
      ? [{ value: option.value, label: kit.bound(option.label, scope) }]
      : [];
  });
}

/** The value a choice control's state key holds, with repeat placeholders in the key bound. */
function chosenValue(node: Raw, scope: WebRenderScope, kit: WebRenderKit): unknown {
  return typeof node.stateKey === "string"
    ? scope.condition.state[kit.bound(node.stateKey, scope)]
    : undefined;
}

/** One option's tag, `<testTag>.<value>`, as both devices tag radio options and segments. */
function optionTag(node: Raw, value: string): Css {
  return typeof node.testTag === "string" ? { [DATA_TESTID]: `${node.testTag}.${value}` } : {};
}

/** The icon placeholder at a size other than its default 24 px. */
function sizedIcon(name: string, size: number, scope: WebRenderScope, kit: WebRenderKit) {
  const glyph = kit.icon({ type: "icon", name }, scope, "");
  return { ...glyph, style: { ...glyph.style, width: `${size}px`, height: `${size}px` } };
}

/**
 * A Material 3 radio button: a 20 px ring in a 24 px slot, `primary` with a 10 px dot when
 * selected and `onSurfaceVariant` when not.
 */
function radioMark(selected: boolean, scope: WebRenderScope): WebElement {
  const tint = cssColor(selected ? "primary" : "onSurfaceVariant", scope.style) ?? "currentColor";
  const dot = el("span", {
    style: { width: "10px", height: "10px", [BORDER_RADIUS]: "50%", [BACKGROUND_COLOR]: tint },
  });
  return el(
    "span",
    {
      attrs: { [DATA_PART]: "radio" },
      style: {
        display: INLINE_FLEX,
        [ALIGN_ITEMS]: CENTER,
        [JUSTIFY_CONTENT]: CENTER,
        [BOX_SIZING]: BORDER_BOX,
        width: "20px",
        height: "20px",
        margin: "2px",
        [BORDER_RADIUS]: "50%",
        border: `2px solid ${tint}`,
        [FLEX_SHRINK]: "0",
      },
    },
    selected ? [dot] : [],
  );
}

/**
 * A column of radio rows bound to a string key: each row is a 48 px target with the radio before
 * its label, 12 px apart, and is selected when the key holds its value.
 */
const radioGroupRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const chosen = chosenValue(node, scope, kit);
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(filling(node, defaultFillAxes(node)), scope, {
      display: FLEX,
      [FLEX_DIRECTION]: COLUMN,
      ...kit.roleCss(scope, "transparent", "onSurface"),
      ...disabled.css,
    });
    const rows = choiceOptions(node, scope, kit).map((option) =>
      el(
        "div",
        {
          attrs: {
            role: "radio",
            [ARIA_CHECKED]: String(option.value === chosen),
            [ARIA_LABEL]: option.label,
            ...optionTag(node, option.value),
          },
          style: { display: FLEX, [ALIGN_ITEMS]: CENTER, gap: "12px", [MIN_HEIGHT]: "48px" },
        },
        [radioMark(option.value === chosen, scope), option.label],
      ),
    );
    return el("div", { attrs: { ...attrs, role: "radiogroup", ...disabled.attrs }, style }, rows);
  };

/**
 * A closed select field: a 4 px-radius tonal surface with 16 px padding, its label in `labelSmall`
 * above the chosen option's label, and a trailing expand icon. Its option list opens only on tap,
 * so a still never draws it.
 */
const selectRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const chosen = chosenValue(node, scope, kit);
    const current = choiceOptions(node, scope, kit).find((option) => option.value === chosen);
    const { attrs, style } = kit.base(filling(node, defaultFillAxes(node)), scope, {
      display: FLEX,
      [ALIGN_ITEMS]: CENTER,
      gap: "12px",
      [BOX_SIZING]: BORDER_BOX,
      [MIN_HEIGHT]: "48px",
      padding: "16px",
      [BORDER_RADIUS]: "4px",
      ...kit.roleCss(scope, "surfaceContainerLow", "onSurface"),
    });
    const label =
      typeof node.label === "string"
        ? [
            el("span", { style: textCss({ textStyle: "labelSmall" }, scope.style) }, [
              kit.bound(node.label, scope),
            ]),
          ]
        : [];
    const text = el(
      "span",
      { style: { display: FLEX, [FLEX_DIRECTION]: COLUMN, flex: "1 1 auto" } },
      [...label, el("span", { attrs: { [DATA_PART]: "value" } }, [current?.label ?? ""])],
    );
    return el("div", { attrs: { ...attrs, role: "button", "aria-haspopup": "listbox" }, style }, [
      text,
      kit.icon({ type: "icon", name: "expand_more" }, scope, ""),
    ]);
  };

/**
 * One Material 3 segment: 40 px tall, outlined, the first and last fully rounded on their outer
 * ends, and tonal with a leading check while selected. Neighbours share their 1 px border.
 */
function segment(
  option: ChoiceOption,
  place: { selected: boolean; index: number; count: number; tag: Css },
  scope: WebRenderScope,
  kit: WebRenderKit,
): WebElement {
  const { selected, index, count } = place;
  const outline = cssColor("outline", scope.style) ?? "currentColor";
  const start = index === 0 ? "20px" : "0";
  const end = index === count - 1 ? "20px" : "0";
  return el(
    "div",
    {
      attrs: {
        role: "radio",
        [ARIA_CHECKED]: String(selected),
        [ARIA_LABEL]: option.label,
        ...place.tag,
      },
      style: {
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        [JUSTIFY_CONTENT]: CENTER,
        gap: "8px",
        [BOX_SIZING]: BORDER_BOX,
        [MIN_HEIGHT]: "40px",
        padding: "0 12px",
        border: `1px solid ${outline}`,
        ...(index > 0 ? { [MARGIN_INLINE_START]: "-1px" } : {}),
        "border-start-start-radius": start,
        "border-end-start-radius": start,
        "border-start-end-radius": end,
        "border-end-end-radius": end,
        ...kit.roleCss(
          scope,
          selected ? "secondaryContainer" : "transparent",
          selected ? "onSecondaryContainer" : "onSurface",
        ),
      },
    },
    [...(selected ? [sizedIcon("check", 18, scope, kit)] : []), option.label],
  );
}

/** A single-choice segmented row: equal-width segments, as wide as the widest. */
const segmentedButtonRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const chosen = chosenValue(node, scope, kit);
    const options = choiceOptions(node, scope, kit);
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-grid",
      "grid-auto-flow": "column",
      "grid-auto-columns": "1fr",
      [MIN_HEIGHT]: "48px",
      [ALIGN_ITEMS]: CENTER,
      ...textCss({ textStyle: "labelLarge" }, scope.style),
    });
    return el(
      "div",
      { attrs: { ...attrs, role: "radiogroup" }, style },
      options.map((option, index) =>
        segment(
          option,
          {
            selected: option.value === chosen,
            index,
            count: options.length,
            tag: optionTag(node, option.value),
          },
          scope,
          kit,
        ),
      ),
    );
  };

/** Whether a search bar's `activeKey` holds `true`, which expands it as on both devices. */
function searchActive(node: Raw, scope: WebRenderScope, kit: Pick<WebRenderKit, "bound">): boolean {
  return (
    typeof node.activeKey === "string" &&
    scope.condition.state[kit.bound(node.activeKey, scope)] === true
  );
}

/**
 * The unsized axes a search bar fills: its width, plus its height while the full-screen `bar`
 * variant is expanded (Android's `fillMaxSize()`), so unsized ancestor lines grow too (#16803).
 */
export function searchBarFillAxes(
  node: Raw,
  scope: WebRenderScope,
  kit: Pick<WebRenderKit, "bound">,
): WebAxis[] {
  const style = record(node.style) ?? {};
  const axes: WebAxis[] =
    searchActive(node, scope, kit) && node.variant !== "docked" ? ["width", "height"] : ["width"];
  return axes.filter((axis) => style[axis] === undefined);
}

/** The search bar's trailing actions as 48 px icon buttons tagged `<testTag>.actions.<i>`. */
function searchActions(node: Raw, scope: WebRenderScope, kit: WebRenderKit): WebElement[] {
  const actions = Array.isArray(node.trailingActions) ? node.trailingActions : [];
  return actions.flatMap((entry, index) => {
    const action = record(entry);
    if (typeof action?.icon !== "string") {
      return [];
    }
    const label = typeof action.label === "string" ? kit.bound(action.label, scope) : action.icon;
    const tag: Css =
      typeof node.testTag === "string" ? { [DATA_TESTID]: `${node.testTag}.actions.${index}` } : {};
    return [
      el(
        "span",
        { attrs: { role: "button", [ARIA_LABEL]: label, ...tag }, style: { padding: "12px" } },
        [kit.icon({ type: "icon", name: action.icon }, scope, "")],
      ),
    ];
  });
}

/**
 * Material 3's search input: a 56 px pill in `surfaceContainerHigh`, a leading icon, the query
 * (or its placeholder in `onSurfaceVariant`) and the trailing actions.
 */
function searchField(node: Raw, scope: WebRenderScope, kit: WebRenderKit): WebElement {
  const value = chosenValue(node, scope, kit);
  const query = typeof value === "string" ? value : "";
  const shown = query === "" ? kit.bound(node.placeholder, scope) : query;
  const muted = query === "" ? kit.roleCss(scope, "transparent", "onSurfaceVariant") : {};
  const leading =
    typeof node.leadingIcon === "string"
      ? [kit.icon({ type: "icon", name: node.leadingIcon }, scope, "")]
      : [];
  return el(
    "div",
    {
      attrs: { role: "searchbox", [DATA_PART]: "input" },
      style: {
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        // The bar's column start-aligns its results; the input alone fills its width.
        [ALIGN_SELF]: STRETCH,
        gap: "16px",
        [BOX_SIZING]: BORDER_BOX,
        [MIN_HEIGHT]: "56px",
        [PADDING_INLINE]: leading.length > 0 ? "16px 4px" : "24px 4px",
        [BORDER_RADIUS]: "28px",
        ...textCss({ textStyle: "bodyLarge" }, scope.style),
        ...kit.roleCss(scope, "surfaceContainerHigh", "onSurface"),
      },
    },
    [
      ...leading,
      el("span", { style: { flex: "1 1 auto", ...muted } }, [shown]),
      ...searchActions(node, scope, kit),
    ],
  );
}

/**
 * A search bar: the input on a `surface` container. While its `activeKey` holds `true` it is
 * expanded and draws its child (the results) below the input, start-aligned as Android's results
 * Column is; the full-screen `bar` variant then fills the window, while `docked` stays its own height.
 */
const searchBarRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope, path) => {
    const expanded = searchActive(node, scope, kit);
    const { attrs, style } = kit.base(filling(node, searchBarFillAxes(node, scope, kit)), scope, {
      display: FLEX,
      [FLEX_DIRECTION]: COLUMN,
      // Android's results Column is start-aligned, so a compact child keeps its own width.
      [ALIGN_ITEMS]: "flex-start",
      ...kit.roleCss(scope, "surface", "onSurface"),
    });
    const results: WebChild[] = [];
    if (expanded && node.child !== undefined) {
      const inner = kit.child(scope, {
        inBox: false,
        style: { ...scope.style, parentAxis: COLUMN, weightsChildren: false },
      });
      const drawn = kit.renderNode(node.child, inner, `${path}.child`);
      results.push(...(drawn ? [drawn] : []));
    }
    return el("div", { attrs: { ...attrs, "aria-expanded": String(expanded) }, style }, [
      searchField(node, scope, kit),
      ...results,
    ]);
  };

/**
 * The selection and picker renderers. Android draws a paste button as a filled button labelled
 * "Paste"; it reads the clipboard only when tapped, so a still draws the button alone.
 */
export function webSelectionRenderers(
  kit: WebRenderKit,
  button: NodeRenderer,
): Record<string, NodeRenderer> {
  return {
    radioGroup: radioGroupRenderer(kit),
    select: selectRenderer(kit),
    segmentedButton: segmentedButtonRenderer(kit),
    searchBar: searchBarRenderer(kit),
    pasteButton: (node, scope, path) => button({ ...node, label: "Paste" }, scope, path),
    ...webPickerRenderers(kit),
  };
}
