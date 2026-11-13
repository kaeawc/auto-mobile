import type { SearchableEntry } from "../../../utility/SearchableNode";
import {
  followsToggleInPlainWrapper,
  precedingSiblingLabelSources,
} from "../../../utility/SiblingToggleLabels";
import { uniqueBySource } from "../../ApplicationWindowCover";
import { getHierarchyNodeSource } from "../elementProvenance";
import type { SkeletonAccumulator } from "./rowModel";

/**
 * Label a still-unlabelled toggle or range widget from the text node that immediately precedes it
 * in its tree (issue #17955). A Compose `Row { Text("Dark mode"); Switch() }` gives
 * the `Switch` no labelled ancestor for `attributeContainerLabels`, so the row came
 * through with no label. The rule itself, including trailing-text reservation
 * (#18227) and coordinate space, is `precedingSiblingLabelSources`, which the
 * searchable projection shares (#18286). Here a text qualifies only when no
 * clickable row has already folded it in, and ancestry comes from collector
 * provenance; without it the order is unknown and the toggle keeps no label. The
 * wrapper case (`Switch, LinearLayout { Text("Wi-Fi") }`) needs the captured entry
 * graph. The text row itself stays in `context`.
 */
export function attributePrecedingSiblingLabels(
  accumulators: SkeletonAccumulator[],
  foldedIntoClickable: (text: SkeletonAccumulator) => boolean,
  entries?: readonly SearchableEntry[],
): void {
  const toggles = accumulators.filter(
    (acc) => acc.provenance && (acc.affordances.has("toggle") || acc.affordances.has("adjust")),
  );
  const texts = accumulators.filter(
    (acc) =>
      acc.affordances.size === 0 &&
      acc.label?.trim() &&
      acc.provenance &&
      !foldedIntoClickable(acc),
  );
  const entryOf = entries && entryLookup(entries);
  const labels = precedingSiblingLabelSources(
    toggles,
    texts,
    (acc) => ({
      position: acc.provenance!,
      space: acc.space,
      boundsSpace: acc.boundsSpace,
      labelled: acc.label !== undefined,
    }),
    entryOf &&
      ((toggle, text) => {
        const toggleEntry = entryOf(toggle);
        const textEntry = entryOf(text);
        return (
          toggleEntry !== undefined &&
          textEntry !== undefined &&
          followsToggleInPlainWrapper(entries!, toggleEntry, textEntry)
        );
      }),
  );
  for (const [toggle, text] of labels) {
    toggle.label = text.label;
  }
}

/** Captured entry for a row; non-provenance producers supply no entries. */
function entryLookup(entries: readonly SearchableEntry[]) {
  const bySource = new Map(uniqueBySource(entries).map((entry) => [entry.source, entry]));
  return (acc: SkeletonAccumulator): SearchableEntry | undefined => {
    const source = acc.target && getHierarchyNodeSource(acc.target);
    return source ? bySource.get(source) : undefined;
  };
}
