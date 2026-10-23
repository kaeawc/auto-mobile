import { expect, test } from "bun:test";
import { classifyCleanReleaseError } from "../../../src/daemon/sessionBroker/cleanReleaseFailure";
import { drainFailureOutcome } from "../../../src/daemon/sessionBroker/brokerSupport";
import { ResetFailureError } from "../../../src/daemon/sessionBroker/ResetFailureError";
import { SessionBrokerInvariantError } from "../../../src/daemon/sessionBroker/SessionBrokerInvariantError";
import { ActionableError } from "../../../src/models/ActionableError";
import { BootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";

const discovery = new BootedDeviceDiscoveryIncompleteError("ios", {
  code: "timeout",
  message: "timed out after 15000ms collecting iOS simulator capacity",
  retryable: true,
});

test.each([
  discovery,
  new ActionableError("reservation failed", { cause: discovery }),
  new ResetFailureError(
    "reset failed",
    { outcome: "pending", mode: "erase", phases: {} },
    { cause: discovery },
  ),
])("incomplete discovery stays retryable through reset wrappers: %s", (error) => {
  expect(classifyCleanReleaseError(error)).toBe("retryable");
  expect(drainFailureOutcome(error, "sess", false)).toBe("pending");
});

test("an invariant wrapping incomplete discovery takes permanent precedence", () => {
  const error = new SessionBrokerInvariantError("lost ownership", { cause: discovery });
  expect(classifyCleanReleaseError(error)).toBe("permanent");
  expect(drainFailureOutcome(error, "sess", false)).toBe("destroy");
});

test.each([
  ["android discovery", new BootedDeviceDiscoveryIncompleteError("android", undefined)],
  [
    "non-retryable iOS discovery",
    new BootedDeviceDiscoveryIncompleteError("ios", {
      code: "failed",
      message: "discovery cannot recover",
      retryable: false,
    }),
  ],
] as const)("%s keeps the unknown failure outcome", (_description, error) => {
  expect(classifyCleanReleaseError(error)).toBe("unknown");
  expect(drainFailureOutcome(error, "sess", false)).toBe("destroy");
});
