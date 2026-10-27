import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { prototypeListMaxItemsFor } from "../../../src/features/prototype/prototypeListMaxItems";
import { mapBindableFields } from "../../../src/features/prototype/prototypeTemplate";

const request = (extra: Record<string, unknown> = {}) => ({
  type: "request",
  url: "http://localhost/feed",
  append: { from: "/items", to: "/data/items" },
  ...extra,
});
const spec = (action: unknown) => ({
  id: "feed",
  window: { placement: { type: "fullscreen" } },
  data: { items: [], page: {} },
  root: { type: "button", label: "Load", onTap: [action] },
});

test("append is accepted by both validation surfaces", () => {
  const candidate = spec(request({ into: "/data/page" }));
  expect(validatePrototypeSpec(candidate)).toMatchObject({ success: true });
  expect(prototypeSpecSchema.safeParse(candidate).success).toBe(true);
});

test.each([
  ["bad", undefined, "request into is /data/<RFC 6901 pointer> and addresses a member of data"],
  [
    "/data/items/0",
    undefined,
    "request into must name an object member, not an array element, so into__meta can be written beside it",
  ],
  ["/data/items", "/data/items", "append.to must not overlap into"],
  ["/data/items", "/data/items/sub", "append.to must not overlap into"],
  ["/data/page/items", "/data/page", "append.to must not overlap into"],
  ["/data/page", undefined, "append.to must name an array"],
])("append.to validation %s / %s", (to, into, message) => {
  const result = validatePrototypeSpec(
    spec(request({ append: { from: "/items", to }, ...(into ? { into } : {}) })),
  );
  expect(result).toMatchObject({
    success: false,
    error: { path: "root.onTap[0].append.to", message },
  });
});

test.each(["onSuccess", "onError"])("nested %s validation retains action path", (field) => {
  expect(
    validatePrototypeSpec(
      spec(request({ [field]: [request({ append: { from: "/items", to: "/data/page" } })] })),
    ),
  ).toMatchObject({
    success: false,
    error: { path: `root.onTap[0].${field}[0].append.to`, message: "append.to must name an array" },
  });
});

test("repeat data-path mapper visits append.to but leaves response pointer untouched", () => {
  const root = {
    type: "button",
    label: "Load",
    onTap: [request({ append: { from: "/items", to: "/data/rows/{index}/items" } })],
  };
  const seen: string[] = [];
  const mapped = mapBindableFields(root, "root", (value, path, kind) => {
    if (kind === "requestInto") {
      seen.push(path);
      return String(value).replace("{index}", "0");
    }
    return value;
  });
  expect(seen).toEqual(["root.onTap[0].append.to"]);
  expect(mapped).toMatchObject({
    onTap: [{ append: { from: "/items", to: "/data/rows/0/items" } }],
  });
});

test("list window selects smallest matching maximum in nested roots and definitions", () => {
  const list = (maxItems?: number) => ({
    type: "list",
    repeat: { items: { path: "/items" } },
    maxItems,
  });
  const candidate = {
    root: { type: "column", children: [list(10), list(), list(4)] },
    components: { card: { root: list(6) } },
  };
  expect(prototypeListMaxItemsFor(candidate, "/data/items")).toBe(4);
  expect(prototypeListMaxItemsFor(candidate, "/data/other")).toBeUndefined();
});

test("real repeat accepts an indexed append.to and rejects overlap", () => {
  const candidate = {
    ...spec(request()),
    data: { rows: [{ items: [] }, { items: [] }] },
    root: {
      type: "column",
      repeat: { items: [{ id: "a" }, { id: "b" }], as: "row" },
      children: [
        {
          type: "button",
          label: "Load",
          onTap: [request({ append: { from: "/items", to: "/data/rows/{index}/items" } })],
        },
      ],
    },
  };
  expect(validatePrototypeSpec(candidate)).toMatchObject({ success: true });
  const invalid = {
    ...candidate,
    root: {
      ...candidate.root,
      children: [
        {
          type: "button",
          label: "Load",
          onTap: [
            request({
              into: "/data/rows/{index}/items",
              append: { from: "/items", to: "/data/rows/{index}/items" },
            }),
          ],
        },
      ],
    },
  };
  expect(validatePrototypeSpec(invalid)).toMatchObject({
    success: false,
    error: { message: "append.to must not overlap into" },
  });
});

test("component-expanded followups validate append.to", () => {
  const candidate = {
    ...spec(request()),
    root: { type: "use", component: "loader" },
    components: {
      loader: {
        root: {
          type: "button",
          label: "Load",
          onTap: [
            request({ onError: [request({ append: { from: "/items", to: "/data/page" } })] }),
          ],
        },
      },
    },
  };
  const result = validatePrototypeSpec(candidate);
  expect(result).toMatchObject({
    success: false,
    error: { message: "append.to must name an array" },
  });
  if (!result.success) {
    expect(result.error.path).toContain("append.to");
  }
});

test.each(["items", "", "/bad~2escape"])(
  "response from must be an RFC 6901 pointer: %s",
  (from) => {
    expect(
      prototypeSpecSchema.safeParse(spec(request({ append: { from, to: "/data/items" } }))).success,
    ).toBe(false);
    expect(
      validatePrototypeSpec(spec(request({ append: { from, to: "/data/items" } }))),
    ).toMatchObject({ success: false });
  },
);

import invalidPath from "../../fixtures/prototype-spec/invalid/request-append-to-path.json";
import invalidOverlap from "../../fixtures/prototype-spec/invalid/request-append-to-overlap.json";
import invalidArray from "../../fixtures/prototype-spec/invalid/request-append-to-non-array.json";
for (const fixture of [invalidPath, invalidOverlap, invalidArray]) {
  test(`shared validation: ${fixture.expectedMessage}`, () => {
    expect(validatePrototypeSpec(fixture.spec)).toEqual({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
  });
}

test("a missing static append target may be created before completion", () => {
  expect(
    validatePrototypeSpec(spec(request({ append: { from: "/items", to: "/data/future" } }))),
  ).toMatchObject({ success: true });
});
