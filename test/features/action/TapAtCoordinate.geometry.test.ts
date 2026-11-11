import { cropSource } from "../../helpers/imageRelativePoint";
import { resolveTapAtCoordinates } from "../../../src/features/action/tapAtCoordinateResolution";
import { xrBackStack } from "../../helpers/xrHeadset";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { recordPlanCall } from "../../helpers/recordPlanCall";
import { expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { createTapAt, observation } from "../../helpers/tapAtCoordinate";
import { ToolCallRecorder } from "../../../src/features/record/ToolCallRecorder";
import { YamlPlanSerializer } from "../../../src/utils/plan/PlanSerializer";
import * as yaml from "js-yaml";
import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../../src/models";
import { parseBounds } from "../../../src/utils/bounds";

// Restore the public compact bounds encoding to the internal observation shape.
const gboardCapture: { observation: ObserveResult; x: number; y: number } = JSON.parse(
  readFileSync(
    new URL("../../fixtures/android-xr/tapat-gboard-ime-screensize-17825.json", import.meta.url),
    "utf8",
  ),
  (key, value: unknown) => (key === "bounds" ? (parseBounds(value) ?? value) : value),
);

test("XR tapAt resolves the Gboard IME-sized observation using the fullscreen display", () => {
  const { observation, x, y } = gboardCapture;
  expect(observation.screenSize).toMatchObject({ width: 1080, height: 608 });
  expect(observation.screenshotImageSize).toBeUndefined();
  const options = { x, y, androidXr: true };
  const resolved = resolveTapAtCoordinates(options, observation, "android");
  expect(resolved).toMatchObject({
    x: 836,
    y: 110,
    screenshotPoint: { x: 1100, y: 861 },
    xrPanel: { packageName: "com.android.settings", taskId: 6, displayX: 836, displayY: 110 },
  });
  expect(resolved).toEqual(
    resolveTapAtCoordinates(
      options,
      { ...observation, screenSize: { width: 2560, height: 2558 } },
      "android",
    ),
  );
});

test("phone tapAt retains the small observation screen bounds despite fullscreen tasks", () => {
  const { observation, x, y } = gboardCapture;
  expect(resolveTapAtCoordinates({ x, y, androidXr: false }, observation, "android")).toEqual({
    x,
    y,
    error: "tapAt coordinates (1100, 861) are outside screen bounds [0, 1080) x [0, 608)",
  });
});

for (const platform of ["android", "ios"] as const) {
  test(`${platform} native recording/serialization/replay round trip`, async () => {
    const device = { deviceId: "test", name: "test", platform };
    const point = platform === "android" ? { x: 2, y: 3 } : { x: 2.125, y: 3.75 };
    const context = {};
    const first = createTapAt(device);
    await first.tapAt.execute(point, { planContext: context });
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(
      recorder,
      "tapAt",
      { ...point, snapshotId: "ephemeral" },
      {},
      { tapAt: context },
    );
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
    const result = await replay.tapAt.execute(point, {
      planContext: {
        geometry: plan.steps[0].geometry,
      },
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
    await expect(tapAt.execute({ x: 2, y: 3 }, { planContext: { geometry } })).rejects.toThrow(
      ActionableError,
    );
    await expect(tapAt.execute({ x: 2, y: 3 }, { planContext: { geometry } })).rejects.toThrow(
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
  await fake.tapAt.execute(input, { planContext: context });
  const recorder = new ToolCallRecorder();
  recorder.start();
  recordPlanCall(recorder, "tapAt", { ...input, snapshotId: "ephemeral" }, {}, { tapAt: context });
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
  await fake.tapAt.execute({ x: 2, y: 3 }, { planContext: context });
  const recorder = new ToolCallRecorder();
  recorder.start();
  recordPlanCall(recorder, "tapAt", { x: 2, y: 3 }, {}, { tapAt: context });
  const result = recorder.stopWithWarnings();
  expect(result.steps).toEqual([{ tool: "tapAt", params: { x: 2, y: 3 } }]);
  expect(result.steps[0]).not.toHaveProperty("geometry");
  expect(result.warnings[0]).toContain("tapAt was recorded without geometry");
  expect(result.warnings[0]).toContain("geometry provenance is unavailable");
});

for (const point of [
  { x: 553, y: 1178 },
  { x: 551, y: 1175 },
]) {
  test(`XR screenshot point ${point.x},${point.y} reaches Connected devices rather than Storage`, async () => {
    const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
    fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
    const result = await fake.tapAt.execute(point);
    expect(result.success).toBe(true);
    expect(fake.androidDispatches[0].x).toBeWithin(point.x === 553 ? 261 : 258, 269);
    expect(fake.androidDispatches[0].y).toBeWithin(437, 445);
    expect(result).toMatchObject({
      xrPanel: {
        packageName: "com.android.settings",
        taskId: 6,
        displayX: fake.androidDispatches[0].x,
        displayY: fake.androidDispatches[0].y,
      },
      warning: expect.stringContaining("assume the app panel is in its default pose"),
    });
  });
}

test("XR refuses environment points before dispatch", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
  const result = await fake.tapAt.execute({ x: 100, y: 100 });
  expect(result.success).toBe(false);
  expect(result.error).toContain("no app panel");
  expect(result.error).toContain("XR system UI");
  expect(fake.androidDispatches).toHaveLength(0);
});

for (const options of [
  { x: 553 / 2558, y: 1178 / 2558, coordinateSpace: "normalized" as const },
  { x: (553 / 2558) * 100, y: (1178 / 2558) * 100, coordinateSpace: "percent" as const },
  {
    image: {
      unit: "pixels" as const,
      x: 553,
      y: 1178,
      source: {
        screenshot: {
          screenSize: { width: 2560, height: 2558 },
          imageSize: { width: 2558, height: 2558 },
          screenshotOrientation: "display" as const,
        },
      },
    },
  },
]) {
  test(`XR resolves ${"image" in options ? "image" : options.coordinateSpace} into the same display point`, async () => {
    const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
    fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
    const result = await fake.tapAt.execute(options);
    expect(result.success).toBe(true);
    expect(fake.androidDispatches[0]).toMatchObject({ x: 262, y: 442 });
  });
}

test("non-XR freeform tasks preserve absolute coordinates", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  const backStack = xrBackStack();
  backStack.activities = backStack.activities.filter((activity) => activity.taskId === 6);
  backStack.tasks = backStack.tasks.filter((task) => task.id === 6);
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack });
  const result = await fake.tapAt.execute({ x: 551, y: 1175 });
  expect(result.success).toBe(true);
  expect(fake.androidDispatches[0]).toMatchObject({ x: 551, y: 1175 });
  expect(result.xrPanel).toBeUndefined();
  expect(result.warning).toBeUndefined();
});

test("tapAt maps screenshot pixels by the shared XR predicate, not the back stack (#17811)", async () => {
  const device = { deviceId: "test", name: "test", platform: "android" } as const;
  const panelOnly = xrBackStack();
  panelOnly.activities = panelOnly.activities.filter((activity) => activity.taskId === 6);
  panelOnly.tasks = panelOnly.tasks.filter((task) => task.id === 6);
  // The device declares the spatial feature, though the observation has no XR System UI.
  const headset = createTapAt(
    device,
    10,
    10,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new FakeAndroidXrDetector(true),
  );
  headset.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: panelOnly });
  const mapped = await headset.tapAt.execute({ x: 553, y: 1178 });
  expect(headset.androidDispatches[0]).toMatchObject({ x: 262, y: 442 });
  expect(mapped.xrPanel).toMatchObject({ taskId: 6 });
  // A device without the feature keeps absolute coordinates despite XR System UI windows.
  const phone = createTapAt(
    device,
    10,
    10,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new FakeAndroidXrDetector(false),
  );
  phone.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
  const absolute = await phone.tapAt.execute({ x: 551, y: 1175 });
  expect(phone.androidDispatches[0]).toMatchObject({ x: 551, y: 1175 });
  expect(absolute.xrPanel).toBeUndefined();
});

