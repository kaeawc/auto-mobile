import { describe, expect, test } from "bun:test";
import type {
  ObservationHostAction,
  SdkContractManifest,
} from "../../../scripts/ios/sdk-contract/manifest";
import {
  OBSERVATION_STEPS,
  TYPED_TEXT,
  judgeObservationCases,
  type ToolOutcome,
} from "../../../scripts/ios/sdk-contract/observationSlice";

const hostTap = (elementId: string, identity: number): ObservationHostAction => ({
  kind: "tap",
  elementId,
  observationIdentity: identity,
});

/** The host log of a run where every step behaved. */
const healthyActions: ObservationHostAction[] = [
  hostTap("contract-save", 3),
  { kind: "clearText", elementId: "contract-email", observationIdentity: 5 },
  { kind: "insertText", elementId: "contract-email", observationIdentity: 6, text: TYPED_TEXT },
  hostTap("contract-arm-stale", 9),
];

function manifest(actions = healthyActions): SdkContractManifest {
  return {
    schemaVersion: 3,
    runId: "run-1",
    scenario: "observe",
    status: "complete",
    network: [],
    faults: [],
    observation: { captures: 12, actions },
    events: [],
    undecodableBatches: 0,
  };
}

const sdkTap: ToolOutcome = { result: { success: true, backend: "sdk" } };

function healthyOutcomes(): Map<string, ToolOutcome> {
  return new Map<string, ToolOutcome>([
    [
      "observe",
      {
        result: {
          backend: "sdk",
          viewHierarchy: {
            node: { $: { "resource-id": "contract-save", "sdk-element-id": "contract-save" } },
          },
        },
      },
    ],
    ["tap", sdkTap],
    ["send-keys", { result: { success: true, commands: [{ success: true, backend: "sdk" }] } }],
    [
      "unsupported-long-press",
      { result: { success: true, backend: "xctest", fallbackReason: "unsupported" } },
    ],
    ["arm-stale", sdkTap],
    [
      "stale-tap",
      { error: "The app's SDK observation bridge rejected the tap (stale_observation)." },
    ],
  ]);
}

function judge(
  overrides: Record<string, ToolOutcome> = {},
  actions: ObservationHostAction[] = healthyActions,
) {
  const outcomes = healthyOutcomes();
  for (const [caseName, outcome] of Object.entries(overrides)) {
    outcomes.set(caseName, outcome);
  }
  return judgeObservationCases(manifest(actions), outcomes);
}

describe("observation slice (#5164 phase B)", () => {
  test("the steps run the long press before the stale trap", () => {
    const names = OBSERVATION_STEPS.map((step) => step.caseName);
    expect(names.indexOf("unsupported-long-press")).toBeLessThan(names.indexOf("arm-stale"));
    expect(names.at(-1)).toBe("stale-tap");
  });

  test("a healthy run has no findings", () => {
    expect(judge()).toEqual([]);
  });

  test("observe without the bridge names the endpoint; without its nodes, the client", () => {
    expect(
      judge({ observe: { result: { backend: "xctest", fallbackReason: "unavailable" } } }),
    ).toEqual([expect.objectContaining({ caseName: "observe", boundary: "sdk-endpoint" })]);
    expect(judge({ observe: { result: { backend: "sdk", viewHierarchy: {} } } })).toEqual([
      expect.objectContaining({ caseName: "observe", boundary: "ios-client" }),
    ]);
  });

  test("a tap the host ran but the tool misreported names the MCP surface", () => {
    expect(judge({ tap: { result: { success: true, backend: "xctest" } } })).toEqual([
      expect.objectContaining({ caseName: "tap", boundary: "mcp-surface" }),
    ]);
  });

  test("a tap the host never ran is attributed by what the tool reported", () => {
    const withoutTap = healthyActions.filter((action) => action.elementId !== "contract-save");
    expect(
      judge(
        { tap: { result: { success: true, backend: "xctest", fallbackReason: "unavailable" } } },
        withoutTap,
      ),
    ).toEqual([expect.objectContaining({ caseName: "tap", boundary: "sdk-endpoint" })]);
    expect(judge({}, withoutTap)).toEqual([
      expect.objectContaining({ caseName: "tap", boundary: "ctrlproxy-command" }),
    ]);
    expect(judge({ tap: { result: { success: true } } }, withoutTap)).toEqual([
      expect.objectContaining({ caseName: "tap", boundary: "ios-client" }),
    ]);
  });

  test("sendKeys is judged on its command's backend and the host's insertText", () => {
    const withoutInsert = healthyActions.filter((action) => action.kind !== "insertText");
    expect(judge({}, withoutInsert)).toEqual([
      expect.objectContaining({ caseName: "send-keys", boundary: "ctrlproxy-command" }),
    ]);
  });

  test("an undeclared action reaching the bridge, or no unsupported fallback, is a finding", () => {
    expect(
      judge({}, [
        ...healthyActions,
        { kind: "longPress", elementId: "contract-hold", observationIdentity: 7 },
      ]),
    ).toEqual([
      expect.objectContaining({ caseName: "unsupported-long-press", boundary: "sdk-adapter" }),
    ]);
    expect(
      judge({ "unsupported-long-press": { result: { success: true, backend: "xctest" } } }),
    ).toEqual([
      expect.objectContaining({ caseName: "unsupported-long-press", boundary: "ios-client" }),
    ]);
  });

  test("a stale target that succeeded, or ran on the host, never passes", () => {
    expect(judge({ "stale-tap": sdkTap })).toEqual([
      expect.objectContaining({ caseName: "stale-tap", boundary: "ios-client" }),
    ]);
    expect(judge({ "stale-tap": { result: { success: true, backend: "xctest" } } })).toEqual([
      expect.objectContaining({ caseName: "stale-tap", boundary: "ios-client" }),
    ]);
    expect(judge({}, [...healthyActions, hostTap("contract-save", 11)])).toEqual([
      expect.objectContaining({ caseName: "stale-tap", boundary: "sdk-adapter" }),
    ]);
    expect(judge({ "stale-tap": { error: "rejected the tap (unknown_element)" } })).toEqual([
      expect.objectContaining({ caseName: "stale-tap", boundary: "ios-client" }),
    ]);
  });

  test("an unarmed trap or a missing host log is a fixture-host failure", () => {
    const unarmed = healthyActions.filter((action) => action.elementId !== "contract-arm-stale");
    expect(
      judge({ "arm-stale": { result: { success: true, backend: "xctest" } } }, unarmed),
    ).toContainEqual(expect.objectContaining({ caseName: "stale-tap", boundary: "fixture-host" }));
    const noLog = { ...manifest(), observation: undefined };
    expect(judgeObservationCases(noLog, healthyOutcomes())).toEqual([
      expect.objectContaining({ boundary: "fixture-host" }),
    ]);
  });
});
