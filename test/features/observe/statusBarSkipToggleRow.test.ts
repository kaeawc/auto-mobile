import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";
import { diffObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { TestHierarchyNode } from "./observeScreenTestBuilders";

/**
 * The status-bar settle skip must not drop SystemUI rows that reuse status-bar ids but carry
 * affordances, such as an Internet-dialog toggle row (#19155). The screen is the captured
 * android-35 notification shade; the toggle row reuses its captured `carrier1` row (a clickable
 * LinearLayout holding `mobile_carrier_text`), renamed to the dialog's `mobile_network_layout`
 * and given a `mobile_toggle` switch.
 */
const SYSTEMUI = "com.android.systemui:id/";
const shade = (
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../../fixtures/systemTray/android-35/silent-headerless-row-observe.json",
      ),
      "utf8",
    ),
  ) as { viewHierarchy: Omit<ViewHierarchyResult, "hierarchy"> & { hierarchy: TestHierarchyNode } }
).viewHierarchy;

function childrenOf(node: TestHierarchyNode): TestHierarchyNode[] {
  const children: unknown = node.node;
  if (Array.isArray(children)) {
    return children as TestHierarchyNode[];
  }
  return children ? [children as TestHierarchyNode] : [];
}

function findById(node: TestHierarchyNode, id: string): TestHierarchyNode | undefined {
  if (node["resource-id"] === id) {
    return node;
  }
  return childrenOf(node)
    .map((child) => findById(child, id))
    .find(Boolean);
}

const capturedCarrierRow = findById(shade.hierarchy, `${SYSTEMUI}carrier1`)!;

function internetToggleRow(checked: boolean): TestHierarchyNode {
  const row = structuredClone(capturedCarrierRow);
  row["resource-id"] = `${SYSTEMUI}mobile_network_layout`;
  row.node = [
    ...childrenOf(row),
    {
      "resource-id": `${SYSTEMUI}mobile_toggle`,
      class: "android.widget.Switch",
      checkable: "true",
      checked: checked ? "true" : "false",
      bounds: [940, 37, 1038, 88],
    },
  ];
  return row;
}

function shadeWithToggle(
  checked: boolean,
  updatedAt: number,
  edit: (hierarchy: TestHierarchyNode) => void = () => {},
): ObserveResult {
  const hierarchy = structuredClone(shade.hierarchy);
  hierarchy.node = [...childrenOf(hierarchy), internetToggleRow(checked)];
  edit(hierarchy);
  return {
    updatedAt,
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.android.systemui", activityName: "", layoutSeqSum: 1 },
    viewHierarchy: { ...shade, hierarchy, updatedAt },
  } as ObserveResult;
}

describe("status-bar skip keeps SystemUI toggle rows (#19155)", () => {
  test("a toggle row whose checked state flips keeps settle unsettled", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult((index) => shadeWithToggle(index % 2 === 0, (index + 1) * 10));

    const result = await new RealSettleObserve(fake, timer).execute({
      timeoutMs: 500,
      pollMs: 150,
    });

    expect(result.settled).toBe(false);
    expect(result.unsettledBy).toEqual([
      { elementId: `${SYSTEMUI}mobile_toggle`, field: "checked" },
    ]);
  });

  test("the captured shade with a steady toggle row settles", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult((index) => shadeWithToggle(true, (index + 1) * 10));

    const result = await new RealSettleObserve(fake, timer).execute({
      timeoutMs: 500,
      pollMs: 150,
    });

    expect(result.settled).toBe(true);
  });

  test("the status-bar-skipping action diff reports the toggle change", () => {
    const diff = diffObserveResult(shadeWithToggle(false, 10), shadeWithToggle(true, 20), {
      skipStatusBar: true,
    });

    expect(diff.changed.map((change) => change.key)).toEqual([
      expect.stringContaining("mobile_toggle"),
    ]);
  });
});

/** Sets the text of every node with `id`, so both the captured and the added row change. */
function setTextById(node: TestHierarchyNode, id: string, text: string): void {
  if (node["resource-id"] === id) {
    node.text = text;
  }
  childrenOf(node).forEach((child) => setTextById(child, id, text));
}

describe("status-bar skip in the expanded shade (#19155 follow-ups)", () => {
  test("the clickable shade-header clock rolling over a minute is not a screen change", () => {
    // Settle's volatile-text masking would hide a tick after a few reads; the diff itself must not
    // see it, or a stable wait spanning a minute costs an extra read.
    const clock = (text: string) => (hierarchy: TestHierarchyNode) =>
      setTextById(hierarchy, `${SYSTEMUI}clock`, text);
    const diff = diffObserveResult(
      shadeWithToggle(true, 10, clock("10:32")),
      shadeWithToggle(true, 20, clock("10:33")),
      { skipStatusBar: true },
    );

    expect([...diff.added, ...diff.removed, ...diff.changed]).toEqual([]);
  });

  test("summary text under a kept actionable row still counts as a change", () => {
    const summary = (text: string) => (hierarchy: TestHierarchyNode) =>
      setTextById(hierarchy, `${SYSTEMUI}mobile_carrier_text`, text);
    const diff = diffObserveResult(
      shadeWithToggle(true, 10, summary("Connecting…")),
      shadeWithToggle(true, 20, summary("Connected")),
      { skipStatusBar: true },
    );

    // Text is part of a node's diff key, so new text reads as a removed and an added node.
    expect(diff.added.map((node) => node.key)).toContainEqual(
      expect.stringContaining("mobile_carrier_text\u0000884,37,1027,88\u0000Connected"),
    );
  });
});
