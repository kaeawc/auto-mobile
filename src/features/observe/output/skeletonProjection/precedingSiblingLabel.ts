import type { SkeletonAccumulator } from "./rowModel";

/**
 * Label a still-unlabelled toggle from the text node that immediately precedes it
 * in its tree (issue #17955). A Compose `Row { Text("Dark mode"); Switch() }` gives
 * the `Switch` no labelled ancestor for `attributeContainerLabels`, so the
 * row came through with no label. The text qualifies only when its subtree ends
 * right before the toggle starts in the same root/window (provenance `exit ===
 * enter - 1`) and no clickable row has already folded it in. Among such nodes the
 * outermost one (smallest `enter`) wins, so it is the preceding sibling itself
 * rather than a nested descendant. Without provenance the order is unknown and the
 * toggle keeps no label. The text row itself stays in `context`.
 *
 * Toggles are walked in tree order. A toggle that has no preceding text is a
 * label-after row (`Row { Switch(); Text("Wi-Fi") }`), so the text starting right
 * after it is its trailing label and never labels the next toggle (issue #18227).
 * A toggle that does have a preceding text is a label-before row, so the text
 * right after it is the next row's leading label: a flat `Text A, Switch A, Text
 * B, Switch B` list labels both switches. Rows in separate containers never
 * qualify, since a sibling container ends after its own last child.
 */
export function attributePrecedingSiblingLabels(
  accumulators: SkeletonAccumulator[],
  foldedIntoClickable: (text: SkeletonAccumulator) => boolean,
): void {
  const toggles = accumulators
    .filter((acc) => acc.provenance && acc.affordances.has("toggle"))
    .sort((a, b) => a.provenance!.enter - b.provenance!.enter);
  const texts = accumulators.filter(
    (acc) =>
      acc.affordances.size === 0 &&
      acc.label?.trim() &&
      acc.provenance &&
      !foldedIntoClickable(acc),
  );
  const trailing = new Set<SkeletonAccumulator>();
  for (const acc of toggles) {
    const own = acc.provenance!;
    const preceding = texts
      .filter(
        (text) =>
          !trailing.has(text) &&
          text.space === acc.space &&
          text.boundsSpace === acc.boundsSpace &&
          text.provenance!.group === own.group &&
          text.provenance!.exit === own.enter - 1,
      )
      .sort((a, b) => a.provenance!.enter - b.provenance!.enter)[0];
    if (!preceding) {
      const after = texts.filter(
        (text) => text.provenance!.group === own.group && text.provenance!.enter === own.exit + 1,
      );
      for (const text of after) {
        trailing.add(text);
      }
    }
    if (acc.label === undefined) {
      acc.label = preceding?.label;
    }
  }
}
