/**
 * Style-property names, attribute names and style values the web renderer repeats across its
 * element builders (#16809). Builders write them as identifiers (`{ display: FLEX,
 * [ALIGN_ITEMS]: CENTER }`) so the browser still bundle carries each literal once instead of at
 * every call site; the serialized HTML is unchanged. A name or value used only a few times stays
 * a plain string literal.
 */

// Property and attribute names.
export const ALIGN_ITEMS = "align-items";
export const ALIGN_SELF = "align-self";
export const ARIA_CHECKED = "aria-checked";
export const ARIA_HIDDEN = "aria-hidden";
export const ARIA_LABEL = "aria-label";
export const ARIA_SELECTED = "aria-selected";
export const ASPECT_RATIO = "aspect-ratio";
export const BACKGROUND_COLOR = "background-color";
export const BORDER_RADIUS = "border-radius";
export const BOX_SHADOW = "box-shadow";
export const BOX_SIZING = "box-sizing";
export const DATA_CHROME = "data-chrome";
export const DATA_LEVEL = "data-level";
export const DATA_PART = "data-part";
export const DATA_STATUS = "data-status";
export const DATA_TESTID = "data-testid";
export const DATA_WINDOW = "data-window";
export const FLEX_BASIS = "flex-basis";
export const FLEX_DIRECTION = "flex-direction";
export const FLEX_SHRINK = "flex-shrink";
export const FONT_FAMILY = "font-family";
export const FONT_SIZE = "font-size";
export const FONT_WEIGHT = "font-weight";
export const GRID_AREA = "grid-area";
export const GRID_TEMPLATE_COLUMNS = "grid-template-columns";
export const JUSTIFY_CONTENT = "justify-content";
export const JUSTIFY_SELF = "justify-self";
export const LINE_HEIGHT = "line-height";
export const MARGIN_INLINE_START = "margin-inline-start";
export const MAX_HEIGHT = "max-height";
export const MAX_WIDTH = "max-width";
export const MIN_HEIGHT = "min-height";
export const MIN_WIDTH = "min-width";
export const PADDING_BOTTOM = "padding-bottom";
export const PADDING_INLINE = "padding-inline";
export const PADDING_TOP = "padding-top";
export const POINTER_EVENTS = "pointer-events";
export const TEXT_ALIGN = "text-align";
export const WHITE_SPACE = "white-space";
export const Z_INDEX = "z-index";

// Values.
export const ABSOLUTE = "absolute";
export const BORDER_BOX = "border-box";
export const CENTER = "center";
export const COLUMN = "column";
export const FLEX = "flex";
export const INLINE_FLEX = "inline-flex";
export const RELATIVE = "relative";
export const STRETCH = "stretch";
