import { describe, expect, test } from "bun:test";
import {
  BASELINE_PERSONA_ID,
  DISPLAY_STRESSOR_IDS,
  facetAblations,
  personaPerturbation,
  resetStep,
  selectPerturbations,
} from "../../../scripts/persona-robustness/matrix";
import { OEM_PERSONA_IDS } from "../../../src/features/utility/OemPersonas";

const APP = "com.example.app";

describe("persona robustness matrix", () => {
  test("the default selection is every non-baseline persona plus every display stressor", () => {
    const ids = selectPerturbations([], APP).map((perturbation) => perturbation.id);
    expect(ids).toEqual([
      ...OEM_PERSONA_IDS.filter((id) => id !== BASELINE_PERSONA_ID),
      ...DISPLAY_STRESSOR_IDS.map((id) => `display:${id}`),
    ]);
  });

  test("the baseline is never selected as a perturbation", () => {
    expect(selectPerturbations([BASELINE_PERSONA_ID, "motorola"], APP).map((p) => p.id)).toEqual([
      "motorola",
    ]);
  });

  test("unknown ids are rejected with the valid choices", () => {
    expect(() => selectPerturbations(["nokia"], APP)).toThrow(/manufacturer profile id/);
    expect(() => selectPerturbations(["display:huge"], APP)).toThrow(/known: font-scale-1.3/);
  });

  test("a persona applies through manufacturerProfile with the app id", () => {
    const samsung = personaPerturbation("samsung-oneui", APP);
    expect(samsung.kind).toBe("persona");
    expect(samsung.apply).toEqual([
      {
        tool: "manufacturerProfile",
        args: { action: "apply", manufacturerProfile: "samsung-oneui", appId: APP },
      },
    ]);
    expect(samsung.facets).toEqual([
      "keyboard:samsung",
      "kill:samsung-sleeping",
      "display:cutout=hole,navigationMode=threebutton",
    ]);
    expect(personaPerturbation(BASELINE_PERSONA_ID, APP).kind).toBe("baseline");
  });

  test("a display stressor applies through displayProfile", () => {
    const [stressor] = selectPerturbations(["display:font-scale-1.3"], APP);
    expect(stressor?.apply).toEqual([
      { tool: "displayProfile", args: { action: "apply", fontScale: 1.3 } },
    ]);
    expect(stressor?.facets).toEqual(["display:fontScale=1.3"]);
  });

  test("ablation splits a persona into one facet tool call each", () => {
    expect(facetAblations("samsung-oneui", APP).map((p) => p.apply[0])).toEqual([
      { tool: "keyboard", args: { action: "setProfile", profile: "samsung" } },
      { tool: "killProfile", args: { action: "apply", appId: APP, profile: "samsung-sleeping" } },
      {
        tool: "displayProfile",
        args: { action: "apply", cutout: "hole", navigationMode: "threebutton" },
      },
    ]);
  });

  test("ablation skips a facet the baseline already runs", () => {
    const ablations = facetAblations("motorola", APP);
    expect(ablations.map((p) => p.facets)).toEqual([["kill:motorola-adaptive"]]);
    expect(ablations[0]?.parentId).toBe("motorola");
  });

  test("one reset restores every facet tool's change", () => {
    expect(resetStep(APP)).toEqual({
      tool: "manufacturerProfile",
      args: { action: "reset", appId: APP },
    });
  });
});
