import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PrototypeScreenBudget,
  prototypeScreenBudgetMessage,
} from "../../../src/features/prototype/prototypeScreenBudget";
import { repeatErrors } from "../../../src/features/prototype/prototypeRepeat";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const limits = {
  MAX_PROTOTYPE_NODES: 10,
  MAX_PROTOTYPE_IMAGES: 4,
  MAX_PROTOTYPE_SPEC_NODES: 25,
  MAX_PROTOTYPE_SPEC_IMAGES: 8,
};
const spacers = (count: number) => Array.from({ length: count }, () => ({ type: "spacer" }));
const images = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ type: "image", asset: `a${index}` }));
const column = (children: unknown[]) => ({ type: "column", children });
const stack = (screens: Record<string, unknown>) => ({
  type: "stack",
  id: "nav",
  start: Object.keys(screens)[0],
  screens,
});
const spec = (root: unknown) => ({
  id: "budget",
  window: { placement: { type: "fullscreen" } },
  root,
});

describe("PrototypeScreenBudget", () => {
  test("sibling screens are budgeted separately", () => {
    const budget = new PrototypeScreenBudget(limits);
    budget.enterStack();
    for (let screen = 0; screen < 2; screen++) {
      budget.enterScreen();
      expect(budget.charge(10, 4)).toBeUndefined();
      budget.exitScreen();
    }
    budget.exitStack();
  });

  test("content outside the stack counts against every screen, before or after it", () => {
    const before = new PrototypeScreenBudget(limits);
    expect(before.charge(5, 0)).toBeUndefined();
    before.enterStack();
    before.enterScreen();
    expect(before.charge(6, 0)).toBe("nodes");

    const after = new PrototypeScreenBudget(limits);
    after.enterStack();
    after.enterScreen();
    expect(after.charge(6, 3)).toBeUndefined();
    after.exitScreen();
    after.exitStack();
    expect(after.charge(4, 0)).toBeUndefined();
    expect(after.charge(1, 0)).toBe("nodes");
    expect(after.charge(0, 2)).toBe("nodes");
  });

  test("a nested stack's largest screen is drawn with its parent screen", () => {
    const budget = new PrototypeScreenBudget(limits);
    budget.enterStack();
    budget.enterScreen();
    budget.enterStack();
    budget.enterScreen();
    expect(budget.charge(7, 0)).toBeUndefined();
    budget.exitScreen();
    budget.enterScreen();
    expect(budget.charge(2, 0)).toBeUndefined();
    budget.exitScreen();
    budget.exitStack();
    expect(budget.charge(3, 0)).toBeUndefined();
    expect(budget.charge(1, 0)).toBe("nodes");
  });

  test("two stacks drawn side by side add their largest screens", () => {
    const budget = new PrototypeScreenBudget(limits);
    for (const size of [6, 5]) {
      budget.enterStack();
      budget.enterScreen();
      budget.charge(size, 0);
      budget.exitScreen();
      budget.exitStack();
    }
    expect(budget.charge(0, 0)).toBe("nodes");
  });

  test("every node and image counts against the whole-spec ceiling", () => {
    const nodes = new PrototypeScreenBudget(limits);
    nodes.enterStack();
    const results = [10, 10, 10].map(() => {
      nodes.enterScreen();
      const result = nodes.charge(10, 0);
      nodes.exitScreen();
      return result;
    });
    expect(results).toEqual([undefined, undefined, "specNodes"]);

    const pictures = new PrototypeScreenBudget(limits);
    pictures.enterStack();
    const pictureResults = [4, 4, 1].map((count) => {
      pictures.enterScreen();
      const result = pictures.charge(0, count);
      pictures.exitScreen();
      return result;
    });
    expect(pictureResults).toEqual([undefined, undefined, "specImages"]);
  });

  test("messages keep the existing wording and name the whole-spec ceiling", () => {
    expect(prototypeScreenBudgetMessage("nodes")).toBe("Node limit exceeded");
    expect(prototypeScreenBudgetMessage("images", true)).toBe("Expanded image limit exceeded");
    expect(prototypeScreenBudgetMessage("specNodes", true)).toBe(
      "Expanded spec node limit exceeded",
    );
    expect(prototypeScreenBudgetMessage("specImages")).toBe("Spec image limit exceeded");
  });
});

describe("validation budgets each stack screen", () => {
  const saved = { ...contract.limits };
  beforeEach(() => {
    // Small bounds keep these walks far inside the unit-test budget.
    Object.assign(contract.limits, { MAX_PROTOTYPE_NODES: 20, MAX_PROTOTYPE_SPEC_NODES: 50 });
  });
  afterEach(() => {
    Object.assign(contract.limits, saved);
  });

  test("screens that each fit pass although their sum is over one screen's bound", () => {
    const root = stack({ a: column(spacers(15)), b: column(spacers(15)) });
    expect(validatePrototypeSpec(spec(root)).success).toBe(true);
  });

  test("a screen plus the content drawn around it must fit one screen's bound", () => {
    const root = column([...spacers(5), stack({ a: column(spacers(15)) })]);
    expect(validatePrototypeSpec(spec(root))).toEqual({
      success: false,
      error: { path: 'root.children[5].screens["a"].children[12]', message: "Node limit exceeded" },
    });
  });

  test("the whole spec stops at its own ceiling", () => {
    const screens = Object.fromEntries(
      ["a", "b", "c"].map((name) => [name, column(spacers(17))] as const),
    );
    expect(validatePrototypeSpec(spec(stack(screens)))).toEqual({
      success: false,
      error: { path: 'root.screens["c"].children[12]', message: "Spec node limit exceeded" },
    });
  });

  test("expanded repeats are budgeted per screen", () => {
    const repeated = {
      type: "column",
      repeat: { items: Array.from({ length: 6 }, (_, a) => ({ a })), as: "item" },
      children: [{ type: "spacer" }, { type: "spacer" }],
    };
    expect(repeatErrors(spec(stack({ a: repeated, b: repeated })))).toBeUndefined();
    expect(repeatErrors(spec(column([...spacers(8), stack({ a: repeated })])))).toEqual({
      path: 'root.children[8].screens["a"].repeat',
      message: "Expanded node limit exceeded",
    });
  });
});

describe("image budgets per stack screen", () => {
  test("each screen may use the full image bound", () => {
    const root = stack({ a: column(images(32)), b: column(images(32)) });
    expect(validatePrototypeSpec(spec(root)).success).toBe(true);
  });

  test("images outside the stack count against its screens", () => {
    const root = column([...images(2), stack({ a: column(images(31)) })]);
    expect(validatePrototypeSpec(spec(root))).toEqual({
      success: false,
      error: {
        path: 'root.children[2].screens["a"].children[30]',
        message: "Image limit exceeded",
      },
    });
  });
});
