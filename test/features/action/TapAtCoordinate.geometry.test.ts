import { expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { createTapAt, observation } from "../../helpers/tapAtCoordinate";
import { McpCallRecorder } from "../../../src/features/record/McpCallRecorder";
import { YamlPlanSerializer } from "../../../src/utils/plan/PlanSerializer";
import * as yaml from "js-yaml";

for (const platform of ["android", "ios"] as const) {
  test(`${platform} native recording/serialization/replay round trip`, async () => {
    const device = { deviceId: "test", name: "test", platform };
    const point = platform === "android" ? { x: 2, y: 3 } : { x: 2.125, y: 3.75 };
    const context = {};
    const first = createTapAt(device);
    await first.tapAt.execute(point, undefined, undefined, context);
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("tapAt", {
      ...point,
      snapshotId: "ephemeral",
      __tapAtRecordingContext: context,
    });
    const [step] = recorder.stop();
    expect(step.geometry).toEqual({
      platform,
      deviceWidth: 10,
      deviceHeight: 10,
      orientation: 0,
      ...point,
    });
    expect(step.params).toEqual(point);
    const plan = new YamlPlanSerializer().importPlanFromYaml(
      yaml.dump({ name: "native", steps: [step] }),
    );
    expect(plan.steps[0]).toEqual(step);
    const replay = createTapAt(device);
    const result = await replay.tapAt.execute(point, undefined, undefined, {
      geometry: plan.steps[0].geometry,
    });
    expect(result.success).toBe(true);
    expect(platform === "android" ? replay.androidDispatches : replay.iosDispatches).toMatchObject([
      point,
    ]);
  });
}

for (const mismatch of ["platform", "dimensions", "orientation", "point"] as const) {
  test(`geometry ${mismatch} mismatch fails before tap`, async () => {
    const { tapAt, observeScreen, androidDispatches } = createTapAt({
      deviceId: "test",
      name: "test",
      platform: "android",
    });
    const geometry = {
      platform: "android" as "android" | "ios",
      deviceWidth: 10,
      deviceHeight: 10,
      orientation: 0,
      x: 2,
      y: 3,
    };
    if (mismatch === "platform") {
      geometry.platform = "ios";
    }
    if (mismatch === "dimensions") {
      geometry.deviceWidth = 11;
    }
    if (mismatch === "orientation") {
      geometry.orientation = 2;
    }
    if (mismatch === "point") {
      geometry.x = 1;
    }
    observeScreen.setObserveResult(observation(10, 10));
    await expect(tapAt.execute({ x: 2, y: 3 }, undefined, undefined, { geometry })).rejects.toThrow(
      ActionableError,
    );
    await expect(tapAt.execute({ x: 2, y: 3 }, undefined, undefined, { geometry })).rejects.toThrow(
      mismatch,
    );
    expect(androidDispatches).toHaveLength(0);
  });
}

test("legacy coordinate step retains existing behavior", async () => {
  const { tapAt, androidDispatches } = createTapAt({
    deviceId: "test",
    name: "test",
    platform: "android",
  });
  expect((await tapAt.execute({ x: 2.2, y: 3.3 })).success).toBe(true);
  expect(androidDispatches).toMatchObject([{ x: 2, y: 3 }]);
});

test("recording persists resolved native pixels instead of image or normalized input", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  const context = {};
  const input = { x: 0.25, y: 0.5, coordinateSpace: "normalized" as const };
  await fake.tapAt.execute(input, undefined, undefined, context);
  const recorder = new McpCallRecorder();
  recorder.start();
  recorder.record("tapAt", { ...input, snapshotId: "ephemeral", __tapAtRecordingContext: context });
  const [step] = recorder.stop();
  expect(step.params).toEqual({ x: 3, y: 5 });
  expect(step.geometry).toMatchObject({ x: 3, y: 5 });
});

test("missing rotation evidence records a legacy tap with an actionable warning", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "ios" });
  const before = observation(10, 10);
  delete before.rotation;
  delete before.viewHierarchy?.rotation;
  fake.observeScreen.setObserveResult(before);
  const context = {};
  await fake.tapAt.execute({ x: 2, y: 3 }, undefined, undefined, context);
  const recorder = new McpCallRecorder();
  recorder.start();
  recorder.record("tapAt", { x: 2, y: 3, __tapAtRecordingContext: context });
  const result = recorder.stopWithWarnings();
  expect(result.steps).toEqual([{ tool: "tapAt", params: { x: 2, y: 3 } }]);
  expect(result.steps[0]).not.toHaveProperty("geometry");
  expect(result.warnings[0]).toContain("tapAt was recorded without geometry");
  expect(result.warnings[0]).toContain("geometry provenance is unavailable");
});
