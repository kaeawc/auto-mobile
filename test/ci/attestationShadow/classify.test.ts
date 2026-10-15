import { describe, expect, test } from "bun:test";
import { classifyShadowOutcome } from "../../../src/ci/attestationShadow/classify";

describe("classifyShadowOutcome", () => {
  test("classifies every verdict, result, and attestation combination", () => {
    for (const verdict of ["skip", "advisory", "ignore"] as const) {
      for (const ciResult of ["pass", "fail", "cancelled"] as const) {
        for (const hadAttestation of [false, true]) {
          const outcome = classifyShadowOutcome({
            tier: 1,
            treeHash: "h",
            runId: "r",
            verdict,
            ciResult,
            hadAttestation,
          });
          const expected =
            ciResult === "cancelled"
              ? "excluded"
              : verdict === "skip" && ciResult === "fail"
                ? "false-hit"
                : verdict !== "skip" && hadAttestation && ciResult === "pass"
                  ? "false-miss"
                  : "agree";
          expect(outcome).toBe(expected);
        }
      }
    }
  });
});
