import { describe, expect, test } from "bun:test";
import {
  aggregateVerdict,
  attribute,
  countOutcomes,
  describeAttribution,
  errorScore,
  scoreReplay,
  type ReplayScore,
} from "../../../scripts/persona-robustness/score";

const pass: ReplayScore = { outcome: "pass", skippedSteps: 0, warningSteps: 0 };
const recovered: ReplayScore = { outcome: "recovered", skippedSteps: 1, warningSteps: 0 };
const failed: ReplayScore = {
  outcome: "failed",
  skippedSteps: 0,
  warningSteps: 0,
  failedStep: { stepIndex: 2, tool: "tapOn", error: "not found" },
};

describe("scoreReplay", () => {
  test("a clean success is pass", () => {
    expect(scoreReplay({ success: true, executedSteps: 3, totalSteps: 3 })).toEqual(pass);
  });

  test("a success with skipped optional steps or warnings is recovered", () => {
    expect(
      scoreReplay({ success: true, skippedSteps: [{ stepIndex: 1, tool: "tapOn", error: "x" }] })
        .outcome,
    ).toBe("recovered");
    expect(
      scoreReplay({ success: true, warnings: [{ stepIndex: 0, tool: "observe", warnings: ["w"] }] })
        .outcome,
    ).toBe("recovered");
  });

  test("a failure names the failing step", () => {
    expect(
      scoreReplay({
        success: false,
        failedStep: { stepIndex: 2, tool: "tapOn", error: "not found", failureObservation: {} },
      }),
    ).toEqual(failed);
  });

  test("a failure without a failed step keeps the plan error", () => {
    expect(scoreReplay({ success: false, error: "validation failed" })).toEqual({
      outcome: "failed",
      skippedSteps: 0,
      warningSteps: 0,
      error: "validation failed",
    });
  });

  test("a payload without success is a harness error", () => {
    expect(scoreReplay({ message: "?" }).outcome).toBe("error");
    expect(scoreReplay(undefined).outcome).toBe("error");
  });

  test("long errors are truncated", () => {
    expect(errorScore("x".repeat(1000)).error?.length).toBeLessThan(310);
  });
});

describe("aggregateVerdict", () => {
  test("uniform outcomes keep their verdict", () => {
    expect(aggregateVerdict([pass, pass])).toBe("pass");
    expect(aggregateVerdict([failed, failed])).toBe("failed");
  });

  test("pass mixed with recovered is recovered", () => {
    expect(aggregateVerdict([pass, recovered])).toBe("recovered");
  });

  test("failure mixed with success is flaky", () => {
    expect(aggregateVerdict([pass, failed])).toBe("flaky");
  });

  test("any harness error, or no runs, is error", () => {
    expect(aggregateVerdict([pass, errorScore("apply failed")])).toBe("error");
    expect(aggregateVerdict([])).toBe("error");
  });

  test("countOutcomes counts each outcome", () => {
    expect(countOutcomes([pass, failed, failed])).toEqual({
      pass: 1,
      recovered: 0,
      failed: 2,
      error: 0,
    });
  });
});

describe("attribute", () => {
  const base = { facets: ["kill:x", "display:cutout=hole"], singleFacet: false };

  test("a success needs no attribution", () => {
    expect(attribute({ ...base, verdict: "recovered", baselineVerdict: "pass" })).toEqual({
      kind: "none",
    });
  });

  test("a failure is not attributable when the baseline fails too", () => {
    const result = attribute({ ...base, verdict: "failed", baselineVerdict: "flaky" });
    expect(result.kind).toBe("not-attributable");
    expect(describeAttribution(result)).toContain("baseline itself is flaky");
  });

  test("a harness error is not attributable", () => {
    expect(attribute({ ...base, verdict: "error", baselineVerdict: "pass" }).kind).toBe(
      "not-attributable",
    );
  });

  test("a single-facet perturbation is its own cause", () => {
    expect(
      attribute({
        facets: ["display:fontScale=1.3"],
        singleFacet: true,
        verdict: "failed",
        baselineVerdict: "pass",
      }),
    ).toEqual({ kind: "perturbation", facets: ["display:fontScale=1.3"] });
  });

  test("without ablation the cause is one of the persona's facets", () => {
    const result = attribute({ ...base, verdict: "failed", baselineVerdict: "pass" });
    expect(result.kind).toBe("not-ablated");
    expect(describeAttribution(result)).toContain("--ablate");
  });

  test("ablation names the facets that fail alone, flaky included", () => {
    expect(
      attribute({
        ...base,
        verdict: "failed",
        baselineVerdict: "pass",
        ablation: [
          { facets: ["kill:x"], verdict: "pass" },
          { facets: ["display:cutout=hole"], verdict: "flaky" },
        ],
      }),
    ).toEqual({ kind: "facets", facets: ["display:cutout=hole"] });
  });

  test("no facet failing alone is an interaction", () => {
    expect(
      attribute({
        ...base,
        verdict: "failed",
        baselineVerdict: "pass",
        ablation: [
          { facets: ["kill:x"], verdict: "pass" },
          { facets: ["display:cutout=hole"], verdict: "error" },
        ],
      }).kind,
    ).toBe("interaction");
  });
});
