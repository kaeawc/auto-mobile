import { AsyncLocalStorage } from "node:async_hooks";
import type { ObserveResult, ViewHierarchyResult } from "../../models";

// Scope acquisition proof to the requesting action, even when concurrent calls
// share an observer or FakeTimer timestamps. Never serialize this provenance.
const reads = new AsyncLocalStorage<WeakSet<ViewHierarchyResult>>();

export function withObservationReadScope<T>(block: () => T): T {
  return reads.run(new WeakSet(), block);
}

/** Called only by execute(), never by an observation-cache lookup. */
export function recordObservationRead(result: ObserveResult): ObserveResult {
  if (result.viewHierarchy) {
    reads.getStore()?.add(result.viewHierarchy);
  }
  return result;
}

export function wasHierarchyReadDuringCall(hierarchy: ViewHierarchyResult): boolean {
  return reads.getStore()?.has(hierarchy) ?? false;
}
