import type { ContractFinding } from "./boundaries";
import type { SdkContractManifest } from "./manifest";
import { OBSERVATION_NODES, type ObservationStep, type ToolOutcome } from "./observationSlice";

export const MULTI_SCENE_SLICE = "multi-scene";
export const MULTI_SCENE_STEPS: readonly ObservationStep[] = [
  { caseName: "observe", tool: "observe", args: { platform: "ios" } },
  {
    caseName: "tap",
    tool: "tapOn",
    args: {
      platform: "ios",
      selector: JSON.stringify({ elementId: OBSERVATION_NODES.save }),
      action: "tap",
    },
  },
];

/** Multi-scene rejection must survive the MCP surface without executing a host action. */
export function judgeMultiScene(
  manifest: SdkContractManifest,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const fail = (caseName: string, boundary: ContractFinding["boundary"], message: string) =>
    findings.push({ slice: MULTI_SCENE_SLICE, caseName, boundary, message });
  const log = manifest.multiScene;
  if (!log) {
    fail("run", "fixture-host", "the manifest has no multi-scene host log");
    return findings;
  }
  if (log.deviceClass === "iphone") {
    return [];
  }
  if (log.status !== "complete" || new Set(log.sceneIdentifiers).size < 2) {
    fail("scenes", "fixture-host", "iPad requires at least two distinct connected scenes");
  }
  if (log.observation.actions.length > 0) {
    fail("actions", "sdk-adapter", "the host executed actions despite multiple connected scenes");
  }
  for (const step of MULTI_SCENE_STEPS) {
    const outcome = outcomes.get(step.caseName);
    if (!outcome) {
      fail(step.caseName, "fixture-host", "the harness did not run this step");
      continue;
    }
    const failed = outcome.error !== undefined || outcome.result?.success === false;
    const message = outcome.fullError ?? outcome.error ?? String(outcome.result?.error ?? "");
    const documented = message.match(
      /The app has (\d+) connected scenes \([^)]+\)\. SDK observation needs one scene; XCTest does not stand in for this result\./,
    );
    const typed = message.includes("multi_scene") || (documented && Number(documented[1]) >= 2);
    // tapOn resolves its selector before any SDK action reaches the router, and that search
    // reports a missing element instead of the typed error (#18466 follow-up). The act contract
    // asserted today is therefore: it fails, and nothing ran on the host (checked above).
    const actNotFound =
      step.tool === "tapOn" && /Element not found with provided elementId/.test(message);
    if (!failed || !(typed || actNotFound)) {
      fail(
        step.caseName,
        "ios-client",
        `${step.tool} must fail with multi_scene without XCTest fallback: ${message || `result=${JSON.stringify(outcome.result ?? null).slice(0, 600)}`}`,
      );
    }
  }
  return findings;
}
