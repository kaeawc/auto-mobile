import { expect, test } from "bun:test";
import { actionSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { coalescePrototypeChannelFrames } from "../../../src/features/prototype/prototypeChannelCoalesce";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";

const keyed = {
  type: "setData",
  path: "/data/rows",
  where: { field: "id", equals: { value: 1 } },
  member: "title",
  value: { value: "new" },
};
const spec = (action: unknown) => ({
  id: "keyed",
  window: { placement: { type: "fullscreen" } },
  data: { rows: [{ id: 1, title: "old" }] },
  state: { selected: 1 },
  root: { type: "button", label: "Edit", onTap: [action] },
});

test.each([{ value: 1 }, { state: "selected" }, { data: "/rows/0/id" }])(
  "keyed selectors accept runtime binding %j",
  (equals) => {
    const action = { ...keyed, where: { field: "id", equals } };
    expect(actionSchema.safeParse(action).success).toBe(true);
    expect(validatePrototypeSpec(spec(action)).success).toBe(true);
  },
);

for (const action of [
  { ...keyed, where: { field: "", equals: { value: 1 } } },
  { ...keyed, where: { field: "a/b", equals: { value: 1 } } },
  { ...keyed, where: { field: "a~b", equals: { value: 1 } } },
  { ...keyed, where: { field: "id", equals: { value: 1 }, extra: true } },
  { ...keyed, where: { field: "id", equals: { value: 1, extra: true } } },
  { ...keyed, where: { field: "id" } },
  { ...keyed, member: "" },
  { ...keyed, member: "a/b" },
  { ...keyed, member: "a~b" },
  { ...keyed, extra: true },
  { type: "removeData", path: keyed.path, where: keyed.where, member: "title" },
  { type: "appendData", path: keyed.path, value: keyed.value, where: keyed.where },
  { type: "prependData", path: keyed.path, value: keyed.value, where: keyed.where },
  { type: "upsertData", path: keyed.path, key: "/id", value: keyed.value, where: keyed.where },
]) {
  test(`keyed schema rejects ${JSON.stringify(action)}`, () => {
    expect(actionSchema.safeParse(action).success).toBe(false);
    expect(validatePrototypeSpec(spec(action)).success).toBe(false);
  });
}

test("member requires where and keyed paths must address an array", () => {
  expect(validatePrototypeSpec(spec({ ...keyed, where: undefined })).success).toBe(false);
  expect(validatePrototypeSpec(spec({ ...keyed, path: "/data/rows/0" })).success).toBe(false);
  expect(
    validatePrototypeSpec(spec({ type: "removeData", path: keyed.path, where: keyed.where }))
      .success,
  ).toBe(true);
});

test.each(["android", "ios"] as const)(
  "keyed writes refuse older %s devices before show",
  (platform) => {
    const required = prototypeRequiredCapabilities(spec(keyed));
    const gate = required.find((entry) => entry.capability === "prototype_data_actions_v2");
    expect(gate?.fields).toEqual(["root.onTap[0]"]);
    const message = gate?.unsupportedMessage(gate.fields, platform);
    expect(message).toContain("prototype_data_actions_v2");
    expect(message).toContain("Nothing was shown.");
    expect(message).toContain(
      platform === "ios" ? "launchApp prototype: true" : "Update the connected CtrlProxy",
    );
  },
);

test("keyed writes preserve every frame even when selectors share an array path", () => {
  const frames = [[keyed], [{ ...keyed, where: { field: "id", equals: { value: 2 } } }]];
  expect(coalescePrototypeChannelFrames(frames)).toEqual(frames);
  expect(coalescePrototypeChannelFrames([[keyed], [keyed]])).toEqual([[keyed], [keyed]]);
});

test.each([{ item: "id" }, { index: true }])("keyed selector binds repeat source %j", (equals) => {
  const candidate = {
    ...spec(keyed),
    root: {
      type: "column",
      repeat: { items: { path: "/rows" }, as: "row" },
      children: [
        { type: "button", label: "Edit", onTap: [{ ...keyed, where: { field: "id", equals } }] },
      ],
    },
  };
  expect(validatePrototypeSpec(candidate).success).toBe(true);
  const bound = bindNodeFields(candidate.root.children[0], "root", {
    binding: { alias: "row", index: true },
    values: { id: 1 },
    index: 0,
  });
  expect(bound).toMatchObject({
    onTap: [{ where: { field: "id", equals: { value: "item" in equals ? 1 : 0 } } }],
  });
});
