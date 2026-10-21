import { describe, expect, test } from "bun:test";
import { preparationTimeoutSettled } from "../../scripts/manual-test/brokerDeviceScenarios";

describe("preparationTimeoutSettled", () => {
  test("missing daemon_unavailable request is settled", () => {
    expect(preparationTimeoutSettled("daemon_unavailable", undefined)).toBe(true);
  });

  test.each(["timeout", "provision_failed"])("missing %s request is not settled", (code) => {
    expect(preparationTimeoutSettled(code, undefined)).toBe(false);
  });

  test("matching failure with completed cleanup is settled", () => {
    expect(
      preparationTimeoutSettled("timeout", {
        failure: { code: "timeout" },
        cleanupPending: false,
      }),
    ).toBe(true);
  });

  test("matching failure with pending cleanup is not settled", () => {
    expect(
      preparationTimeoutSettled("timeout", {
        failure: { code: "timeout" },
        cleanupPending: true,
      }),
    ).toBe(false);
  });

  test("mismatched failure is not settled", () => {
    expect(
      preparationTimeoutSettled("timeout", {
        failure: { code: "provision_failed" },
        cleanupPending: false,
      }),
    ).toBe(false);
  });
});
