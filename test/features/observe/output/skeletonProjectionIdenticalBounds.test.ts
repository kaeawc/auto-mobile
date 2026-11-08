import { describe, expect, test } from "bun:test";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
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
