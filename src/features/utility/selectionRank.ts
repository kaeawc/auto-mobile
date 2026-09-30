/** Ordering shared by resolution and observed duplicate indexes. */
export interface SelectionRank {
  windowRank: number;
  area: number;
  order: number;
  interactive: boolean;
  input?: boolean;
  raw?: boolean;
}

export function compareSelectionRank(
  a: SelectionRank,
  b: SelectionRank,
  preferInteractive = false,
  preferInput = 0,
): number {
  return (
    a.windowRank - b.windowRank ||
    (preferInteractive ? Number(b.interactive) - Number(a.interactive) : 0) ||
    Number(b.raw) - Number(a.raw) ||
    (preferInput ? preferInput * (Number(b.input) - Number(a.input)) : 0) ||
    a.area - b.area ||
    a.order - b.order
  );
}
