import type { BindingReconcileFailure } from "./reconciler";

export class ReconcileAbort extends Error {
  constructor(readonly failure: BindingReconcileFailure) {
    super(failure.message);
    this.name = "ReconcileAbort";
  }
}
