export type ImeAction = "done" | "next" | "search" | "send" | "go" | "previous";

const SUBMIT_IME_ACTIONS: ReadonlySet<ImeAction> = new Set(["done", "go", "search", "send"]);

export function isSubmitImeAction(action: unknown): action is ImeAction {
  return typeof action === "string" && SUBMIT_IME_ACTIONS.has(action as ImeAction);
}

export interface ImeActionResult {
    success: boolean;
    action: string;
    error?: string;
    observation?: any;
}
