/**
 * Guidance messages for synthetic stable view-id (`s2-<hash>`) selectors that
 * cannot safely identify one element, reported by ElementResolver (#10476).
 */

export function legacyBareStableViewIdMessage(id: string): string {
  return (
    `Skeleton element id "${id}" uses the legacy bare duplicate encoding in this capture. ` +
    "Re-observe the screen and use a current selector; legacy bare stable ids cannot safely " +
    "identify a content-identical element."
  );
}

export function ambiguousStableViewIdMessage(
  id: string,
  base: string,
  duplicateCount: number,
  suffixedIds: readonly string[],
): string {
  const idHint =
    suffixedIds.length > 0
      ? ` Current capture suffixed ids: ${suffixedIds.map((viewId) => `"${viewId}"`).join(", ")}.`
      : "";
  return (
    `Skeleton element id "${id}" is ambiguous in the current capture: ${duplicateCount} ` +
    `elements share structural stable id "${base}". A bare id cannot select a peer, ` +
    "and a positional -N suffix can shift after an insert or reorder. Use text or " +
    "textAny (with index when multiple text matches) instead." +
    idHint
  );
}
