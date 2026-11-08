import { describe, expect, test } from "bun:test";
import {
  applyCarAppHostRenderedUi,
  CAR_APP_ACTIVITY,
  CAR_APP_TEMPLATES_HOST_PACKAGE,
  detectCarAppHostRenderedUi,
  isCarAppHostRendered,
  type CarAppHostRenderedUi,
} from "../../../../src/features/observe/automotive/carAppHostRenderedUi";
import { observeResultSchema } from "../../../../src/server/toolOutputSchemas/observation";
import { createFlatHierarchyForTest, createObserveResultForTest } from "../flatHierarchyBuilders";
import {
  CAR_APP_HOST_FIXTURES,
  fixtureHierarchy,
  readCarAppHostFixture,
  withoutHostNodes,
} from "./carAppHostFixtures";

const HOST_MARKER: CarAppHostRenderedUi = {
  kind: "carAppLibrary",
  hostPackage: CAR_APP_TEMPLATES_HOST_PACKAGE,
};

function observed(fixture: ReturnType<typeof readCarAppHostFixture>) {
  return createObserveResultForTest({
    activeWindow: fixture.activeWindow,
    automotive: structuredClone(fixture.automotive),
    viewHierarchy: fixtureHierarchy(fixture),
  });
}

describe("detectCarAppHostRenderedUi", () => {
  test.each(CAR_APP_HOST_FIXTURES)("marks the captured %s template screen", (name) => {
    const result = observed(readCarAppHostFixture(name));
    expect(detectCarAppHostRenderedUi(result)).toEqual(HOST_MARKER);
  });

  test("the menu without the activity name still matches on the host resource-id prefix", () => {
    const fixture = readCarAppHostFixture("menu");
    const result = observed({
      ...fixture,
      activeWindow: { ...fixture.activeWindow, activityName: "" },
    });
    expect(detectCarAppHostRenderedUi(result)).toEqual(HOST_MARKER);
  });

  test("CarAppActivity alone marks the screen without naming a host", () => {
    const result = observed(withoutHostNodes(readCarAppHostFixture("grid")));
    expect(result.activeWindow?.activityName).toBe(CAR_APP_ACTIVITY);
    expect(detectCarAppHostRenderedUi(result)).toEqual({ kind: "carAppLibrary" });
  });

  test("an app's own activity with app-only ids is not marked", () => {
    const fixture = withoutHostNodes(readCarAppHostFixture("menu"));
    const result = observed({
      ...fixture,
      activeWindow: { ...fixture.activeWindow, activityName: ".DrivingSafeActivity" },
    });
    expect(detectCarAppHostRenderedUi(result)).toBeUndefined();
  });

  test("a resource id nested in `$` attributes matches", () => {
    const result = createObserveResultForTest({
      viewHierarchy: {
        hierarchy: {
          node: {
            $: { "resource-id": "android:id/content" },
            node: [{ $: { "resource-id": `${CAR_APP_TEMPLATES_HOST_PACKAGE}:id/template_view` } }],
          },
        },
      },
    });
    expect(detectCarAppHostRenderedUi(result)).toEqual(HOST_MARKER);
  });

  test("a host resource id under any window root matches", () => {
    const fixture = readCarAppHostFixture("pane");
    const appWindow = fixtureHierarchy(withoutHostNodes(fixture)).hierarchy.node;
    const hostWindow = fixtureHierarchy(fixture).hierarchy.node;
    const result = createObserveResultForTest({
      activeWindow: { ...fixture.activeWindow, activityName: "" },
      viewHierarchy: createFlatHierarchyForTest({ hierarchy: { node: appWindow } }),
    });
    // Multi-window captures carry an array in the root slot despite its single-node type.
    Object.assign(result.viewHierarchy?.hierarchy ?? {}, { node: [appWindow, hostWindow] });
    expect(detectCarAppHostRenderedUi(result)).toEqual(HOST_MARKER);
  });

  test("a host-like package outside the resource-id prefix does not match", () => {
    const result = createObserveResultForTest({
      viewHierarchy: {
        hierarchy: { node: { text: `${CAR_APP_TEMPLATES_HOST_PACKAGE}:id/title` } },
      },
    });
    expect(detectCarAppHostRenderedUi(result)).toBeUndefined();
  });
});

describe("applyCarAppHostRenderedUi", () => {
  test("adds the marker to the automotive block and the output schema keeps it", () => {
    const result = observed(readCarAppHostFixture("pane"));
    applyCarAppHostRenderedUi(result);
    expect(result.automotive?.hostRenderedUi).toEqual(HOST_MARKER);
    expect(isCarAppHostRendered(result)).toBe(true);
    expect(observeResultSchema.parse(result).automotive).toEqual(result.automotive);
  });

  test("leaves an unmarked automotive screen byte for byte unchanged", () => {
    const fixture = withoutHostNodes(readCarAppHostFixture("list"));
    const result = observed({
      ...fixture,
      activeWindow: { ...fixture.activeWindow, activityName: ".DrivingSafeActivity" },
    });
    const before = JSON.stringify(result);
    applyCarAppHostRenderedUi(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(isCarAppHostRendered(result)).toBe(false);
  });

  test("clears a stale marker once the host screen is gone", () => {
    const result = observed(readCarAppHostFixture("list"));
    applyCarAppHostRenderedUi(result);
    result.activeWindow = { appId: "com.android.car.settings", activityName: "", layoutSeqSum: 0 };
    result.viewHierarchy = { hierarchy: { node: {} } };
    applyCarAppHostRenderedUi(result);
    expect(Object.hasOwn(result.automotive ?? {}, "hostRenderedUi")).toBe(false);
  });

  test("never adds an automotive block to another device's observation", () => {
    const fixture = readCarAppHostFixture("menu");
    const result = createObserveResultForTest({
      activeWindow: fixture.activeWindow,
      viewHierarchy: fixtureHierarchy(fixture),
    });
    const before = JSON.stringify(result);
    applyCarAppHostRenderedUi(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(isCarAppHostRendered(result)).toBe(false);
  });
});
