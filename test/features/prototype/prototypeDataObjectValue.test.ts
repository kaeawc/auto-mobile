import { describe, expect, test } from "bun:test";
import { actionSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  applyPrototypeDataAction,
  resolvePrototypeDataWriteValue,
} from "../../../src/features/prototype/prototypeDataWrite";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";

const append = (value: unknown, extra: Record<string, unknown> = {}) => ({
  type: "appendData",
  path: "/data/todos",
  value,
  ...extra,
});
const spec = (action: unknown) => ({
  id: "todo",
  window: { placement: { type: "fullscreen" } },
  state: { draft: "Buy milk" },
  data: { todos: [{ title: "Walk dog", done: true }] },
  root: { type: "button", label: "Add", onTap: [action] },
});
const row = { object: { title: { state: "draft" }, done: { value: false } } };

describe("data action object values (#18826)", () => {
  test("every data write accepts an object of flat member bindings", () => {
    for (const type of ["setData", "appendData", "prependData"]) {
      const action = append(row, {
        type,
        path: type === "setData" ? "/data/todos/0" : "/data/todos",
      });
      expect(actionSchema.safeParse(action).success).toBe(true);
      expect(validatePrototypeSpec(spec(action)).success).toBe(true);
    }
    const members = { a: { state: "draft" }, b: { data: "/todos/0/title" }, c: { value: [1] } };
    expect(validatePrototypeSpec(spec(append({ object: members }))).success).toBe(true);
  });

  test.each([
    ["empty", {}],
    ["nested object", { title: { object: { text: { state: "draft" } } } }],
    ["match member", { title: { match: "text" } }],
    ["event member", { title: { event: "" } }],
    ["platform member", { title: { platform: "/auth/userId" } }],
    ["member with two forms", { title: { state: "draft", value: 1 } }],
    ["invalid member name", { "bad-name": { value: 1 } }],
    [
      "too many members",
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`m${i}`, { value: i }])),
    ],
  ])("refuses %s", (_name, members) => {
    const action = append({ object: members });
    expect(actionSchema.safeParse(action).success).toBe(false);
    expect(validatePrototypeSpec(spec(action)).success).toBe(false);
  });

  test("the object form is not a shared binding: emit context and where.equals refuse it", () => {
    const emit = { type: "emit", name: "pick", context: { row } };
    expect(actionSchema.safeParse(emit).success).toBe(false);
    expect(validatePrototypeSpec(spec(emit)).success).toBe(false);
    const keyed = {
      type: "setData",
      path: "/data/todos",
      where: { field: "title", equals: row },
      member: "done",
      value: { value: true },
    };
    expect(validatePrototypeSpec(spec(keyed)).success).toBe(false);
  });

  test("an upsertData key must start with a member, non-null when that member is literal", () => {
    const upsert = (key: string, object: Record<string, unknown>) =>
      validatePrototypeSpec(
        spec({ type: "upsertData", path: "/data/todos", key, value: { object } }),
      );
    expect(upsert("/title", { title: { state: "draft" } }).success).toBe(true);
    expect(upsert("/meta/id", { meta: { value: { id: 1 } } }).success).toBe(true);
    expect(upsert("/id", { id: { value: 7 } }).success).toBe(true);
    for (const [key, object] of [
      ["/id", { title: { state: "draft" } }],
      ["/id", { id: { value: null } }],
      ["/meta/id", { meta: { value: { other: 1 } } }],
    ] as const) {
      expect(upsert(key, object)).toMatchObject({
        success: false,
        error: { path: "root.onTap[0].key" },
      });
    }
  });

  test("an object write needs prototype_data_actions_v3 before show", () => {
    const required = prototypeRequiredCapabilities(spec(append(row)));
    const gate = required.find((entry) => entry.capability === "prototype_data_actions_v3");
    expect(gate?.fields).toEqual(["root.onTap[0]"]);
    expect(required.some((entry) => entry.capability === "prototype_data_actions_v1")).toBe(true);
    const message = gate?.unsupportedMessage(gate.fields, "android") ?? "";
    expect(message).toContain("does not advertise prototype_data_actions_v3");
    expect(message).toContain("Nothing was shown.");
    const flat = prototypeRequiredCapabilities(spec(append({ value: { title: "x" } })));
    expect(flat.some((entry) => entry.capability === "prototype_data_actions_v3")).toBe(false);
  });

  test("members resolve like top-level values, and a missing source fails the write", () => {
    const inputs = { state: { draft: "Buy milk" }, data: { todos: [{ title: "Walk dog" }] } };
    expect(
      resolvePrototypeDataWriteValue(
        {
          object: {
            title: { state: "draft" },
            from: { data: "/todos/0/title" },
            done: { value: false },
          },
        },
        inputs,
      ),
    ).toEqual({ success: true, value: { title: "Buy milk", from: "Walk dog", done: false } });
    expect(
      resolvePrototypeDataWriteValue({ object: { title: { state: "missing" } } }, inputs),
    ).toMatchObject({ success: false, error: { code: "invalid_value" } });
    expect(
      resolvePrototypeDataWriteValue({ object: { title: { data: "/nope" } } }, inputs),
    ).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  test("a prependData object value inserts one row at the front, as the devices do", () => {
    const result = applyPrototypeDataAction(
      {
        type: "prependData",
        path: "/data/archive",
        value: { object: { title: { state: "draft" }, done: { value: true } } },
      },
      { state: { draft: "Walk dog" }, data: { archive: [{ title: "Old", done: false }] } },
    );
    expect(result).toEqual({
      success: true,
      trimmed: 0,
      data: {
        archive: [
          { title: "Walk dog", done: true },
          { title: "Old", done: false },
        ],
      },
    });
  });

  test("repeat item and index members bind per instance", () => {
    const node = {
      type: "button",
      label: "Archive",
      onTap: [
        append({
          object: { title: { item: "title" }, at: { index: true }, done: { value: true } },
        }),
      ],
    };
    const bound = bindNodeFields(node, "root", {
      binding: { alias: "todo", index: true },
      values: { title: "Walk dog" },
      index: 2,
    });
    expect((bound.onTap as { value: unknown }[])[0].value).toEqual({
      object: { title: { value: "Walk dog" }, at: { value: 2 }, done: { value: true } },
    });
  });

  test("item and index members are refused outside a repeat", () => {
    expect(validatePrototypeSpec(spec(append({ object: { t: { item: "title" } } }))).success).toBe(
      false,
    );
  });
});
