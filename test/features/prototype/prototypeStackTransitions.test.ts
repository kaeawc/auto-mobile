import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { describe, expect, test } from "bun:test";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  PROTOTYPE_STACK_TRANSITIONS,
  prototypeStackTransitionFields,
  prototypeStackTransitionsUnsupportedMessage,
} from "../../../src/features/prototype/prototypeStackTransitions";

const stack = (extra: Record<string, unknown> = {}) => ({
  type: "stack",
  id: "nav",
  start: "home",
  screens: { home: { type: "text", text: "Home" } },
  ...extra,
});
const spec = (root: unknown) => ({
  id: "transitions",
  window: { placement: { type: "fullscreen" } },
  root,
});
const action = (type: string, transition?: unknown) => ({
  type,
  stack: "nav",
  ...(["push", "replace"].includes(type) ? { screen: "home" } : {}),
  ...(transition === undefined ? {} : { transition }),
});

describe("stack transitions", () => {
  test("the contract enum matches the single TS list", () => {
    expect(contract.definitions.stackTransition.values).toEqual([...PROTOTYPE_STACK_TRANSITIONS]);
  });
  test("all shared values validate on stacks and push/replace", () => {
    for (const transition of PROTOTYPE_STACK_TRANSITIONS) {
      expect(prototypeSpecSchema.safeParse(spec(stack({ transition }))).success).toBe(true);
      expect(
        validatePrototypeSpec(
          spec(
            stack({
              transition,
              onTap: [action("push", transition), action("replace", transition)],
            }),
          ),
        ).success,
      ).toBe(true);
    }
  });
  test("stack transition defaults remain ungated and explicit values require only the new gate", () => {
    expect(prototypeGateCapabilities(spec(stack()))).toEqual(["prototype_stack_v1"]);
    expect(prototypeGateCapabilities(spec(stack({ transition: "platform" })))).toEqual([
      "prototype_stack_transitions_v1",
      "prototype_stack_v1",
    ]);
    expect(
      prototypeGateCapabilities(spec({ type: "text", text: "x", transition: "fade" })),
    ).toEqual([]);
  });
  test("strict validation refuses the new capability when absent", () => {
    const value = spec(stack({ onTap: [action("replace", "none")] }));
    expect(
      validatePrototypeSpec(value, {
        supportedCapabilities: ["prototype_stack_v1"],
        requiredCapabilities: prototypeGateCapabilities,
      }),
    ).toMatchObject({
      success: false,
      error: { path: "$", message: "Unsupported capabilities: prototype_stack_transitions_v1" },
    });
    expect(
      validatePrototypeSpec(value, {
        supportedCapabilities: ["prototype_stack_v1", "prototype_stack_transitions_v1"],
        requiredCapabilities: prototypeGateCapabilities,
      }).success,
    ).toBe(true);
  });
  test("invalid enums, choreography objects and pop overrides are rejected", () => {
    for (const transition of ["scale", "sharedAxisX", { type: "fade" }, null]) {
      expect(prototypeSpecSchema.safeParse(spec(stack({ transition }))).success).toBe(false);
      expect(validatePrototypeSpec(spec(stack({ transition }))).success).toBe(false);
      expect(
        validatePrototypeSpec(spec(stack({ onTap: [action("push", transition)] }))).success,
      ).toBe(false);
    }
    for (const type of ["pop", "popToRoot"]) {
      expect(validatePrototypeSpec(spec(stack({ onTap: [action(type, "fade")] }))).success).toBe(
        false,
      );
    }
  });
  test("authored field paths include nested followups and screens in tree order", () => {
    const root = stack({
      transition: "slide",
      onTap: [
        {
          type: "request",
          url: "https://example.com",
          onSuccess: [action("push", "fade")],
          onError: [action("replace", "none")],
        },
      ],
      screens: { home: { type: "text", text: "Home", onTap: [action("push", "platform")] } },
    });
    expect(prototypeStackTransitionFields(spec(root))).toEqual([
      "root.transition",
      "root.onTap[0].onSuccess[0].transition",
      "root.onTap[0].onError[0].transition",
      'root.screens["home"].onTap[0].transition',
    ]);
  });
  test("refusal names the authored field and update action", () => {
    const message = prototypeStackTransitionsUnsupportedMessage(
      ["root.transition", "root.onTap[0].transition"],
      "ios",
    );
    expect(message).toContain("prototype_stack_transitions_v1");
    expect(message).toContain("root.transition (and 1 more)");
    expect(message).toContain("launchApp prototype: true");
    expect(prototypeStackTransitionsUnsupportedMessage(["root.transition"], "android")).toContain(
      "CtrlProxy",
    );
  });
});
