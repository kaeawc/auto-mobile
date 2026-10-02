import { describe, expect, test } from "bun:test";
import { parseDevicectlFailureEnvelope } from "../../../src/utils/ios-cmdline-tools/devicectlFailureEnvelope";
import { loadDevicectlListFixture } from "../../helpers/devicectlListFixtures";

// Constructed minimal objects, not devicectl output. 1001 has captures below; 1000 still needs captures.
describe("constructed devicectl failure envelopes", () => {
  for (const [code, kind] of [
    [1000, "device-not-found"],
    [1001, "capability-unsupported"],
    [12, "other"],
  ] as const) {
    test(`constructed CoreDevice code ${code} maps to ${kind}`, () => {
      expect(
        parseDevicectlFailureEnvelope({
          info: { outcome: "FAILED" },
          error: { domain: "constructed.cOrEdEvIcE.error", code },
        }),
      ).toEqual({ domain: "constructed.cOrEdEvIcE.error", code, kind });
    });
  }
  test("constructed foreign or absent domains are other; success and missing numeric codes are not failures", () => {
    for (const domain of ["OtherDomain", undefined, 123]) {
      expect(
        parseDevicectlFailureEnvelope({
          info: { outcome: "failed" },
          error: { domain, code: 1000 },
        }),
      ).toEqual({ ...(typeof domain === "string" ? { domain } : {}), code: 1000, kind: "other" });
    }
    for (const data of [
      null,
      [],
      { error: { code: 1000 } },
      { info: { outcome: 1 }, error: { code: 1000 } },
      { info: { outcome: "SUCCESS" }, error: { code: 1000 } },
      { info: { outcome: "failed" }, error: {} },
      { info: { outcome: "failed" }, error: { code: "1000" } },
    ]) {
      expect(parseDevicectlFailureEnvelope(data)).toBeUndefined();
    }
  });
});

describe("captured devicectl 1001 failure envelopes", () => {
  for (const [file, capabilityFeatureId] of [
    ["info-lockstate-booted-simulator-1001.json", "com.apple.coredevice.feature.getlockstate"],
    ["info-lockstate-shutdown-simulator-1001.json", "com.apple.coredevice.feature.getlockstate"],
    [
      "motion-hinge-angle-shutdown-simulator-1001.json",
      "com.apple.coredevice.feature.monitormotion",
    ],
    [
      "motion-hinge-angle-booted-nonduo-simulator-1001.json",
      "com.apple.coredevice.feature.monitormotion",
    ],
    [
      "info-files-appdatacontainer-booted-simulator-1001.json",
      "com.apple.coredevice.feature.listFiles",
    ],
  ] as const) {
    test(`captured ${file} retains only structured failure metadata`, () => {
      expect(parseDevicectlFailureEnvelope(JSON.parse(loadDevicectlListFixture(file)))).toEqual({
        domain: "com.apple.dt.CoreDeviceError",
        code: 1001,
        kind: "capability-unsupported",
        capabilityFeatureId,
      });
    });
  }

  test("captured hinge failures share a feature id despite different descriptions and device identifiers", () => {
    const shutdown = JSON.parse(
      loadDevicectlListFixture("motion-hinge-angle-shutdown-simulator-1001.json"),
    );
    const booted = JSON.parse(
      loadDevicectlListFixture("motion-hinge-angle-booted-nonduo-simulator-1001.json"),
    );
    expect(shutdown.error.userInfo.NSLocalizedDescription).not.toEqual(
      booted.error.userInfo.NSLocalizedDescription,
    );
    expect(shutdown.error.userInfo.DeviceIdentifier).toBeDefined();
    expect(booted.error.userInfo.DeviceIdentifier).toBeUndefined();
    expect(parseDevicectlFailureEnvelope(shutdown)?.capabilityFeatureId).toBe(
      "com.apple.coredevice.feature.monitormotion",
    );
    expect(parseDevicectlFailureEnvelope(booted)).toEqual(parseDevicectlFailureEnvelope(shutdown));
  });

  test("captured successful displays envelope is not a failure", () => {
    expect(
      parseDevicectlFailureEnvelope(
        JSON.parse(loadDevicectlListFixture("info-displays-booted-simulator.json")),
      ),
    ).toBeUndefined();
  });
});

describe("DERIVED in-memory mutations of captured failure envelopes", () => {
  for (const feature of [
    undefined,
    "unwrapped",
    null,
    { string: "" },
    { string: 123 },
    { string: null },
  ]) {
    test(`DERIVED absent or malformed feature ${JSON.stringify(feature)} adds no key`, () => {
      const derived = JSON.parse(
        loadDevicectlListFixture("info-lockstate-booted-simulator-1001.json"),
      );
      if (feature === undefined) {
        delete derived.error.userInfo.CapabilityFeatureIdentifier;
      } else {
        derived.error.userInfo.CapabilityFeatureIdentifier = feature;
      }
      const parsed = parseDevicectlFailureEnvelope(derived);
      expect(parsed).toEqual({
        domain: "com.apple.dt.CoreDeviceError",
        code: 1001,
        kind: "capability-unsupported",
      });
      expect(Object.hasOwn(parsed!, "capabilityFeatureId")).toBe(false);
    });
  }
});
