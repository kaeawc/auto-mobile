import { describe, expect, test } from "bun:test";
import { preparationTimeoutSettled } from "../../scripts/manual-test/brokerDeviceScenarios";
import { NO_PREPARATION_BUDGET_REASON } from "../../src/devices/sessionBrokerResult";

const timeout = { code: "timeout", message: "Session preparation did not finish in time." };

describe("preparationTimeoutSettled", () => {
  test("missing daemon_unavailable request is settled", () => {
    expect(preparationTimeoutSettled({ code: "daemon_unavailable" }, undefined)).toBe(true);
  });

  test("a timeout that never sent prepareSession has no receipt to wait on (#14410)", () => {
    const failure = {
      code: "timeout",
      message: `Session preparation did not finish within its deadline: ${NO_PREPARATION_BUDGET_REASON}`,
    };
    expect(preparationTimeoutSettled(failure, undefined)).toBe(true);
  });

  test.each([timeout, { code: "provision_failed" }])(
    "missing $code request is not settled",
    (failure) => {
      expect(preparationTimeoutSettled(failure, undefined)).toBe(false);
    },
  );

  test("matching failure with completed cleanup is settled", () => {
    expect(
      preparationTimeoutSettled(timeout, {
        failure: { code: "timeout" },
        cleanupPending: false,
      }),
    ).toBe(true);
  });

  test("matching failure with pending cleanup is not settled", () => {
    expect(
      preparationTimeoutSettled(timeout, {
        failure: { code: "timeout" },
        cleanupPending: true,
      }),
    ).toBe(false);
  });

  test("mismatched failure is not settled", () => {
    expect(
      preparationTimeoutSettled(timeout, {
        failure: { code: "provision_failed" },
        cleanupPending: false,
      }),
    ).toBe(false);
  });
});
