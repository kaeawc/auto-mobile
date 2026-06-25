export type ImeAction = "done" | "next" | "search" | "send" | "go" | "previous";

export interface ImeActionResult {
    success: boolean;
    action: string;
    error?: string;
    observation?: any;
}
