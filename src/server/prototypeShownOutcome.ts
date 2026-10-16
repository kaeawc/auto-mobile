import type { PrototypeResult } from "../features/observe/android/ctrlProxyProtocol";
import type { ShownSpecJson } from "../features/prototype/PrototypeShownSpecs";
import { prototypeStorageBlock } from "../features/prototype/prototypeStorage";

/**
 * Results of a show that threw instead of being answered by the device (a transport failure or
 * timeout): the device may or may not have replaced the prototype, unlike a typed refusal.
 */
const indeterminate = new WeakSet<object>();

export function markIndeterminate<T extends PrototypeResult>(result: T): T {
  indeterminate.add(result);
  return result;
}

/** Whether the show threw rather than being answered, so the device may have applied it. */
export function isIndeterminate(result: PrototypeResult): boolean {
  return indeterminate.has(result);
}

/** What the shown-spec mirror records once a show ends. */
export function shownSpecOutcome(outcome: {
  action: string;
  success: boolean;
  id?: string;
  spec?: unknown;
  replaceOthers?: boolean;
  result: PrototypeResult;
}): {
  shown?: { id: string; spec?: ShownSpecJson; replaceOthers?: boolean };
  refusal?: "typed" | "indeterminate";
} {
  if (outcome.action !== "show") {
    return {};
  }
  if (outcome.success && outcome.id) {
    // A device that restores stored `/data` does not report the restored values, so a show with
    // persisted data keys is left untracked rather than mirrored with stale authored values.
    const restores = prototypeStorageBlock(outcome.spec)?.keys.some((key) =>
      key.startsWith("data:"),
    );
    return {
      shown: {
        id: outcome.id,
        spec: restores ? undefined : (outcome.spec as ShownSpecJson),
        replaceOthers: outcome.replaceOthers,
      },
    };
  }
  // An additive device refusal is atomic: only this id's tentative spec is at stake.
  if (outcome.replaceOthers === false && !outcome.success) {
    return { refusal: isIndeterminate(outcome.result) ? "indeterminate" : "typed" };
  }
  return {};
}
