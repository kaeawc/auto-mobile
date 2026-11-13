import { describe, expect, test } from "bun:test";
import {
  describeHeadUnitTarget,
  headUnitTemplateTargets,
  matchHeadUnitTemplateTargets,
  refuseHeadUnitTapOn,
} from "../../../src/features/androidAuto/HeadUnitTemplateItems";
import {
  FIXTURE_CAR_APP_PACKAGE,
  fixtureProjectedTemplates,
} from "../../helpers/androidAutoProjectionFixtures";

const MENU = fixtureProjectedTemplates(1);
const LIST = fixtureProjectedTemplates(2);

describe("head unit tapOn against the captured fixture's templates (#17842)", () => {
  test("targets are the top template's rows, not the screens under it", () => {
    const targets = headUnitTemplateTargets(LIST);
    expect(targets.map((target) => target.label)).toEqual([
      "List row 1",
      "List row 2",
      "List row 3",
      "List row 4",
      "List row 5",
      "List row 6",
    ]);
    // The header back action has no title, so text cannot name it.
    expect(targets.every((target) => target.kind === "item")).toBe(true);
  });

  test("a row matches by title or by its secondary text, case-insensitive", () => {
    const targets = headUnitTemplateTargets(MENU);
    expect(matchHeadUnitTemplateTargets(targets, "grid TEMPLATE").map((t) => t.label)).toEqual([
      "Grid template",
    ]);
    expect(matchHeadUnitTemplateTargets(targets, "thirty").map((t) => t.label)).toEqual([
      "List 30",
    ]);
  });

  test("exact text does not fall back to a substring", () => {
    const targets = headUnitTemplateTargets(MENU);
    expect(matchHeadUnitTemplateTargets(targets, "List", true)).toEqual([]);
    expect(matchHeadUnitTemplateTargets(targets, "list 30", true)).toHaveLength(1);
  });

  test("a match is described by its position, template and screen", () => {
    const [target] = matchHeadUnitTemplateTargets(headUnitTemplateTargets(LIST), "List row 3");
    expect(describeHeadUnitTarget(target)).toBe(
      `"List row 3" (row 3 of 6 in ListTemplate "List template" on ListScreen, ${FIXTURE_CAR_APP_PACKAGE})`,
    );
  });

  test("textAny reports every variant that matched", () => {
    expect(() => refuseHeadUnitTapOn(MENU, ["Nope", "Pane template"])).toThrow(
      /found "Pane template" \(row 3 of 5/,
    );
  });

  test("a snapshot with no recorded template reads as no snapshot", () => {
    const bare = fixtureProjectedTemplates(1);
    const [app] = bare.projected;
    const [session] = app.sessions;
    const stripped = {
      ...bare,
      projected: [
        {
          ...app,
          sessions: [{ ...session, screens: session.screens.map(({ template: _t, ...s }) => s) }],
        },
      ],
    };
    expect(() => refuseHeadUnitTapOn(stripped, ["List template"])).toThrow(
      "no projected app reported one",
    );
  });
});
