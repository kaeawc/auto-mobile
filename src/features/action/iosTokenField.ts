import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ViewHierarchyNode } from "../../models";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import { parseBounds } from "../../utils/bounds";
import { isTruthyFlag } from "../utility/elementProperties";
import { toSearchable } from "../utility/SearchableNode";

/**
 * A recipient or token field (Messages "To:", Mail address fields) is a text field whose committed
 * entries are child buttons. Its value is each token label followed by a space, then the text
 * typed after the last token, so the typed text is the value minus the token labels.
 */
export interface IosTokenFieldState {
  /** Labels of the committed tokens, in hierarchy order. */
  tokens: readonly string[];
  /** The value with every token label removed; undefined when the value does not follow them. */
  trailingText?: string;
}

function isInside(inner: ReturnType<typeof parseBounds>, outer: ReturnType<typeof parseBounds>) {
  return (
    inner !== null &&
    outer !== null &&
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom
  );
}

/** Token label of a committed entry: a clickable, id-less button child inside the field. */
function tokenLabel(
  child: ViewHierarchyNode,
  fieldBounds: ReturnType<typeof parseBounds>,
  parser: ElementParser,
): string | undefined {
  const properties = parser.extractNodeProperties(child);
  const searchable = toSearchable(properties);
  const text = searchable.textSources.text;
  const isButton = searchable.className === "UIButton" || properties.role === "button";
  if (
    !isButton ||
    !isTruthyFlag(properties.clickable) ||
    searchable.nativeId !== undefined ||
    text === undefined ||
    text === "" ||
    !isInside(parseBounds(nodeBounds(child)), fieldBounds)
  ) {
    return undefined;
  }
  return text;
}

/** The value after each token label and its separating space, or undefined when it does not match. */
export function trailingTextAfterTokens(
  value: string,
  tokens: readonly string[],
): string | undefined {
  let rest = value;
  for (const token of tokens) {
    if (!rest.startsWith(token)) {
      return undefined;
    }
    rest = rest.slice(token.length);
    rest = rest.startsWith(" ") ? rest.slice(1) : rest;
  }
  return rest;
}

/**
 * Token state of a non-secure iOS text field node, or undefined for an ordinary text field.
 * The system edit menu (Paste / Select / AutoFill) is a sibling collection of plain views, never a
 * child button, so it neither counts as a token nor changes the field's value.
 */
export function readIosTokenField(
  node: ViewHierarchyNode,
  value: string | undefined,
  parser: ElementParser,
): IosTokenFieldState | undefined {
  const fieldBounds = parseBounds(nodeBounds(node));
  const tokens = (node.node ?? []).flatMap((child) => tokenLabel(child, fieldBounds, parser) ?? []);
  if (tokens.length === 0) {
    return undefined;
  }
  const trailingText = value === undefined ? undefined : trailingTextAfterTokens(value, tokens);
  return trailingText === undefined ? { tokens } : { tokens, trailingText };
}
