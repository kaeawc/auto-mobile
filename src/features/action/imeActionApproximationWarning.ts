/** Warning for an IME next/previous that CtrlProxy could only approximate (#10482). */
export const IME_ACTION_APPROXIMATED_WARNING =
  "Focus was moved directly; the field's configured Next/Previous editor action was not dispatched, so the app's onNext/editor-action handler did not run.";

/**
 * Surface a device `approximated: true` IME action result as a host-side `warning`,
 * keeping any warning the result already carries. Failed results are left untouched.
 */
export function withImeActionApproximationWarning<
  T extends { success?: boolean; approximated?: boolean; warning?: string },
>(result: T): T {
  // A failed fallback (adjacent node not found/focused) did not move focus, so the warning would lie.
  if (!result.approximated || result.success === false) {
    return result;
  }
  return {
    ...result,
    warning: result.warning
      ? `${result.warning} ${IME_ACTION_APPROXIMATED_WARNING}`
      : IME_ACTION_APPROXIMATED_WARNING,
  };
}
