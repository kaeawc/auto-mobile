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
 * A text that starts right after another toggle's subtree ends is that toggle's
 * trailing label (`Row { Switch(); Text("Wi-Fi") }`), so it never labels the next
 * toggle (issue #18227). This covers a flattened list of `Switch, Text` pairs and
 * a previous row whose last child is its text.
 */
export function attributePrecedingSiblingLabels(
  accumulators: SkeletonAccumulator[],
  foldedIntoClickable: (text: SkeletonAccumulator) => boolean,
): void {
  const toggles = accumulators.filter((acc) => acc.provenance && acc.affordances.has("toggle"));
  const trailsToggle = (text: SkeletonAccumulator): boolean =>
    toggles.some(
      (toggle) =>
        toggle.provenance!.group === text.provenance!.group &&
        toggle.provenance!.exit === text.provenance!.enter - 1,
    );
  const texts = accumulators.filter(
    (acc) =>
      acc.affordances.size === 0 &&
      acc.label?.trim() &&
      acc.provenance &&
      !foldedIntoClickable(acc) &&
      !trailsToggle(acc),
  );
  for (const acc of toggles) {
    const own = acc.provenance!;
    if (acc.label !== undefined) {
      continue;
    }
    const preceding = texts
      .filter(
        (text) =>
          text.space === acc.space &&
          text.boundsSpace === acc.boundsSpace &&
          text.provenance!.group === own.group &&
          text.provenance!.exit === own.enter - 1,
      )
      .sort((a, b) => a.provenance!.enter - b.provenance!.enter)[0];
    acc.label = preceding?.label;
  }
}
