import { describe, expect, test } from "bun:test";
import {
  parseSdkCapabilitiesState,
  sdkCapabilitiesUnavailable,
} from "../../../src/features/sdk/sdkCapabilities";

const snapshot = {
  schemaVersion: 1,
  capabilities: [{ id: "network.control", state: "SUPPORTED" }],
  policy: { captureHeaders: true, captureBodies: false, allowMutations: false },
};

const okWith = (capability: Record<string, unknown>) => ({
  outcome: "ok",
  snapshot: { schemaVersion: 1, capabilities: [capability], policy: {} },
});

describe("parseSdkCapabilitiesState", () => {
  test("accepts a partial capability set and keeps the policy", () => {
    expect(parseSdkCapabilitiesState({ outcome: "ok", snapshot })).toEqual({
      status: "available",
      snapshot: { ...snapshot, capabilities: [{ id: "network.control", state: "SUPPORTED" }] },
    });
  });

  test("an unknown capability state degrades to UNKNOWN and a newer version is preserved", () => {
    const result = parseSdkCapabilitiesState({
      outcome: "ok",
      snapshot: {
        ...snapshot,
        schemaVersion: 7,
        capabilities: [{ id: "x.y", state: "BRAND_NEW", reason: null }],
      },
    });
    expect(result).toEqual({
      status: "available",
      snapshot: {
        ...snapshot,
        schemaVersion: 7,
        capabilities: [{ id: "x.y", state: "UNKNOWN", reason: null }],
      },
    });
  });

  test("omitted policy flags default to the safe false values", () => {
    const result = parseSdkCapabilitiesState({
      outcome: "ok",
      snapshot: { schemaVersion: 1, capabilities: [], policy: {} },
    });
    expect(result).toEqual({
      status: "available",
      snapshot: {
        schemaVersion: 1,
        capabilities: [],
        policy: { captureHeaders: false, captureBodies: false, allowMutations: false },
      },
    });
  });

  test.each([
    ["non-object state", "nope"],
    ["missing outcome", {}],
    ["ok without snapshot", { outcome: "ok" }],
    ["version zero", { outcome: "ok", snapshot: { ...snapshot, schemaVersion: 0 } }],
    [
      "quoted policy flag",
      { outcome: "ok", snapshot: { ...snapshot, policy: { captureBodies: "true" } } },
    ],
    ["missing policy", { outcome: "ok", snapshot: { schemaVersion: 1, capabilities: [] } }],
    ["missing capability state", okWith({ id: "x.y" })],
    ["numeric capability state", okWith({ id: "x.y", state: 42 })],
    ["null capability state", okWith({ id: "x.y", state: null })],
    ["unknown outcome", { outcome: "corrupt", reason: "BRIDGE_NOT_INSTALLED" }],
  ])("%s is malformed, never an empty capability set", (_name, raw) => {
    expect(parseSdkCapabilitiesState(raw)).toEqual(
      sdkCapabilitiesUnavailable("MALFORMED_RESPONSE"),
    );
  });

  test("forwards a known unavailable reason and generalises an unknown one", () => {
    expect(
      parseSdkCapabilitiesState({ outcome: "unavailable", reason: "BRIDGE_NOT_INSTALLED" }),
    ).toEqual(sdkCapabilitiesUnavailable("BRIDGE_NOT_INSTALLED"));
    expect(parseSdkCapabilitiesState({ outcome: "unavailable", reason: "SOMETHING_NEW" })).toEqual(
      sdkCapabilitiesUnavailable("BRIDGE_UNAVAILABLE"),
    );
    expect(parseSdkCapabilitiesState({ outcome: "unavailable" })).toEqual(
      sdkCapabilitiesUnavailable("BRIDGE_UNAVAILABLE"),
    );
  });
});
