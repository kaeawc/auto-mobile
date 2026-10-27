import type { BindingReconcileResult } from "../../src/daemon/sessionBroker/provisioning/reconciler";

/** Narrow a reconcile result to its `ready` arm, failing the test when it is not. */
export function expectReady(
  result: BindingReconcileResult,
): Extract<BindingReconcileResult, { outcome: "ready" }> {
  if (result.outcome !== "ready") {
    throw new Error(`expected a ready result, got ${result.outcome}: ${result.failure.message}`);
  }
  return result;
}

/** Narrow a reconcile result to its `failed` arm, failing the test when it is not. */
export function expectFailed(
  result: BindingReconcileResult,
): Extract<BindingReconcileResult, { outcome: "failed" }> {
  if (result.outcome !== "failed") {
    throw new Error(`expected a failed result, got ${result.outcome}`);
  }
  return result;
}
