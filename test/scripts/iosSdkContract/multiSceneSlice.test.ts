import { expect, test } from "bun:test";
import type { SdkContractManifest } from "../../../scripts/ios/sdk-contract/manifest";
import {
  MULTI_SCENE_SLICE,
  MULTI_SCENE_STEPS,
  judgeMultiScene,
} from "../../../scripts/ios/sdk-contract/multiSceneSlice";
import type { ToolOutcome } from "../../../scripts/ios/sdk-contract/observationSlice";

function manifest(): SdkContractManifest {
  return {
    schemaVersion: 4,
    scenario: MULTI_SCENE_SLICE,
    runId: "fake",
    status: "complete",
    network: [],
    faults: [],
    events: [],
    undecodableBatches: 0,
    multiScene: {
      deviceClass: "ipad",
      status: "complete",
      sceneIdentifiers: ["a", "b"],
      observation: { captures: 0, actions: [] },
    },
  };
}

function outcomes(outcome: ToolOutcome = { error: "multi_scene" }): Map<string, ToolOutcome> {
  return new Map(MULTI_SCENE_STEPS.map((step) => [step.caseName, outcome]));
}

const message = (count: number) =>
  `The app has ${count} connected scenes (a, b). SDK observation needs one scene; XCTest does not stand in for this result.`;

test("drives observe and the contract save tap with iOS arguments", () => {
  expect(MULTI_SCENE_STEPS).toEqual([
    { caseName: "observe", tool: "observe", args: { platform: "ios" } },
    {
      caseName: "tap",
      tool: "tapOn",
      args: { platform: "ios", selector: '{"elementId":"contract-save"}', action: "tap" },
    },
  ]);
});

test("accepts the typed reason, documented message and structured failure", () => {
  for (const outcome of [
    { error: "IosSdkMultiSceneError: multi_scene" },
    { error: message(2) },
    { error: message(3) },
    { result: { success: false, error: "multi_scene" } },
  ]) {
    expect(judgeMultiScene(manifest(), outcomes(outcome))).toEqual([]);
  }
});

for (const backend of ["xctest", "sdk", undefined]) {
  test(`rejects success with backend ${backend}, even with multi_scene text`, () => {
    expect(
      judgeMultiScene(
        manifest(),
        outcomes({ result: { success: true, backend, error: "multi_scene" } }),
      ),
    ).toHaveLength(2);
  });
}

test("rejects unrelated failures, missing results and invalid scene counts", () => {
  for (const outcome of [
    { error: "unavailable" },
    { error: message(1) },
    { error: "The app has 2 connected scenes" },
    {},
  ]) {
    expect(judgeMultiScene(manifest(), outcomes(outcome))).toHaveLength(2);
  }
  expect(judgeMultiScene(manifest(), new Map())).toHaveLength(2);
});

test("judges each tool independently", () => {
  const calls = outcomes();
  calls.set("tap", { result: { success: true, backend: "xctest" } });
  expect(judgeMultiScene(manifest(), calls)).toMatchObject([
    { caseName: "tap", boundary: "ios-client" },
  ]);
});

test("requires the host log and two distinct scene identifiers on iPad", () => {
  const input = manifest();
  delete input.multiScene;
  expect(judgeMultiScene(input, outcomes())).toMatchObject([{ boundary: "fixture-host" }]);
  for (const sceneIdentifiers of [["a"], ["a", "a"]]) {
    const input = manifest();
    input.multiScene!.sceneIdentifiers = sceneIdentifiers;
    expect(judgeMultiScene(input, outcomes())).toMatchObject([{ caseName: "scenes" }]);
  }
  const incomplete = manifest();
  incomplete.multiScene!.status = "not-applicable";
  expect(judgeMultiScene(incomplete, outcomes())).toMatchObject([{ caseName: "scenes" }]);
});

test("rejects any executed action even when both tools fail correctly", () => {
  const input = manifest();
  input.multiScene!.observation.actions.push({
    kind: "tap",
    elementId: "contract-save",
    observationIdentity: 1,
  });
  expect(judgeMultiScene(input, outcomes())).toMatchObject([
    { caseName: "actions", boundary: "sdk-adapter" },
  ]);
});

test("iPhone is not applicable and needs no tool outcomes", () => {
  const input = manifest();
  input.multiScene = {
    deviceClass: "iphone",
    status: "not-applicable",
    sceneIdentifiers: ["a"],
    observation: { captures: 0, actions: [] },
  };
  expect(judgeMultiScene(input, new Map())).toEqual([]);
});

test("accepts a not-found tapOn only for the tap step", () => {
  const notFound = {
    error: "Failed to perform tap on element: Element not found with provided elementId 'x'",
  };
  const mixed = outcomes();
  mixed.set("tap", notFound);
  expect(judgeMultiScene(manifest(), mixed)).toEqual([]);
  mixed.set("observe", notFound);
  expect(judgeMultiScene(manifest(), mixed)).toHaveLength(1);
});
