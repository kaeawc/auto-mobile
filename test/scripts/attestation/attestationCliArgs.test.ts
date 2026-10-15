import { describe, expect, test } from "bun:test";
import { parseGateSpec } from "../../../scripts/ci/attestation/cliArgs";
describe("attestation CLI gate parser", () => {
  test("accepts valid gate specs", () => {
    expect(parseGateSpec("lint=pass:1.5")).toEqual({
      name: "lint",
      status: "pass",
      durationSeconds: 1.5,
    });
  });
  test("rejects malformed gate specs", () => {
    for (const value of ["=pass:1", "lint=unknown:1", "lint=pass:-1", "lint=pass:nope"]) {
      expect(() => parseGateSpec(value)).toThrow();
    }
  });
});

test("gate statuses are case insensitive", () => {
  expect(parseGateSpec("lint=PASS:0").status).toBe("pass");
  expect(parseGateSpec("lint=FaIl:0").status).toBe("fail");
  expect(parseGateSpec("lint=SKIP:0").status).toBe("skip");
});
