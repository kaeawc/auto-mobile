import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { CtrlProxyForwardingLeaseConflictError } from "../features/observe/shared/CtrlProxyForwardingLeaseConflictError";
import { MissingViewHierarchyError } from "../features/action/MissingViewHierarchyError";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";

/**
 * The lease-conflict message explaining a device's CtrlProxy state right now:
 * set only while that device's client's MOST RECENT connect attempt failed on
 * the forwarding lease. A later successful connect (or a non-lease failure)
 * clears it, so a stale conflict never outlives a fresh probe.
 */
export type ForwardingLeaseConflictLookup = (deviceId: string) => string | undefined;

export const liveForwardingLeaseConflict: ForwardingLeaseConflictLookup = (deviceId) => {
  const client = AndroidCtrlProxyClient.getExistingInstance(deviceId);
  return client?.isLastConnectionFailureForwardingLeaseConflict()
    ? client.getLastConnectionFailureMessage()
    : undefined;
};

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current instanceof Error && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/**
 * The CtrlProxy forwarding-lease conflict that explains a failed tool call, if
 * any (issue #10485). Only two shapes qualify:
 * - the failure carries a {@link CtrlProxyForwardingLeaseConflictError} in its
 *   cause chain; or
 * - it is a CtrlProxy-read symptom ({@link MissingViewHierarchyError}) on a
 *   device whose client's latest connect failed on the lease.
 * Device loss and every other error (including adb-only tools) keep their own
 * outcome. A failure that already names the conflict keeps its context.
 */
export function forwardingLeaseConflictCause(
  error: unknown,
  deviceIds: Iterable<string> | undefined,
  lookup: ForwardingLeaseConflictLookup = liveForwardingLeaseConflict,
): ActionableError | undefined {
  const chain = causeChain(error);
  const thrown = chain.find(
    (link): link is CtrlProxyForwardingLeaseConflictError =>
      link instanceof CtrlProxyForwardingLeaseConflictError,
  );
  const message =
    thrown?.message ??
    (chain.some((link) => link instanceof MissingViewHierarchyError)
      ? [...(deviceIds ?? [])].map(lookup).find((found) => found !== undefined)
      : undefined);
  if (message === undefined) {
    return undefined;
  }
  if (error !== thrown && errorMessage(error).includes(message)) {
    return undefined;
  }
  return new ActionableError(message, { cause: error });
}
