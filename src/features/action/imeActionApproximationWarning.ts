/** Warning for an IME next/previous that CtrlProxy could only approximate (#10482). */
export const IME_ACTION_APPROXIMATED_WARNING =
  "Focus was moved directly; the field's configured Next/Previous editor action was not dispatched, so the app's onNext/editor-action handler did not run.";

/**
 * Surface a device `approximated: true` IME action result as a host-side `warning`,
 * keeping any warning the result already carries.
 */
export function withImeActionApproximationWarning<
  T extends { approximated?: boolean; warning?: string },
>(result: T): T {
  if (!result.approximated) {
    return result;
  }
  return {
    ...result,
    warning: result.warning
      ? `${result.warning} ${IME_ACTION_APPROXIMATED_WARNING}`
      : IME_ACTION_APPROXIMATED_WARNING,
  };
}
