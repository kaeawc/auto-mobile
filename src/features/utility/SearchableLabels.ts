import type { Affordance } from "../../models/ObserveResult";

/** State and scroll containers may advertise their labelled owning row. */
export function inheritsOwnerLabel(affordances: Iterable<Affordance>): boolean {
  return [...affordances].some((action) => action === "toggle" || action === "scroll");
}

/** The label emitted by the skeleton; keep internal whitespace and length intact. */
export function displayedSearchableLabel(label: string | undefined): string | undefined {
  return label?.trim();
}

/** Fold a row's ordered descendant labels identically for display and resolution. */
export function foldSearchableLabels(
  row: { label?: string; sublabel?: string },
  parts: readonly string[],
): { label?: string; sublabel?: string } {
  if (parts.length === 0) {
    return row;
  }
  if (row.label === undefined) {
    return {
      label: parts[0],
      sublabel: parts.length > 1 ? parts.slice(1).join(", ") : row.sublabel,
    };
  }
  if (row.label !== row.label.trim()) {
    return {
      label: `${parts[0]} ${row.label.trim()}`,
      sublabel: parts.length > 1 ? parts.slice(1).join(", ") : row.sublabel,
    };
  }
  return {
    label: row.label,
    sublabel: [...new Set([row.sublabel, ...parts].filter(Boolean))].join(", "),
  };
}
