import { ResetCapacityWaitExceededError } from "../../../src/models/ResetCapacityWaitExceededError";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
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

test("bounded reset capacity wait destroys while ordinary capacity remains pending", () => {
  const cause = new BootCapacityExhaustedError(
    { platform: "ios", limit: 2, booted: 2, retryAfterMs: 1000 },
    "full",
  );
  const error = new ResetCapacityWaitExceededError("device", 60_000, cause);
  expect(drainFailureOutcome(error, "sess", false)).toBe("destroy");
  expect(drainFailureOutcome(error, "sess", true)).toBe("destroy");
  expect(drainFailureOutcome(cause, "sess", false)).toBe("pending");
});

test("native timeout before reset is still pending", () => {
  expect(drainFailureOutcome(new SimctlCommandTimeoutError("timeout"), "sess", false)).toBe(
    "pending",
  );
});

test("terminal capacity error omits the external-owner sentence when none are reported", () => {
  const cause = new BootCapacityExhaustedError(
    { platform: "ios", limit: 1, booted: 1, retryAfterMs: 1000 },
    "full",
  );
  const error = new ResetCapacityWaitExceededError("device", 60_000, cause);
  expect(error).toBeInstanceOf(ActionableError);
  expect(error.message).not.toContain("no AutoMobile owner");
  expect(error.message).toContain("AUTOMOBILE_IOS_SIM_MAX_BOOTED");
  expect(error.message).toContain("xcrun simctl shutdown <udid>");
});
