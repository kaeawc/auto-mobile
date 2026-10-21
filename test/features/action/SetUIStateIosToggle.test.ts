import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SetUIState } from "../../../src/features/action/SetUIState";
import type { SetUIStateDependencies } from "../../../src/features/action/SetUIStateFields";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import type { TapAtOptions } from "../../../src/models/TapAtOptions";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClearText,
  FakeInputText,
  FakeObserveScreenForSetUIState,
  FakeSwipeOn,
  FakeTapOnElement,
} from "../../fakes/FakeSetUIStateDependencies";
import { buildObserveResult, observeResultFromFixture } from "../../helpers/observeFixture";

// Byte-for-byte device capture; provenance is in the adjacent README.txt.
const capture = observeResultFromFixture(
  JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const capturedNodes = new SearchableHierarchy().project(capture.viewHierarchy!);
const capturedRow = capturedNodes.find(
  (node) => node.label === "Enable Notifications" && node.affordances.includes("toggle"),
)!;
const capturedSwitch = capturedNodes.find((node) => node.parentIndex === capturedRow.index)!;
const capturedLabel = capturedNodes.find(
  (node) => node.label === "Preferences" && node.className === "UILabel",
)!;
const switchId = "s2-94d05fe9b843457e-2";

/**
 * Derived slice of the captured Settings switch row. Only the Show Borders label,
 * three rectangles and switch ID come from #14659; the added label uses a captured
 * UILabel. State divergence, sibling layout and missing IDs are test variations.
 */
function hierarchy(
  checked: boolean,
  rowChecked = checked,
  siblings = false,
  withId = true,
): ViewHierarchyResult {
  const row = structuredClone(capturedRow.source);
  const control = structuredClone(capturedSwitch.source);
  const label = structuredClone(capturedLabel.source);
  Object.assign(nodeAttributes(row), {
    text: "Show Borders",
    checked: String(rowChecked),
    bounds: { left: 36, top: 252, right: 366, bottom: 280 },
  });
  Object.assign(nodeAttributes(label), {
    text: "Show Borders",
    bounds: { left: 36, top: 255, right: 142, bottom: 276 },
  });
  Object.assign(nodeAttributes(control), {
    text: "Show Borders",
    checked: String(checked),
    "view-id": switchId,
    bounds: { left: 305, top: 252, right: 368, bottom: 280 },
  });
  if (!withId) {
    delete nodeAttributes(control)["view-id"];
    delete nodeAttributes(control)["resource-id"];
  }
  row.node = siblings ? [] : [label, control];
  return {
    screenWidth: 402,
    screenHeight: 874,
    hierarchy: { node: { node: siblings ? [row, label, control] : [row] } },
  };
}

function harness(view: () => ViewHierarchyResult, tapAt?: SetUIStateDependencies["tapAt"]) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new FakeTapOnElement();
  const observe = new FakeObserveScreenForSetUIState();
  observe.setResultFactory(() =>
    buildObserveResult({
      updatedAt: timer.now(),
      screenSize: { width: 402, height: 874 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: view(),
    }),
  );
  const action = new SetUIState({ name: "iPhone", platform: "ios", deviceId: "fake-ios" }, null, {
    timer,
    tapOnElement: tap,
    tapAt,
    observeScreen: observe,
    inputText: new FakeInputText(),
    clearText: new FakeClearText(),
    swipeOn: new FakeSwipeOn(),
  });
  return { action, tap, observe };
}

describe("SetUIState iOS labelled switches (#14659)", () => {
  test.each([false, true])("resolves the narrow switch with sibling layout %p", (siblings) => {
    const { action } = harness(() => hierarchy(false));
    const found = action.findElement(
      { text: "Show Borders" },
      hierarchy(false, false, siblings),
      true,
    );
    expect(found?.["view-id"]).toBe(switchId);
    expect(found?.bounds).toEqual({ left: 305, top: 252, right: 368, bottom: 280 });
  });

  test("prefers the rightmost equal-width toggle and excludes other rows", () => {
    const view = hierarchy(false, false, true);
    const nodes = view.hierarchy.node!.node!;
    const control = nodes[2];
    const left = structuredClone(control);
    Object.assign(nodeAttributes(left), {
      "view-id": "left-toggle",
      bounds: { left: 40, top: 252, right: 103, bottom: 280 },
    });
    const outside = structuredClone(control);
    Object.assign(nodeAttributes(outside), {
      "view-id": "other-row-toggle",
      text: "Other toggle",
      bounds: { left: 370, top: 300, right: 380, bottom: 328 },
    });
    nodes.splice(2, 0, left, outside);
    const { action } = harness(() => view);
    expect(action.findElement({ text: "Show Borders" }, view, true)?.["view-id"]).toBe(switchId);
  });

  test.each([false, true])(
    "reads, taps and verifies the switch itself for selected=%p",
    async (selected) => {
      let checked = !selected;
      const calls: Parameters<FakeTapOnElement["execute"]>[0][] = [];
      const { action, tap } = harness(() => hierarchy(checked, !checked));
      const executeTap = tap.execute.bind(tap);
      tap.execute = async (options): ReturnType<FakeTapOnElement["execute"]> => {
        calls.push(options);
        if (options.elementId === switchId) {
          checked = selected;
        }
        return executeTap(options);
      };
      const result = await action.execute({
        fields: [{ selector: { text: "Show Borders" }, selected }],
      });
      expect(calls).toEqual([{ elementId: switchId, action: "tap" }]);
      expect(result.success).toBe(true);
      expect(result.fields[0]).toMatchObject({ verified: true, attempts: 1, fieldType: "toggle" });
      expect(result.fields[0].skipped).not.toBe(true);
      expect(checked).toBe(selected);
    },
  );

  test("uses the bounds centre when the resolved switch has no ID", async () => {
    let checked = false;
    const points: TapAtOptions[] = [];
    const { action, tap } = harness(() => hierarchy(checked, !checked, true, false), {
      execute: async (options) => {
        points.push(options);
        checked = true;
        return { success: true, x: 336, y: 266 };
      },
    });
    const result = await action.execute({
      fields: [{ selector: { text: "Show Borders" }, selected: true }],
    });
    expect(result.success).toBe(true);
    expect(result.fields[0]).toMatchObject({ verified: true, attempts: 1 });
    expect(points).toEqual([{ x: 336, y: 266, action: "tap" }]);
    expect(tap.getCallCount()).toBe(0);
  });

  test("skips an already correct switch even when the row disagrees", async () => {
    const { action, tap } = harness(() => hierarchy(true, false));
    const result = await action.execute({
      fields: [{ selector: { text: "Show Borders" }, selected: true }],
    });
    expect(result.fields[0]).toMatchObject({ success: true, verified: true, skipped: true });
    expect(tap.getCallCount()).toBe(0);
  });

  test("retries an unchanged toggle only once", async () => {
    const { action, tap } = harness(() => hierarchy(false));
    const result = await action.execute({
      fields: [{ selector: { text: "Show Borders" }, selected: true }],
    });
    expect(result.success).toBe(false);
    expect(result.fields[0].attempts).toBe(2);
    expect(result.fields[0].error).toContain("expected true, observed false");
    expect(tap.getCallCount()).toBe(2);
  });

  test("refreshes state before retrying so a late change is not flipped back", async () => {
    let reads = 0;
    const { action, tap } = harness(() => hierarchy(++reads >= 3));
    const result = await action.execute({
      fields: [{ selector: { text: "Show Borders" }, selected: true }],
    });
    expect(result.fields[0]).toMatchObject({ success: true, verified: true, attempts: 2 });
    expect(tap.getCallCount()).toBe(1);
  });
});
