import { describe, expect, test } from "bun:test";
import {
  EXPECTED_AFTER_REGISTRATION,
  EXPECTED_BEFORE_REGISTRATION,
  judgeCapabilities,
  judgeHostParser,
} from "../../../scripts/ios/sdk-contract/capabilitySlice";
import type {
  SdkContractManifest,
  TransportDescriptor,
} from "../../../scripts/ios/sdk-contract/manifest";

/** Descriptors as the Swift encoder writes them: nil reason omitted, empty actions kept. */
const encode = (descriptors: readonly TransportDescriptor[]): TransportDescriptor[] =>
  descriptors.map(({ reason, ...rest }) => ({
    ...rest,
    faultActions: rest.faultActions ?? [],
    ...(reason ? { reason } : {}),
  }));

function manifest(
  capabilities: SdkContractManifest["capabilities"] = {
    beforeRegistration: encode(EXPECTED_BEFORE_REGISTRATION),
    afterRegistration: encode(EXPECTED_AFTER_REGISTRATION),
  },
): SdkContractManifest {
  return {
    schemaVersion: 3,
    runId: "c1",
    scenario: "capabilities",
    status: "complete",
    network: [],
    faults: [],
    capabilities,
    events: [],
    undecodableBatches: 0,
  };
}

describe("judgeCapabilities", () => {
  test("passes when each family matches its registration", () => {
    expect(judgeCapabilities(manifest())).toEqual([]);
  });

  test("covers registered, host-opt-in and unsupported families", () => {
    const states = EXPECTED_AFTER_REGISTRATION.map((item) => [item.state, item.reason ?? null]);
    expect(states).toContainEqual(["SUPPORTED", null]);
    expect(states).toContainEqual(["DISABLED", "HOST_OPT_IN"]);
    expect(states).toContainEqual(["UNSUPPORTED", "NO_ADAPTER"]);
  });

  test("blames the SDK for a registered family that still reads as host opt-in", () => {
    const after = encode(EXPECTED_AFTER_REGISTRATION).map((item) =>
      item.id === "network.transport.websocket"
        ? { ...item, state: "DISABLED", reason: "HOST_OPT_IN" }
        : item,
    );
    const findings = judgeCapabilities(
      manifest({
        beforeRegistration: encode(EXPECTED_BEFORE_REGISTRATION),
        afterRegistration: after,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      slice: "capabilities",
      caseName: "after-registration/network.transport.websocket",
      boundary: "sdk-adapter",
    });
    expect(findings[0].message).toContain('state: expected "SUPPORTED", got "DISABLED"');
  });

  test("blames the SDK for claiming a fault action it does not apply", () => {
    const after = encode(EXPECTED_AFTER_REGISTRATION).map((item) =>
      item.id === "network.transport.nwconnection"
        ? { ...item, faultActions: ["closeConnection", "error", "latency", "response"] }
        : item,
    );
    const [finding] = judgeCapabilities(
      manifest({
        beforeRegistration: encode(EXPECTED_BEFORE_REGISTRATION),
        afterRegistration: after,
      }),
    );
    expect(finding.message).toContain("faultActions");
  });

  test("reports missing and unknown families", () => {
    const before = encode(EXPECTED_BEFORE_REGISTRATION).filter(
      (item) => item.id !== "network.transport.other",
    );
    const after = [
      ...encode(EXPECTED_AFTER_REGISTRATION),
      { id: "network.transport.grpc", state: "SUPPORTED" },
    ];
    const findings = judgeCapabilities(
      manifest({ beforeRegistration: before, afterRegistration: after }),
    );
    expect(findings.map((finding) => [finding.caseName, finding.message])).toEqual([
      ["before-registration/network.transport.other", "missing"],
      [
        "after-registration/network.transport.grpc",
        "the SDK reported a transport family the contract does not know",
      ],
    ]);
  });

  test("blames the fixture host when no capability observation was written", () => {
    const withoutCapabilities = { ...manifest(), capabilities: undefined };
    expect(judgeCapabilities(withoutCapabilities)[0].boundary).toBe("fixture-host");
  });
});

describe("judgeHostParser", () => {
  test("reads the iOS descriptors through the shared host parser", () => {
    expect(judgeHostParser("after", encode(EXPECTED_AFTER_REGISTRATION))).toEqual([]);
  });

  test("blames the iOS client when the host parser rejects a descriptor", () => {
    const [finding] = judgeHostParser("after", [{ id: "", state: "SUPPORTED" }]);
    expect(finding).toMatchObject({ caseName: "after/host-parser", boundary: "ios-client" });
  });

  test("blames the iOS client when the host parser changes a state", () => {
    const [finding] = judgeHostParser("after", [{ id: "network.transport.x", state: "LATER" }]);
    expect(finding.boundary).toBe("ios-client");
    expect(finding.message).toContain('"UNKNOWN"');
  });
});
