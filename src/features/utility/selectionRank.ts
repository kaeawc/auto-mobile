/** Ordering shared by resolution and observed duplicate indexes. */
export interface SelectionRank {
  windowRank: number;
  area: number;
  order: number;
  interactive: boolean;
  /** Absent raw/input flags mean false. */
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
    Number(Boolean(b.raw)) - Number(Boolean(a.raw)) ||
    (preferInput ? preferInput * (Number(Boolean(b.input)) - Number(Boolean(a.input))) : 0) ||
    a.area - b.area ||
    a.order - b.order
  );
}
