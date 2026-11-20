import { beforeAll, describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_LARGE_BUDGET_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import {
  knownPrototypeCapabilities,
  requiredPrototypeCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  PROTOTYPE_BASE_BUDGET,
  PROTOTYPE_LARGE_BUDGET,
  prototypeLargeBudgetFields,
  prototypeRuntimeBudget,
} from "../../../src/features/prototype/prototypeRuntimeBudget";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { specCapabilityRefusal } from "../../../src/server/prototypeTools/preflight";

const MIB = 1024 * 1024;

function feed(rows: number, list: Record<string, unknown> = {}, data: object = {}) {
  return {
    id: "feed",
    window: { placement: { type: "fullscreen" } },
    root: {
      type: "list",
      repeat: { items: { path: "/feed/items" }, as: "post", key: "id" },
      children: [{ type: "text", text: "{post.id}" }],
      ...list,
    },
    data: { feed: { items: Array.from({ length: rows }, (_, id) => ({ id })) }, ...data },
  };
}

function appendFeed(maxItems: number) {
  return feed(1, {
    onEndReached: [
      { type: "appendData", path: "/data/feed/items", value: { value: { id: 1 } }, maxItems },
    ],
  });
}

const large = { budget: PROTOTYPE_LARGE_BUDGET };

// One full validation of a 2001-row feed, computed once outside the per-test time budget.
let largeFeed: ReturnType<typeof validatePrototypeSpec>;
beforeAll(() => {
  largeFeed = validatePrototypeSpec(feed(2001), large);
});

describe("prototype runtime budgets (#18804)", () => {
  test("the contract table holds the large budget and the base budget is today's limits", () => {
    expect(PROTOTYPE_LARGE_BUDGET).toEqual({
      MAX_PROTOTYPE_SPEC_BYTES: 4 * MIB,
      MAX_PROTOTYPE_DATA_BYTES: 3 * MIB,
      MAX_PROTOTYPE_DATA_WRITE_BYTES: 3 * MIB,
      MAX_PROTOTYPE_DATA_ARRAY_ITEMS: 10000,
      MAX_PROTOTYPE_LIST_ITEMS: 10000,
    });
    expect(PROTOTYPE_BASE_BUDGET).toEqual({
      MAX_PROTOTYPE_SPEC_BYTES: contract.limits.MAX_PROTOTYPE_SPEC_BYTES,
      MAX_PROTOTYPE_DATA_BYTES: contract.limits.MAX_PROTOTYPE_DATA_BYTES,
      MAX_PROTOTYPE_DATA_WRITE_BYTES: contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES,
      MAX_PROTOTYPE_DATA_ARRAY_ITEMS: contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS,
      MAX_PROTOTYPE_LIST_ITEMS: contract.limits.MAX_PROTOTYPE_LIST_ITEMS,
    });
  });

  test("each maxLimit rule's literal max is the base value of the limit it names", () => {
    const { appendData, upsertData } = contract.definitions.action.variants;
    const rules = [
      appendData.fields.maxItems.rule,
      upsertData.fields.maxItems.rule,
      contract.definitions.node.variants.list.fields.maxItems.rule,
    ];
    for (const rule of rules) {
      const name = rule.maxLimit as keyof typeof PROTOTYPE_BASE_BUDGET;
      expect(Object.hasOwn(PROTOTYPE_LARGE_BUDGET, name)).toBe(true);
      expect(rule.max).toBe(PROTOTYPE_BASE_BUDGET[name]);
    }
  });

  test("a runtime gets the large budget only when it advertises the capability", () => {
    expect(prototypeRuntimeBudget(undefined)).toBe(PROTOTYPE_BASE_BUDGET);
    expect(prototypeRuntimeBudget(["prototype_lazy_list_v1"])).toBe(PROTOTYPE_BASE_BUDGET);
    expect(prototypeRuntimeBudget([PROTOTYPE_LARGE_BUDGET_CAPABILITY])).toBe(
      PROTOTYPE_LARGE_BUDGET,
    );
  });

  test("a list over the base item limit validates only against the large budget", () => {
    const spec = feed(2001);
    expect(validatePrototypeSpec(spec)).toEqual({
      success: false,
      error: {
        path: "root.repeat.items.path",
        message: "Repeat path resolves to more than 2000 items",
      },
    });
    expect(largeFeed.success).toBe(true);
    expect(prototypeLargeBudgetFields(spec)).toEqual(["data.feed.items", "root.repeat.items.path"]);
    expect(requiredPrototypeCapabilities(spec)).toContain(PROTOTYPE_LARGE_BUDGET_CAPABILITY);
  });

  test("list and data action maxItems follow the budget", () => {
    const list = feed(1, { maxItems: 5000 });
    expect(validatePrototypeSpec(list)).toEqual({
      success: false,
      error: { path: "root.maxItems", message: "Invalid number value" },
    });
    expect(validatePrototypeSpec(list, large).success).toBe(true);
    expect(prototypeLargeBudgetFields(list)).toEqual(["root.maxItems"]);
    expect(validatePrototypeSpec(feed(1, { maxItems: 10001 }), large).success).toBe(false);

    expect(validatePrototypeSpec(appendFeed(5000)).success).toBe(false);
    expect(validatePrototypeSpec(appendFeed(5000), large).success).toBe(true);
    expect(validatePrototypeSpec(appendFeed(10001), large).success).toBe(false);
    expect(prototypeLargeBudgetFields(appendFeed(5000))).toEqual(["root.onEndReached[0].maxItems"]);
    expect(prototypeLargeBudgetFields(appendFeed(2000))).toEqual([]);
  });

  test("a data action literal over the base budget needs the large-budget capability", () => {
    const setFeed = (value: unknown) =>
      feed(1, {
        onEndReached: [{ type: "setData", path: "/data/feed/items", value: { value } }],
      });
    const rows = setFeed(Array.from({ length: 2001 }, (_, id) => ({ id })));
    expect(validatePrototypeSpec(rows).success).toBe(false);
    expect(prototypeLargeBudgetFields(rows)).toEqual(["root.onEndReached[0].value.value"]);
    expect(requiredPrototypeCapabilities(rows)).toContain(PROTOTYPE_LARGE_BUDGET_CAPABILITY);

    const bytes = setFeed({ blob: "x".repeat(800 * 1024) });
    expect(validatePrototypeSpec(bytes).success).toBe(false);
    expect(prototypeLargeBudgetFields(bytes)).toEqual(["root.onEndReached[0].value.value"]);

    expect(prototypeLargeBudgetFields(setFeed([{ id: 1 }]))).toEqual([]);
    // A literal shaped like an action is data, not an action to scan.
    expect(prototypeLargeBudgetFields(setFeed({ type: "appendData", maxItems: 2001 }))).toEqual([]);
  });

  test("spec and data bytes over the base budget validate only against the large budget", () => {
    const spec = feed(1, {}, { blob: "x".repeat(1.5 * MIB) });
    expect(validatePrototypeSpec(spec)).toEqual({
      success: false,
      error: { path: "$", message: "Spec byte limit exceeded" },
    });
    expect(validatePrototypeSpec(spec, large).success).toBe(true);
    expect(prototypeLargeBudgetFields(spec)).toEqual(["$", "data"]);

    const data = feed(1, {}, { blob: "x".repeat(800 * 1024) });
    expect(validatePrototypeSpec(data)).toEqual({
      success: false,
      error: { path: "data", message: "Data byte limit exceeded" },
    });
    expect(validatePrototypeSpec(data, large).success).toBe(true);

    const over = feed(1, {}, { blob: "x".repeat(3 * MIB) });
    expect(validatePrototypeSpec(over, large)).toEqual({
      success: false,
      error: { path: "data", message: "Data byte limit exceeded" },
    });
  });

  test("a spec within the base budget needs no capability", () => {
    const spec = feed(2000);
    expect(prototypeLargeBudgetFields(spec)).toEqual([]);
    expect(requiredPrototypeCapabilities(spec)).not.toContain(PROTOTYPE_LARGE_BUDGET_CAPABILITY);
    // The web library advertises the known set and keeps the base budget.
    expect(knownPrototypeCapabilities()).not.toContain(PROTOTYPE_LARGE_BUDGET_CAPABILITY);
  });

  test("the show preflight refuses a spec over the base budget unless the runtime advertises it", async () => {
    const spec = feed(2001);
    const android = (advertised: boolean) => ({
      android: {
        supportsCommand: async (capability: string) =>
          capability !== PROTOTYPE_LARGE_BUDGET_CAPABILITY || advertised,
      },
    });
    const refusal = await specCapabilityRefusal(android(false), spec, undefined);
    expect(refusal?.success).toBe(false);
    expect(refusal?.error).toContain(PROTOTYPE_LARGE_BUDGET_CAPABILITY);
    expect(refusal?.error).toContain("data.feed.items (and 1 more)");
    expect(await specCapabilityRefusal(android(true), spec, undefined)).toBeUndefined();
    const ios = await specCapabilityRefusal(
      {
        ios: {
          supportsCapability: (capability: string) =>
            capability !== PROTOTYPE_LARGE_BUDGET_CAPABILITY,
        },
      },
      spec,
      undefined,
    );
    expect(ios?.error).toContain("connected iOS prototype agent");
    expect(await specCapabilityRefusal(android(false), feed(2000), undefined)).toBeUndefined();
  });
});
