export const ELEMENT_SELECTION_STRATEGIES = ["first", "random", "unique"] as const;

export type ElementSelectionStrategy = (typeof ELEMENT_SELECTION_STRATEGIES)[number];
