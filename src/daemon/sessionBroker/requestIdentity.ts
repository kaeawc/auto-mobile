import { createHash } from "node:crypto";
import { stableStringify } from "../../utils/stableStringify";

export const SESSION_REQUEST_ABANDONED_CODE = "session_request_abandoned";
export const SESSION_REQUEST_ABANDONED_MESSAGE =
  "Session request was abandoned by its liveness owner";

const ABANDONED_REQUEST_PARAMETERS = Object.freeze({
  internalReceipt: SESSION_REQUEST_ABANDONED_CODE,
});

export function sessionRequestFingerprint(parameters: unknown, livenessOwnerToken: string): string {
  return createHash("sha256")
    .update(stableStringify({ config: parameters, livenessOwnerToken }))
    .digest("hex");
}

export function abandonedRequestIdentity(livenessOwnerToken: string): {
  fingerprint: string;
  parameters: unknown;
} {
  return {
    fingerprint: sessionRequestFingerprint(ABANDONED_REQUEST_PARAMETERS, livenessOwnerToken),
    parameters: ABANDONED_REQUEST_PARAMETERS,
  };
}
