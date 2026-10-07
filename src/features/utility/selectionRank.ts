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

/**
 * One positional slot per selectable target in a selector's matches. Prefer the
 * owner when it also matched; otherwise retain the matching source so diagnostic
 * and scoped consumers can still recover it. Null targets do not occupy slots.
 */
export function selectableCandidates<T>(
  matches: readonly T[],
  targetFor: (candidate: T) => T | null,
): T[] {
  const matching = new Set(matches);
  const candidates = new Map<T, T>();
  for (const match of matches) {
    const target = targetFor(match);
    if (target !== null && !candidates.has(target)) {
      candidates.set(target, matching.has(target) ? target : match);
    }
  }
  return [...candidates.values()];
}
