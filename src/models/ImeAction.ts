export type ImeAction = "done" | "next" | "search" | "send" | "go" | "previous";

/**
 * How Android delivered an IME action, reported on `ime_action_result`. `editor-action` is the
 * keyboard's own path (the app's editor-action handler ran); `focus-traversal` means the service
 * moved focus directly and the field's Next/Previous handler did not run.
 */
export type ImeActionMechanism =
  | "editor-action"
  | "focus-traversal"
  | "ime-enter"
  | "keycode-enter";
