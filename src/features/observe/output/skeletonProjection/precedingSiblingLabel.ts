import type { SearchableEntry } from "../../../utility/SearchableNode";
import { uniqueBySource } from "../../ApplicationWindowCover";
import { getHierarchyNodeSource } from "../elementProvenance";
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
 * Toggles are walked in tree order. A toggle with no label of its own and no
 * preceding text is a label-after row (`Row { Switch(); Text("Wi-Fi") }`), so the
 * text right after it is its trailing label and never labels the next toggle
 * (issue #18227). That trailing text is the toggle's next sibling, or a text inside
 * that sibling when it is a non-actionable wrapper (`Switch, LinearLayout {
 * Text("Wi-Fi") }`); the wrapper case needs the captured entry graph. A toggle that
 * already has a label, or has a preceding text, claims nothing, so the text after
 * it is the next row's leading label: a flat `Text A, Switch A, Text B, Switch B`
 * list and `Switch(content-desc="Wi-Fi"), Text("Bluetooth"), Switch` both label
 * every switch. Rows in separate containers never qualify, since a sibling
 * container ends after its own last child.
 */
export function attributePrecedingSiblingLabels(
  accumulators: SkeletonAccumulator[],
  foldedIntoClickable: (text: SkeletonAccumulator) => boolean,
  entries?: readonly SearchableEntry[],
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
  const graph = entries && entryGraph(entries);
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
    if (acc.label === undefined && !preceding) {
      for (const text of texts) {
        const bare =
          text.provenance!.group === own.group && text.provenance!.enter === own.exit + 1;
        if (bare || graph?.followsInWrapper(acc, text)) {
          trailing.add(text);
        }
      }
    }
    if (acc.label === undefined) {
      acc.label = preceding?.label;
    }
  }
}

/** Captured entry ancestry for rows; non-provenance producers supply none. */
function entryGraph(entries: readonly SearchableEntry[]) {
  const bySource = new Map(uniqueBySource(entries).map((entry) => [entry.source, entry]));
  const entryOf = (acc: SkeletonAccumulator): SearchableEntry | undefined => {
    const source = acc.target && getHierarchyNodeSource(acc.target);
    return source ? bySource.get(source) : undefined;
  };
  // Entries are pre-order, so the first later entry no deeper than `node` is the
  // node right after its subtree; it is a sibling when it shares the parent.
  const nextSibling = (node: SearchableEntry): SearchableEntry | undefined => {
    const next = entries.slice(node.index + 1).find((entry) => entry.depth <= node.depth);
    return next?.parentIndex === node.parentIndex && next?.rootGroup === node.rootGroup
      ? next
      : undefined;
  };
  return {
    /**
     * Whether `text` sits inside the non-actionable wrapper that is `toggle`'s
     * next sibling. A bare next-sibling text is the provenance case above.
     */
    followsInWrapper(toggle: SkeletonAccumulator, text: SkeletonAccumulator): boolean {
      const toggleEntry = entryOf(toggle);
      const textEntry = entryOf(text);
      const wrapper = toggleEntry && nextSibling(toggleEntry);
      if (!textEntry || !wrapper || wrapper === textEntry || wrapper.affordances.length > 0) {
        return false;
      }
      let cursor: SearchableEntry | undefined = textEntry;
      while (cursor && cursor.index > wrapper.index) {
        cursor = cursor.parentIndex === undefined ? undefined : entries[cursor.parentIndex];
        if (cursor && cursor !== wrapper && cursor.affordances.length > 0) {
          return false;
        }
      }
      return cursor === wrapper;
    },
  };
}
