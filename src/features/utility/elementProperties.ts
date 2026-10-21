import { Element } from "../../models/Element";

/** Raw capture fields the selector lint rule guards (the raw-selector-field-read lint rule). */
export type RawSelectorField = "text" | "content-desc" | "resource-id";

type RawNodeProperties = Readonly<Record<string, unknown>> | null | undefined;

/**
 * The raw capture value of a selector-named field, for classification and fingerprinting only.
 *
 * User-specified targets are never selected through these accessors: they go through
 * `ElementResolver` / `SearchableNode`. This module is outside the scope of
 * the raw-selector-field-read lint rule, so a raw read anywhere else still fails the rule.
 */
export function rawNodeValue(props: RawNodeProperties, field: RawSelectorField): unknown {
  return props?.[field];
}

/** The first non-nullish value among `keys`, as a string; "" when none is present. */
export function rawNodeString(props: RawNodeProperties, keys: readonly string[]): string {
  for (const key of keys) {
    const value = props?.[key];
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }
  return "";
}

/** `resource-id`, then the camelCase alias; add `extraKeys` for platform-specific fallbacks. */
export function rawResourceId(props: RawNodeProperties, extraKeys: readonly string[] = []): string {
  return rawNodeString(props, ["resource-id", "resourceId", ...extraKeys]);
}

/** `content-desc`, then the camelCase alias. */
export function rawContentDesc(props: RawNodeProperties): string {
  return rawNodeString(props, ["content-desc", "contentDesc"]);
}

/** The raw `text` attribute. */
export function rawText(props: RawNodeProperties): string {
  return rawNodeString(props, ["text"]);
}

export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/** A named toggle exposes its identity in content-desc and its mutable state in text. */
export function getToggleContentDescription(props: Record<string, unknown>): string | undefined {
  const description = props["content-desc"];
  return isTruthyFlag(props.checkable) &&
    typeof description === "string" &&
    description.trim() !== ""
    ? description
    : undefined;
}

export function hasAccessibilityAction(value: unknown, action: string): boolean {
  return Array.isArray(value) && value.some((item) => item === action);
}

export function isClickableElementProperties(props: Record<string, unknown>): boolean {
  return isTruthyFlag(props.clickable) || hasAccessibilityAction(props.actions, "click");
}

/**
 * Whether an element exposes a native or accessibility-backed editable input affordance.
 * Focusable fields retain the skeleton affordance contract; class and action signals
 * preserve coverage for incomplete Android hierarchy captures.
 */
export function isEditableElementProperties(props: Record<string, unknown>): boolean {
  const nodeClass = props.class ?? props.className;
  const hasInputClass =
    typeof nodeClass === "string" &&
    ANDROID_INPUT_CLASSES.some((inputClass) => nodeClass.includes(inputClass));
  const hasInputType = typeof props["input-type"] === "string" && props["input-type"].trim() !== "";
  return (
    hasInputClass ||
    hasAccessibilityAction(props.actions, "set_text") ||
    (isTruthyFlag(props.focusable) && hasInputType)
  );
}

export function buildContainerFromElement(
  element: Element,
): { elementId?: string; text?: string } | null {
  if (element["resource-id"]) {
    return { elementId: element["resource-id"] };
  }
  if (element.text) {
    return { text: element.text };
  }
  if (element["content-desc"]) {
    return { text: element["content-desc"] };
  }
  if (element["ios-accessibility-label"]) {
    return { text: element["ios-accessibility-label"] };
  }
  return null;
}

export const ANDROID_INPUT_CLASSES: readonly string[] = [
  "android.widget.EditText",
  "android.widget.AutoCompleteTextView",
  "android.widget.MultiAutoCompleteTextView",
  "androidx.appcompat.widget.AppCompatEditText",
];

/** A collection boundary cannot be crossed by an adjacent-control selector. */
export function isCollectionElementProperties(props: Record<string, unknown>): boolean {
  const className =
    typeof props.class === "string"
      ? props.class
      : typeof props.className === "string"
        ? props.className
        : "";
  const simpleClassName = className.split(".").at(-1) ?? "";
  return (
    isTruthyFlag(props.scrollable) ||
    className === "XCUIElementTypeTable" ||
    [
      "RecyclerView",
      "ListView",
      "GridView",
      "ScrollView",
      "CollectionView",
      "TableView",
      "ViewPager",
      "ViewPager2",
    ].some((name) => className.endsWith(name) || simpleClassName.startsWith(name))
  );
}