test("XR records screenshot coordinates for replay without mapping twice", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
  const context: import("../../../src/models/TapAtGeometry").TapAtPlanContext = {};
  await fake.tapAt.execute({ x: 553, y: 1178 }, { planContext: context });
  expect(context.recordedGeometry).toMatchObject({ x: 553, y: 1178 });
  await fake.tapAt.execute(
    { x: 553, y: 1178 },
    { planContext: { geometry: context.recordedGeometry } },
  );
  expect(fake.androidDispatches.map(({ x, y }) => ({ x, y }))).toEqual([
    { x: 262, y: 442 },
    { x: 262, y: 442 },
  ]);
});

test("XR excludes environment and barrier tasks even when they precede the app", async () => {
  const backStack = xrBackStack("swipe-up");
  backStack.tasks.sort(
    (a, b) =>
      Number(b.packageName?.startsWith("com.android.systemui")) -
      Number(a.packageName?.startsWith("com.android.systemui")),
  );
  const resolved = resolveTapAtCoordinates(
    { x: 553, y: 1178 },
    { ...observation(2560, 2558), backStack },
    "android",
  );
  expect(resolved).toMatchObject({ x: 262, y: 442, xrPanel: { taskId: 6 } });
});

test("XR system UI without an app panel refuses tapAt", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  const backStack = xrBackStack();
  backStack.tasks = backStack.tasks.filter((task) => task.id !== 6);
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack });
  const result = await fake.tapAt.execute({ x: 553, y: 1178 });
  expect(result.success).toBe(false);
  expect(result.error).toContain("no app panel");
  expect(fake.androidDispatches).toHaveLength(0);
});

