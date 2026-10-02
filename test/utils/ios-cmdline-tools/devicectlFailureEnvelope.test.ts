import { describe, expect, test } from "bun:test";
import { parseDevicectlFailureEnvelope } from "../../../src/utils/ios-cmdline-tools/devicectlFailureEnvelope";

// Constructed minimal objects, not devicectl output. Real 1000/1001 envelopes still need captures.
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
