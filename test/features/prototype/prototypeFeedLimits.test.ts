import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { applyPrototypeDataWrite } from "../../../src/features/prototype/prototypeDataWrite";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const limits = contract.limits;

function feed(rows: number, extra: Record<string, unknown> = {}) {
  return {
    id: "feed",
    window: { placement: { type: "fullscreen" } },
    data: {
      feed: {
        items: Array.from({ length: rows }, (_, id) => ({ id, author: `user${id}`, likes: id })),
      },
    },
    root: {
      type: "list",
      repeat: { items: { path: "/feed/items" }, as: "post", key: "id" },
      children: [{ type: "text", text: "{post.author}: {post.likes}" }],
      ...extra,
    },
  };
}

describe("feed-scale limits (#14183)", () => {
  test("the contract keeps the limits that feed-scale lists depend on in agreement", () => {
    expect(limits.MAX_PROTOTYPE_LIST_ITEMS).toBeGreaterThanOrEqual(1000);
    // A list reads its rows from /data, so the data array cap can never sit below the list cap.
    expect(limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS).toBeGreaterThanOrEqual(
      limits.MAX_PROTOTYPE_LIST_ITEMS,
    );
    // Host patches re-validate the whole spec against the data cap, so a device write must not be
    // allowed to leave data above it; and a response must fit one data write.
    expect(limits.MAX_PROTOTYPE_DATA_WRITE_BYTES).toBe(limits.MAX_PROTOTYPE_DATA_BYTES);
    expect(limits.MAX_PROTOTYPE_DATA_WRITE_BYTES).toBeGreaterThanOrEqual(
      limits.MAX_PROTOTYPE_RESPONSE_BYTES,
    );
    // Data rides inside the spec, so the data cap must leave room for the node tree below the
    // whole-spec byte cap; the spec cap stays the memory and transport guard.
    expect(limits.MAX_PROTOTYPE_DATA_BYTES).toBeLessThan(limits.MAX_PROTOTYPE_SPEC_BYTES);
    expect(limits.MAX_PROTOTYPE_SPEC_BYTES).toBe(1048576);
  });

  test("list.maxItems is bounded by the same constant as the list rows", () => {
    const list = contract.definitions.node.variants.list;
    const maxItems = "fields" in list ? list.fields.maxItems.rule.max : 0;
    expect(maxItems).toBe(limits.MAX_PROTOTYPE_LIST_ITEMS);
    expect(validatePrototypeSpec(feed(1, { maxItems })).success).toBe(true);
    expect(validatePrototypeSpec(feed(1, { maxItems: maxItems + 1 })).success).toBe(false);
  });

  // The exact-cap and cap-plus-one specs are the shared strict-list-items fixtures.
  test("a 1000 row feed validates", () => {
    expect(validatePrototypeSpec(feed(1000)).success).toBe(true);
  });

  test("one row over the cap is refused at the repeat path", () => {
    expect(validatePrototypeSpec(feed(limits.MAX_PROTOTYPE_LIST_ITEMS + 1))).toEqual({
      success: false,
      error: {
        path: "root.repeat.items.path",
        message: `Repeat path resolves to more than ${limits.MAX_PROTOTYPE_LIST_ITEMS} items`,
      },
    });
  });

  test("a paging append can grow a data array to the cap and no further", () => {
    const items = Array.from({ length: limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS - 1 }, (_, i) => i);
    const filled = applyPrototypeDataWrite(
      { items },
      { op: "append", path: "/data/items", value: 0 },
    );
    expect(filled).toMatchObject({ success: true, trimmed: 0 });
    if (filled.success) {
      expect(
        applyPrototypeDataWrite(filled.data, { op: "append", path: "/data/items", value: 0 }),
      ).toMatchObject({ success: false, error: { code: "limit_exceeded" } });
    }
  });
});