test("XR image crop points use the same screenshot-to-panel mapping", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  const screenSize = { width: 2560, height: 2558 };
  const source = await cropSource({ platform: "android", screenSize }, screenSize, {
    left: 500,
    top: 1100,
    right: 600,
    bottom: 1200,
  });
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
  const result = await fake.tapAt.execute({ image: { unit: "pixels", x: 53, y: 78, source } });
  expect(result.success).toBe(true);
  expect(fake.androidDispatches[0]).toMatchObject({ x: 262, y: 442 });
});

test("XR native point space dispatches hierarchy coordinates unmapped", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
  const result = await fake.tapAt.execute({ x: 262, y: 442, pointSpace: "native" });
  expect(result.success).toBe(true);
  expect(result.xrPanel).toBeUndefined();
  expect(fake.androidDispatches[0]).toMatchObject({ x: 262, y: 442 });
});

test("XR public tapAt with the same numbers still treats them as screenshot pixels", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack: xrBackStack() });
  const native = await fake.tapAt.execute({ x: 262, y: 442 });
  expect(native.success).toBe(false);
  expect(native.error).toContain("no app panel");
  const screenshot = await fake.tapAt.execute({ x: 553, y: 1178, pointSpace: "screenshot" });
  expect(screenshot.success).toBe(true);
  expect(fake.androidDispatches).toHaveLength(1);
  expect(fake.androidDispatches[0]).toMatchObject({ x: 262, y: 442 });
  expect(screenshot.xrPanel).toMatchObject({ taskId: 6, displayX: 262, displayY: 442 });
});

test("XR tapAt refuses before dispatch when two app panels are open", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  const backStack = xrBackStack();
  const settings = backStack.tasks.find((task) => task.id === 6)!;
  backStack.tasks.push({ ...settings, id: 7, packageName: "com.example.second" });
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack });
  const result = await fake.tapAt.execute({ x: 553, y: 1178 });
  expect(result.success).toBe(false);
  expect(result.error).toContain("2 app panels are open");
  expect(result.error).toContain("Close the other app panels");
  expect(fake.androidDispatches).toHaveLength(0);
});

test("XR tapAt refuses before dispatch when the panel cannot fit the default pose", async () => {
  const fake = createTapAt({ deviceId: "test", name: "test", platform: "android" });
  const backStack = xrBackStack();
  const settings = backStack.tasks.find((task) => task.id === 6)!;
  settings.bounds = { left: 0, top: 0, right: 2560, bottom: 2558 };
  fake.observeScreen.setObserveResult({ ...observation(2560, 2558), backStack });
  const result = await fake.tapAt.execute({ x: 1280, y: 1400 });
  expect(result.success).toBe(false);
  expect(result.error).toContain("does not fit the screenshot at the default pose");
  expect(fake.androidDispatches).toHaveLength(0);
});
