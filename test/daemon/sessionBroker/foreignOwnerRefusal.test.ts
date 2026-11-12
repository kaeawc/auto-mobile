import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { foreignOwnerRefusal } from "../../../src/daemon/sessionBroker/brokerSupport";
import { SessionRequestForeignOwnerError } from "../../../src/daemon/sessionBroker/SessionRequestForeignOwnerError";
import { SESSION_REQUEST_ABANDONED_CODE } from "../../../src/daemon/sessionBroker/requestIdentity";
import type {
  BrokerRequestRecord,
  BrokerRequestState,
  BrokerResourceRecord,
} from "../../../src/daemon/sessionBroker/store";

const REQUEST_STATES: BrokerRequestState[] = [
  "acquiring",
  "active",
  "releasing",
  "released",
  "failed",
];
const RESOURCE_STATES: BrokerResourceRecord["state"][] = [
  "reserved",
  "active",
  "idle",
  "resetting",
  "destroying",
  "unknown",
  "destroyed",
];
const CLEANUP_STATES = new Set<BrokerResourceRecord["state"]>([
  "destroying",
  "resetting",
  "unknown",
]);

function request(state: BrokerRequestState, errorCode: string | null): BrokerRequestRecord {
  return {
    requestId: "request-1",
    fingerprint: "owner-fingerprint",
    parameters: {},
    owner: { daemonId: "daemon", pid: 1 },
    state,
    resourceId: "resource-1",
    sessionId: "session-1",
    error: errorCode ? "failed" : null,
    errorCode,
    retryable: false,
  };
}

function resource(
  state: BrokerResourceRecord["state"],
  requestId: string | null,
): BrokerResourceRecord {
  return {
    resourceId: "resource-1",
    allocationIndex: 0,
    scopeKey: "scope",
    profile: {},
    state,
    requestId,
    revision: 1,
    idleOrder: 0,
  };
}

describe("foreign-owner refusal (#18150)", () => {
  test("terminal is true exactly for released, or failed with no cleanup in flight", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REQUEST_STATES),
        fc.option(fc.constantFrom(...RESOURCE_STATES), { nil: undefined }),
        fc.constantFrom("request-1", "other-request", null),
        fc.constantFrom(SESSION_REQUEST_ABANDONED_CODE, "session_preparation_failed", null),
        fc.boolean(),
        (state, resourceState, holder, errorCode, preparing) => {
          const held = resourceState === undefined ? undefined : resource(resourceState, holder);
          const refusal = foreignOwnerRefusal(request(state, errorCode), held, preparing);
          const cleanupInFlight =
            (held !== undefined &&
              held.requestId === "request-1" &&
              CLEANUP_STATES.has(held.state)) ||
            (errorCode === SESSION_REQUEST_ABANDONED_CODE && preparing);
          const expected = state === "released" || (state === "failed" && !cleanupInFlight);
          expect(refusal).toBeInstanceOf(SessionRequestForeignOwnerError);
          expect(refusal.terminal).toBe(expected);
          expect(refusal.code).toBe("session_request_owner_mismatch");
          expect(refusal.message).toMatch(/another liveness owner/);
          expect(refusal.retryable).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("the refusal carries no session, device or failure fields", () => {
    const refusal = foreignOwnerRefusal(
      request("active", null),
      resource("active", "request-1"),
      false,
    );
    expect(JSON.stringify(refusal)).not.toContain("session-1");
    expect(JSON.stringify(refusal)).not.toContain("resource-1");
  });
});
