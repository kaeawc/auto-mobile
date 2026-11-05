import {
  ALIGN_ITEMS,
  ARIA_LABEL,
  BACKGROUND_COLOR,
  BORDER_BOX,
  BORDER_RADIUS,
  BOX_SIZING,
  CENTER,
  COLUMN,
  FLEX,
  FLEX_DIRECTION,
  FLEX_SHRINK,
  INLINE_FLEX,
  JUSTIFY_CONTENT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  MIN_WIDTH,
  WHITE_SPACE,
} from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { glyph, iosRole, iosText } from "./webSkinIos";

type Css = Record<string, string>;

/** A light-mode or dark-mode UIKit system colour. */
function system(scope: WebRenderScope, light: string, dark: string): string {
  return scope.style.mode === "dark" ? dark : light;
}

/** SwiftUI's `.red`, which the iOS renderer strokes an errored field and writes its error in. */
function systemRed(scope: WebRenderScope): string {
  return system(scope, "rgba(255,59,48,1)", "rgba(255,69,58,1)");
}

/** UIKit's separator, the field outline when the theme has no `outline`. */
function separator(scope: WebRenderScope): string {
  return system(scope, "rgba(60,60,67,0.29)", "rgba(84,84,88,0.6)");
}

/** As the iOS renderer clips typed text: whole scalars, counting UTF-16 units, up to maxLength. */
function clipped(value: string, maxLength: number | undefined): string {
  if (maxLength === undefined) {
    return value;
  }
  let kept = "";
  for (const scalar of value) {
    if (kept.length + scalar.length > maxLength) {
      break;
    }
    kept += scalar;
  }
  return kept;
}

interface IosFieldText {
  /** What the input shows: the (masked) value, else the placeholder. */
  readonly shown: string;
  readonly empty: boolean;
  /** The `count/max` counter, when the field has a maxLength. */
  readonly counter?: string;
}

/**
 * The field's text as a SwiftUI TextField or SecureField draws it: the stored value (clipped to
 * maxLength, bullets when secure), else the placeholder. The label is never a placeholder on iOS.
 */
function fieldText(node: Raw, scope: WebRenderScope, kit: WebRenderKit): IosFieldText {
  const maxLength = typeof node.maxLength === "number" ? node.maxLength : undefined;
  const key = typeof node.stateKey === "string" ? kit.bound(node.stateKey, scope) : undefined;
  const raw = key === undefined ? undefined : scope.condition.state[key];
  const value = clipped(typeof raw === "string" ? raw : "", maxLength);
  const counter = maxLength === undefined ? {} : { counter: `${value.length}/${maxLength}` };
  if (value === "") {
    return { shown: kit.bound(node.placeholder, scope), empty: true, ...counter };
  }
  const secure = node.secure === true || node.keyboardType === "password";
  return { shown: secure ? "•".repeat([...value].length) : value, empty: false, ...counter };
}

/** A label, variant, supporting text or maxLength makes the iOS renderer draw its own chrome. */
function drawsChrome(node: Raw): boolean {
  return (
    node.label !== undefined ||
    node.variant !== undefined ||
    node.supportingText !== undefined ||
    node.maxLength !== undefined
  );
}

/**
 * The input's chrome, padded 12 pt: `outlined` is a 1 pt 4 pt-radius `outline` stroke; otherwise a
 * `surfaceContainerHighest` fill with 4 pt top corners over a 1 pt `outline` bottom line. An errored
 * field strokes red. Without drawn chrome it is UIKit's rounded-border field.
 */
function inputChrome(node: Raw, error: boolean, scope: WebRenderScope): Css {
  if (!drawsChrome(node)) {
    return {
      padding: "6px 7px",
      [BORDER_RADIUS]: "5px",
      border: `0.5px solid ${separator(scope)}`,
      [BACKGROUND_COLOR]: system(scope, "rgba(255,255,255,1)", "rgba(0,0,0,1)"),
    };
  }
  const stroke = error ? systemRed(scope) : iosRole("outline", separator(scope), scope);
  if (node.variant === "outlined") {
    return { padding: "12px", [BORDER_RADIUS]: "4px", border: `1px solid ${stroke}` };
  }
  return {
    padding: "12px",
    [BORDER_RADIUS]: "4px 4px 0 0",
    "border-bottom": `1px solid ${stroke}`,
    [BACKGROUND_COLOR]: iosRole("surfaceContainerHighest", "rgba(120,120,128,0.2)", scope),
  };
}

/**
 * The input keeps at least one 22 pt body line even when empty, as a TextField does. A multiline
 * field keeps its newlines and its minLines and maxLines.
 */
function lineBounds(node: Raw): Css {
  if (node.multiline !== true) {
    return {
      [MIN_HEIGHT]: "22px",
      [WHITE_SPACE]: "nowrap",
      overflow: "hidden",
      "text-overflow": "ellipsis",
    };
  }
  const lines = typeof node.minLines === "number" ? Math.max(node.minLines, 1) : 1;
  const max: Css =
    typeof node.maxLines === "number"
      ? { [MAX_HEIGHT]: `${node.maxLines * 22}px`, overflow: "hidden" }
      : {};
  return { [WHITE_SPACE]: "pre-wrap", [MIN_HEIGHT]: `${lines * 22}px`, ...max };
}

