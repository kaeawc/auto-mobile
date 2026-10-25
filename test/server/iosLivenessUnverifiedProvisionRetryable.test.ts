import { describe, expect, test } from "bun:test";
import { knownProvisionDeviceError } from "../../src/server/deviceTools";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { logger } from "../../src/utils/logger";
import { shapeToolCallError } from "../../src/daemon/shapeToolCallError";

// #15289: a `simctl list` timeout while verifying a pooled simulator is transient.
const error = new BootedDeviceDiscoveryIncompleteError(
  "ios",
  undefined,
  "Unable to verify iOS simulator 'sim-1' is still booted before assignment.",
  5_000,
);

describe("unverifiable iOS liveness is a retryable provision failure (#15289)", () => {
  test("provisionDevice reports discovery_incomplete with retryable true and retryAfterMs", () => {
    const provisioned = knownProvisionDeviceError(error);
    expect(provisioned).toMatchObject({
      code: "discovery_incomplete",
      retryable: true,
      diagnostics: { retryAfterMs: 5_000 },
    });
  });

  test("a hint-less discovery_incomplete adds no retryAfterMs", () => {
    const provisioned = knownProvisionDeviceError(
      new BootedDeviceDiscoveryIncompleteError("ios", undefined),
    );
    expect(provisioned?.diagnostics).toEqual({});
  });

  test("other tools surface the wait hint in the typed payload", () => {
    const original = logger.error;
    logger.error = () => {};
    try {
      const shaped = shapeToolCallError(error, { toolName: "startDevice", source: "MCP" });
      const body = JSON.parse((shaped.content[0] as { text: string }).text);
      expect(body).toMatchObject({
        code: "discovery_incomplete",
        retryable: true,
        retryAfterMs: 5_000,
      });
    } finally {
      logger.error = original;
    }
  });
});
