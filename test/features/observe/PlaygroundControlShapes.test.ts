import { describe, expect, test } from "bun:test";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import type { ViewHierarchyResult } from "../../../src/models";
import { viewHierarchyResultSchema } from "../../../src/server/toolOutputSchemas";
import full from "../../fixtures/observe-output/playground-control-shapes/observe-full.json";
import capturedSkeleton from "../../fixtures/observe-output/playground-control-shapes/observe-skeleton.json";
import focusToSlider from "../../fixtures/observe-output/playground-control-shapes/focus-navigate-to-slider.json";
import focusStuck from "../../fixtures/observe-output/playground-control-shapes/focus-navigate-slider-stuck.json";

// Captured on an emulator from the Playground "Control Shapes" demo (#18299): flat Text/Switch
// siblings in one container, three switches sharing the resource id `duplicate_id_switch`, and a
// slider with no visible readout.
const captured: unknown = full.viewHierarchy;
viewHierarchyResultSchema.required({ hierarchy: true }).parse(captured);
const hierarchy = captured as ViewHierarchyResult;
const viewport = { width: full.screenSize.width, height: full.screenSize.height };

function project() {
  const elements = new DefaultObserveElementCollector().collect(hierarchy, "android");
  expect(elements).toBeDefined();
  return projectSkeleton(elements!, viewport, hierarchy);
}

describe("Playground Control Shapes capture", () => {
  test("the daemon's own skeleton labels each flat sibling switch from the text before it", () => {
    const toggles = capturedSkeleton.skeleton.filter((row) => row.affordances.includes("toggle"));
    expect(toggles.map((row) => row.label)).toEqual([
      "Flat Wi-Fi",
      "Flat Bluetooth",
      "Duplicate A",
      "Duplicate B",
      "Duplicate C",
    ]);
  });

  test("re-projecting the captured hierarchy keeps the same toggle labels", () => {
    const { skeleton } = project();
    const toggles = skeleton.filter((row) => row.affordances.includes("toggle"));
    expect(toggles.map((row) => row.label)).toEqual([
      "Flat Wi-Fi",
      "Flat Bluetooth",
      "Duplicate A",
      "Duplicate B",
      "Duplicate C",
    ]);
  });

  test("the three duplicate-id switches share one resource id, in top-to-bottom order", () => {
    const { skeleton } = project();
    const shared = skeleton.filter((row) => row.elementId === "duplicate_id_switch");
    expect(shared).toHaveLength(3);
    expect(shared.map((row) => row.label)).toEqual(["Duplicate A", "Duplicate B", "Duplicate C"]);
    const tops = shared.map((row) => row.bounds[1]);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
  });

  test("the readout-less slider is a focusable SeekBar with range info and no readout text", () => {
    const sliders = JSON.stringify(hierarchy).match(/"resource-id":"readout_less_slider"/g);
    expect(sliders).not.toBeNull();
    const text = JSON.stringify(hierarchy);
    expect(text).toContain('"range-info":"current:0.5,min:0.0,max:1.0"');
    expect(text).not.toContain("Slider Value");
  });

  test("focusNavigate reached the slider through every switch without hitting max_steps", () => {
    expect(focusToSlider).toMatchObject({ success: true, status: "focused", steps: 7 });
    expect(focusToSlider.focusedElement.resourceId).toBe("readout_less_slider");
    expect(focusStuck).toMatchObject({ success: false, status: "stuck", steps: 2 });
  });
});
