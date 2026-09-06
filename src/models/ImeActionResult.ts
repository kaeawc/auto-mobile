export type ImeAction = "done" | "next" | "search" | "send" | "go" | "previous";

const SUBMIT_IME_ACTIONS: ReadonlySet<ImeAction> = new Set(["done", "go", "search", "send"]);

// Returns true only for the submit-style IME actions ("done"/"go"/"search"/"send"),
// not the whole ImeAction union — so a plain boolean, not an `action is ImeAction`
// type predicate (which would falsely narrow "next"/"previous" too).
export function isSubmitImeAction(action: unknown): boolean {
  return typeof action === "string" && SUBMIT_IME_ACTIONS.has(action as ImeAction);
}

export interface ImeActionResult {
  success: boolean;
  action: string;
  error?: string;
  observation?: any;
  /**
   * Set when the action itself completed (mutating the UI) but a later,
   * best-effort step — e.g. the post-action observation — did not finish
   * within its deadline. The result is still the real outcome of the
   * action; this only flags that the accompanying observation may be
   * missing or stale. Never set alongside `success: false` (#6249).
   */
  warning?: string;
}
