import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeLoadingStatesFields,
  prototypeLoadingStatesUnsupportedMessage,
} from "../../../src/features/prototype/prototypeLoadingStates";

const spec = (root: unknown) => ({
  id: "loading",
  window: { placement: { type: "fullscreen" } },
  data: { feed: [] },
  state: { status: "loading" },
  root,
});

describe("loading states gate (#14207)", () => {
  test("reports nested empty conditions and shimmer styles, in tree order", () => {
    const root = {
      type: "column",
      visibleWhen: {
        all: [
          { key: "status", equals: "success" },
          { data: "/feed", empty: true },
        ],
      },
      children: [
        {
          type: "box",
          styleWhen: [{ when: { data: "/feed", empty: false }, style: { shimmer: true } }],
          children: [],
        },
      ],
    };
    expect(prototypeLoadingStatesFields(spec(root))).toEqual([
      "root.visibleWhen.all[1].empty",
      "root.children[0].styleWhen[0].when.empty",
      "root.children[0].styleWhen[0].style.shimmer",
    ]);
    expect(requiredPrototypeCapabilities(spec(root))).toContain("prototype_loading_states_v1");
  });

  test("ordinary data and state conditions need no gate", () => {
    const root = { type: "text", text: "x", visibleWhen: { data: "/feed", notEquals: 1 } };
    expect(prototypeLoadingStatesFields(spec(root))).toEqual([]);
  });

  test("the refusal names the capability and the field", () => {
    const message = prototypeLoadingStatesUnsupportedMessage(["root.style.shimmer"], "android");
    expect(message).toContain("prototype_loading_states_v1");
    expect(message).toContain("evaluate root.style.shimmer.");
  });
});
