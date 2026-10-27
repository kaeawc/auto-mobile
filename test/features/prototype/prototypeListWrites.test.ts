import { expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import cases from "../../fixtures/prototype-spec/list-writes/data-writes.json";
import {
  applyPrototypeDataWrite,
  type PrototypeDataWrite,
} from "../../../src/features/prototype/prototypeDataWrite";
import { applyPrototypeRequestOutcome } from "../../../src/features/prototype/prototypeRequestOutcome";
import type { PrototypeRequestJson } from "../../../src/features/prototype/prototypeRequestProtocol";

for (const fixture of cases) {
  test(fixture.name, () => {
    const before = structuredClone(fixture.before);
    const result = applyPrototypeDataWrite(fixture.before, fixture.write as PrototypeDataWrite);
    if (fixture.expected.errorCode) {
      expect<unknown>(result).toMatchObject({
        success: false,
        error: { code: fixture.expected.errorCode },
      });
    } else {
      expect<unknown>(result).toEqual({ success: true, ...fixture.expected });
    }
    expect(fixture.before).toEqual(before);
  });
}

test("limits apply after trimming, including discarded oversized values", () => {
  const length = contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS - 20;
  const data = { items: Array.from({ length }, (_, i) => i) };
  expect(
    applyPrototypeDataWrite(data, {
      op: "extend",
      path: "/data/items",
      value: Array(40).fill(1),
      maxItems: 100,
    }),
  ).toMatchObject({ success: true, trimmed: length - 60 });
  expect(
    applyPrototypeDataWrite(data, { op: "extend", path: "/data/items", value: Array(40).fill(1) }),
  ).toMatchObject({ success: false, error: { code: "limit_exceeded" } });
  expect(
    applyPrototypeDataWrite(
      { items: ["x".repeat(contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES + 8000)] },
      { op: "append", path: "/data/items", value: 1, maxItems: 1 },
    ),
  ).toEqual({ success: true, data: { items: [1] }, trimmed: 1 });
});

const response = (body: PrototypeRequestJson) => ({
  type: "prototype_response" as const,
  requestId: "r",
  ok: true as const,
  status: 200,
  headers: {},
  body,
  durationMs: 1,
});

test("request extends then writes remaining nested response without mutating it", () => {
  const body = { page: { items: [2, 3], next: "p3" } };
  const result = applyPrototypeRequestOutcome({ items: [1] }, "/data/page", response(body), {
    from: "/page/items",
    to: "/data/items",
    maxItems: 2,
  });
  expect(result).toMatchObject({
    status: "success",
    appended: 2,
    wroteInto: true,
    data: { items: [2, 3], page: { page: { next: "p3" } } },
  });
  expect(body.page.items).toEqual([2, 3]);
});

test("request rolls back extend if into fails", () => {
  const result = applyPrototypeRequestOutcome(
    { items: [1] },
    "/data/missing/page",
    response({ items: [2] }),
    { from: "/items", to: "/data/items" },
  );
  expect(result).toMatchObject({
    status: "error",
    appended: 0,
    wroteInto: false,
    data: { items: [1] },
    meta: { error: { code: "invalid_response" } },
  });
});

const invalidBodies: PrototypeRequestJson[] = [{ items: 1 }, {}, [[1]], [1], "text", null];
test.each(invalidBodies)("invalid append.from rolls back: %j", (body) => {
  const from = Array.isArray(body) ? "/0" : "/items";
  const result = applyPrototypeRequestOutcome({ items: [1] }, undefined, response(body), {
    from,
    to: "/data/items",
  });
  expect(result).toMatchObject({
    status: "error",
    appended: 0,
    data: { items: [1] },
    meta: {
      error: {
        code: "invalid_response",
        message: "append.from does not resolve to an array in the response",
      },
    },
  });
});

test("append without into writes data", () => {
  expect(
    applyPrototypeRequestOutcome({ items: [1] }, undefined, response({ items: [2] }), {
      from: "/items",
      to: "/data/items",
    }),
  ).toMatchObject({ status: "success", appended: 1, wroteInto: false, data: { items: [1, 2] } });
});

import outcomes from "../../fixtures/prototype-spec/list-writes/request-outcomes.json";
import type { PrototypeData } from "../../../src/features/prototype/prototypeSpec";
import type { PrototypeResponseMessage } from "../../../src/features/prototype/prototypeRequestProtocol";
for (const fixture of outcomes) {
  test(`shared request outcome: ${fixture.name}`, () => {
    const original = structuredClone(fixture);
    expect<unknown>(
      applyPrototypeRequestOutcome(
        fixture.before as PrototypeData,
        fixture.into ?? undefined,
        fixture.response as PrototypeResponseMessage,
        fixture.append,
      ),
    ).toEqual(fixture.expected);
    expect(fixture).toEqual(original);
  });
}

test("metadata failure rolls back append even when no into body can be committed", () => {
  const before = { items: ["old"] };
  const result = applyPrototypeRequestOutcome(
    before,
    "/data/page",
    response({ items: ["x".repeat(contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES - 64)] }),
    { from: "/items", to: "/data/items" },
  );
  expect(result).toMatchObject({
    status: "error",
    wroteInto: false,
    appended: 0,
    data: { items: ["old"] },
    meta: { error: { code: "invalid_response" } },
  });
});

test("prepend trims discarded oversized rows before final byte limits", () => {
  expect(
    applyPrototypeDataWrite(
      { items: ["x".repeat(contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES + 1)] },
      { op: "prepend", path: "/data/items", value: [1], maxItems: 1 },
    ),
  ).toEqual({ success: true, data: { items: [1] }, trimmed: 1 });
  expect(
    applyPrototypeDataWrite({ items: 1 }, { op: "prepend", path: "/data/items", value: [] }),
  ).toMatchObject({
    success: false,
    error: { code: "not_array", message: "prependData target /data/items is not an array" },
  });
});

test("upsert trims before the hard array budget and leaves inputs unchanged", () => {
  const items = Array.from({ length: contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS }, (_, id) => ({
    id,
  }));
  const before = { items };
  const write = {
    op: "upsert" as const,
    path: "/data/items",
    key: "/id",
    value: { id: items.length },
  };
  expect(applyPrototypeDataWrite(before, write)).toMatchObject({
    success: false,
    error: { code: "limit_exceeded" },
  });
  expect(applyPrototypeDataWrite(before, { ...write, maxItems: 1 })).toEqual({
    success: true,
    data: { items: [write.value] },
    trimmed: items.length,
  });
  expect(before.items).toBe(items);
  expect(items).toHaveLength(contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS);
});
