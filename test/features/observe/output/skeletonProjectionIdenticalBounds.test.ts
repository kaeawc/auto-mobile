import { describe, expect, test } from "bun:test";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { diffObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../../src/features/utility/ResolverElementSelector";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import { androidControlObservation } from "../../../helpers/androidDisabledControlCapture";
import { createFlatNodeForTest } from "../flatHierarchyBuilders";
import type { Element } from "../../../../src/models/Element";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import capture from "../../../fixtures/android-launch-permission-dialog/contacts-first-launch-api37.json";

type ObserveElements = NonNullable<ObserveResult["elements"]>;

const DIALOG = { left: 28, top: 824, right: 1052, bottom: 1645 };

function elements(clickable: Element[], scrollable: Element[] = []): ObserveElements {
  return { clickable, scrollable, text: [], media: [] };
}

function rowIds(projected: ReturnType<typeof projectSkeleton>): (string | undefined)[] {
  return projected.skeleton.map((row) => row.elementId);
}

describe("skeleton rows at identical bounds (#17465)", () => {
  test("the captured grant dialog yields one row for its panel, plus each button", () => {
    const captured = structuredClone(capture.observation.elements) as ObserveElements;

    expect(rowIds(projectSkeleton(captured))).toEqual([
      "com.android.permissioncontroller:id/grant_dialog",
      "com.android.permissioncontroller:id/permission_allow_button",
      "com.android.permissioncontroller:id/permission_deny_button",
    ]);
  });

  test("two bare rows with the same affordances collapse to the first", () => {
    const projected = projectSkeleton(
      elements([
        { bounds: DIALOG, "resource-id": "outer", clickable: true },
        { bounds: DIALOG, "resource-id": "inner", clickable: true },
      ]),
    );

    expect(rowIds(projected)).toEqual(["outer"]);
  });

  test("between bare twins a resource id wins over a generated view id", () => {
    const projected = projectSkeleton(
      elements(
        [],
        [
          { bounds: DIALOG, "view-id": "s2-generated", scrollable: true },
          { bounds: DIALOG, "resource-id": "screen_content", scrollable: true },
        ],
      ),
    );

    expect(rowIds(projected)).toEqual(["screen_content"]);
  });

  test("a bare row with an affordance its sibling lacks is kept", () => {
    const projected = projectSkeleton(
      elements(
        [{ bounds: DIALOG, "resource-id": "panel", "content-desc": "Panel", clickable: true }],
        [{ bounds: DIALOG, "resource-id": "scroller", scrollable: true }],
      ),
    );

    expect(rowIds(projected).sort()).toEqual(["panel", "scroller"]);
  });

  test("rows at different bounds or with different enabled state are kept", () => {
    const projected = projectSkeleton(
      elements([
        { bounds: DIALOG, "resource-id": "labelled", text: "Title", clickable: true },
        { bounds: { ...DIALOG, bottom: 1600 }, "resource-id": "shorter", clickable: true },
        { bounds: DIALOG, "resource-id": "disabled", clickable: true, enabled: false },
      ]),
    );

    expect(rowIds(projected).sort()).toEqual(["disabled", "labelled", "shorter"]);
  });
});

describe("diff replay for a shadowed row", () => {
  // A bare clickable wrapper fills the same frame as its labelled child, and its
  // id also names a second row elsewhere. The skeleton drops the wrapper, but a
  // diff that reports the wrapper must still carry its selector index.
  function wrapperPair() {
    const baseline = androidControlObservation();
    delete baseline.elements;
    const template = new DefaultElementParser().extractRootNodes(baseline.viewHierarchy!)[0];
    const node = (fields: Partial<ViewHierarchyNode>): ViewHierarchyNode => {
      const copy = structuredClone(template);
      delete copy.node;
      delete copy.text;
      delete copy["view-id"];
      return { ...copy, clickable: "true", ...fields };
    };
    const child = node({ "resource-id": "title", text: "Title", bounds: DIALOG });
    const wrapper = node({ "resource-id": "row", bounds: DIALOG, node: [child] });
    const other = node({
      "resource-id": "row",
      bounds: { left: 28, top: 1700, right: 1052, bottom: 1800 },
    });
    baseline.viewHierarchy!.hierarchy = { node: { node: [wrapper, other] } };
    delete baseline.viewHierarchy!.windows;
    const next = structuredClone(baseline);
    const roots = new DefaultElementParser().extractRootNodes(next.viewHierarchy!);
    createFlatNodeForTest(roots[0].node![0]).selected = true;
    return { baseline, next };
  }

  test("keeps the shadowed wrapper's index instead of reporting it ambiguous", () => {
    const { baseline, next } = wrapperPair();
    const diff = diffObserveResult(baseline, next);
    const entry = diff.changed.find(({ changes }) => changes.selected);

    expect(entry?.selector?.elementId).toBe("row");
    expect(entry?.selector).not.toHaveProperty("ambiguous");
    const resolved = new ResolverElementSelector().selectByResourceId(next.viewHierarchy!, "row", {
      index: entry?.selector?.index,
    });
    expect(resolved.element?.bounds).toEqual(DIALOG);
  });
});