function input(node: Raw, text: IosFieldText, error: boolean, scope: WebRenderScope): WebElement {
  const placeholder = system(scope, "rgba(60,60,67,0.3)", "rgba(235,235,245,0.3)");
  return el(
    "div",
    {
      attrs: { role: "textbox", ...(error ? { "aria-invalid": "true" } : {}) },
      style: {
        display: FLEX,
        [BOX_SIZING]: BORDER_BOX,
        ...iosText("body", scope),
        ...inputChrome(node, error, scope),
        ...(text.empty ? { color: placeholder } : {}),
      },
    },
    [
      el("span", { style: { flex: "1 1 auto", [MIN_WIDTH]: "0", ...lineBounds(node) } }, [
        text.shown,
      ]),
    ],
  );
}

function captionRow(scope: WebRenderScope): Css {
  return { display: FLEX, gap: "8px", ...iosText("caption", scope) };
}

/**
 * The drawn field: a `.footnote` `onSurfaceVariant` label above the input, 4 pt apart, then a
 * `.caption` row with the supporting text (hidden on an error) and the counter at its end.
 */
function chromedField(node: Raw, error: boolean, scope: WebRenderScope, kit: WebRenderKit) {
  const text = fieldText(node, scope, kit);
  const variant = iosRole(
    "onSurfaceVariant",
    system(scope, "rgba(60,60,67,0.6)", "rgba(235,235,245,0.6)"),
    scope,
  );
  const label =
    typeof node.label === "string"
      ? [
          el(
            "span",
            {
              attrs: { "data-slot": "label" },
              style: { ...iosText("footnote", scope), color: variant },
            },
            [kit.bound(node.label, scope)],
          ),
        ]
      : [];
  const supporting =
    typeof node.supportingText === "string" && !error
      ? [kit.bound(node.supportingText, scope)]
      : [];
  const caption =
    node.supportingText === undefined && text.counter === undefined
      ? []
      : [
          el(
            "div",
            { attrs: { "data-slot": "caption" }, style: { ...captionRow(scope), color: variant } },
            [
              el("span", { style: { flex: "1 1 auto" } }, supporting),
              ...(text.counter === undefined ? [] : [el("span", {}, [text.counter])]),
            ],
          ),
        ];
  if (!drawsChrome(node)) {
    return [input(node, text, error, scope)];
  }
  return [...label, input(node, text, error, scope), ...caption];
}

/** A field icon: a trailing action that runs something is a 48 pt button, any other a bare glyph. */
function fieldIcon(slot: unknown, scope: WebRenderScope, kit: WebRenderKit): WebElement[] {
  const entry = typeof slot === "string" ? { icon: slot } : record(slot);
  if (typeof entry?.icon !== "string") {
    return [];
  }
  const button = Array.isArray(entry.onTap) && entry.onTap.length > 0;
  const size: Css = button ? { width: "48px", height: "48px", [JUSTIFY_CONTENT]: CENTER } : {};
  const label: Css =
    typeof entry.label === "string" ? { [ARIA_LABEL]: kit.bound(entry.label, scope) } : {};
  return [
    el(
      "span",
      {
        attrs: button ? { role: "button", ...label } : {},
        style: { display: INLINE_FLEX, [ALIGN_ITEMS]: CENTER, [FLEX_SHRINK]: "0", ...size },
      },
      [glyph(entry.icon, scope, kit)],
    ),
  ];
}

/** An errored field's message below it in red `.caption`: errorText, else supportingText. */
function errorMessage(
  node: Raw,
  error: boolean,
  scope: WebRenderScope,
  kit: WebRenderKit,
): WebChild[] {
  const message = node.errorText ?? node.supportingText;
  if (!error || typeof message !== "string") {
    return [];
  }
  return [
    el(
      "span",
      {
        attrs: { role: "alert" },
        style: { ...iosText("caption", scope), color: systemRed(scope) },
      },
      [kit.bound(message, scope)],
    ),
  ];
}

/**
 * A text field as the iOS renderer draws one (not a Material field): the label never floats, the
 * input sits in its own chrome, icons sit beside the whole field 4 pt apart, and an error shows below.
 */
export const iosTextFieldRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const error = kit.fieldErrored(node, scope);
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: FLEX,
      [FLEX_DIRECTION]: COLUMN,
      gap: "4px",
      ...disabled.css,
    });
    const field = chromedField(node, error, scope, kit);
    const leading = fieldIcon(node.leadingIcon, scope, kit);
    const trailing = fieldIcon(node.trailingIcon, scope, kit);
    const body =
      leading.length + trailing.length === 0
        ? field
        : [
            el("div", { style: { display: FLEX, [ALIGN_ITEMS]: CENTER, gap: "4px" } }, [
              ...leading,
              el(
                "div",
                {
                  style: {
                    display: FLEX,
                    [FLEX_DIRECTION]: COLUMN,
                    gap: "4px",
                    flex: "1 1 auto",
                  },
                },
                field,
              ),
              ...trailing,
            ]),
          ];
    return el("div", { attrs: { ...attrs, ...disabled.attrs }, style }, [
      ...body,
      ...errorMessage(node, error, scope, kit),
    ]);
  };
