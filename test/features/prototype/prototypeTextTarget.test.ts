import { expect, test } from "bun:test";
import {
  AndroidPrototypeTextTargetReader,
  IosPrototypeTextTargetReader,
  InMemoryPrototypeTextFieldBindings,
  prototypeTextFieldKeys,
  verifyPrototypeTextTarget,
} from "../../../src/features/prototype/prototypeTextTarget";
import {
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../../../src/features/prototype/prototypeSpec";
import { FakePrototypeAgentClient } from "../../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  capturedFloatingCoverHierarchy,
  observationOf,
} from "../../helpers/prototypeWindowCapture";

const spec = prototypeSpecSchema.parse({
  id: "panel",
  window: { placement: { type: "fullscreen" } },
  root: { type: "textField", id: "id", testTag: "ptf", stateKey: "name" },
});

test("text-field keys walk every nested object/array slot and keep both identifiers", () => {
  // Extra future slot shapes intentionally exercise the generic traversal contract.
  const nested = {
    ...spec,
    root: {
      type: "column",
      children: [spec.root],
      slot: { body: { child: { type: "textField", id: "deep", stateKey: "other" } } },
    },
  } as PrototypeSpec;
  expect([...prototypeTextFieldKeys(nested)]).toEqual([
    ["ptf", "name"],
    ["id", "name"],
    ["deep", "other"],
  ]);
});

test("placeholder identifiers/keys and conflicting identifiers are dropped permanently", () => {
  const root = {
    type: "column",
    children: [
      { type: "textField", id: "same", testTag: "a", stateKey: "first" },
      { type: "textField", id: "same", testTag: "b", stateKey: "second" },
      { type: "textField", id: "same", stateKey: "first" },
      { type: "textField", id: "{item.id}", testTag: "stable", stateKey: "ok" },
      { type: "textField", id: "key-placeholder", stateKey: "{item.key}" },
      { type: "textField", id: "stable", stateKey: "ok" },
      { type: "text", id: "not-field", stateKey: "no" },
    ],
  };
  expect([...prototypeTextFieldKeys({ ...spec, root } as PrototypeSpec)]).toEqual([
    ["a", "first"],
    ["b", "second"],
    ["stable", "ok"],
  ]);
});

test("record replaces a device's bindings and leaves other devices intact", () => {
  const bindings = new InMemoryPrototypeTextFieldBindings();
  bindings.record("one", spec);
  bindings.record("two", spec);
  bindings.record("one", { ...spec, id: "new", root: { type: "text", text: "empty" } });
  expect(bindings.forDevice("one")?.prototypeId).toBe("new");
  expect(bindings.forDevice("one")?.keys.size).toBe(0);
  expect(bindings.forDevice("two")?.keys.get("ptf")).toBe("name");
  bindings.clear();
  expect(bindings.forDevice("two")).toBeUndefined();
});

test("iOS missing state key is empty and signals are checked before requests", async () => {
  const bindings = new InMemoryPrototypeTextFieldBindings();
  bindings.record("ios", spec);
  const agent = new FakePrototypeAgentClient();
  agent.queueReplies({ status: { shown: true, id: "panel", state: {} } });
  const reader = new IosPrototypeTextTargetReader({
    deviceId: "ios",
    bindings,
    connections: { get: () => agent },
  });
  expect(await reader.read({ identifiers: ["ptf"] })).toEqual({
    kind: "value",
    source: "state",
    stateKey: "name",
    value: "",
  });
  const controller = new AbortController();
  controller.abort(new Error("aborted"));
  expect(await reader.read({ identifiers: ["id"] }, controller.signal)).toMatchObject({
    kind: "unverifiable",
    reason: "prototype status request failed: aborted",
  });
  expect(agent.requests).toHaveLength(1);
});

const capture = capturedFloatingCoverHierarchy();
function fieldFrame(
  value: string,
  options: { hint?: string; secure?: boolean; focused?: boolean } = {},
) {
  const hierarchy = structuredClone(capture);
  const roots = hierarchy.hierarchy.node!;
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (Number(root.windowId) === 170) {
      root.node = [
        {
          $: {
            class: "android.widget.EditText",
            text: value,
            focused: String(options.focused ?? true),
            password: String(options.secure ?? false),
            "hint-text": options.hint,
          },
        },
      ];
    }
  }
  return observationOf(hierarchy);
}

for (const row of [
  { value: "Placeholder", hint: "Placeholder", expected: "" },
  { value: "typed", hint: "Placeholder", expected: "typed" },
  { value: "", expected: "" },
]) {
  test(`Android focused field reads hint-aware ${JSON.stringify(row)}`, async () => {
    const signal = new AbortController().signal;
    const calls: unknown[] = [];
    const reader = new AndroidPrototypeTextTargetReader({
      execute: async (options) => {
        calls.push(options);
        return fieldFrame(row.value, row);
      },
    });
    expect(await reader.read({ identifiers: ["ptf"], display: "inner" }, signal)).toEqual({
      kind: "value",
      source: "field",
      value: row.expected,
    });
    expect(calls).toEqual([
      { hierarchyOnly: true, skipScreenshot: true, freshness: "fresh", display: "inner", signal },
    ]);
  });
}

for (const options of [{ secure: true }, { focused: false }]) {
  test(`Android unreadable prototype field ${JSON.stringify(options)}`, async () => {
    const reader = new AndroidPrototypeTextTargetReader({
      execute: async () => fieldFrame("secret", options),
    });
    expect(await reader.read({ identifiers: [] })).toEqual({
      kind: "unverifiable",
      reason: "no focused readable prototype text field",
    });
  });
}

test("Android failed observation returns typed unverifiable reason", async () => {
  const reader = new AndroidPrototypeTextTargetReader({
    execute: async () => {
      throw new Error("offline");
    },
  });
  expect(await reader.read({ identifiers: [] })).toEqual({
    kind: "unverifiable",
    reason: "prototype observation failed: offline",
  });
});

test("a custom reader exception warns without failing acknowledged typing", async () => {
  const result = await verifyPrototypeTextTarget({
    reader: {
      read: async () => {
        throw new Error("offline");
      },
    },
    target: { identifiers: [] },
    text: "typed",
    operation: "replace",
    timer: new FakeTimer(),
    settleMs: 150,
  });
  expect(result).toEqual({
    success: true,
    warning: "Typed text was not verified against the prototype: offline",
  });
});

const numericCases: Array<[string, number, string, boolean]> = [
  [" ", 0, "0", false],
  ["0x0", 0, "0", false],
  ["0", 0, "0", true],
  ["-3", -3, "-3", true],
  ["1.50", 1.5, "1.5", true],
  [".5", 0.5, "0.5", true],
  ["1.", 1, "1", true],
  ["+5", 5, "5", true],
  ["5\n", 5, "5", true],
  ["-0", 0, "0", true],
  ["", 0, "0", false],
  ["1e3", 1000, "1000", false],
  ["+", 0, "0", false],
  [".", 0, "0", false],
  [" 5", 5, "5", false],
  ["5 ", 5, "5", false],
  ["1 0", 10, "10", false],
  ["Infinity", Infinity, "inf", false],
  ["NaN", 0, "0", false],
];
for (const [text, numericValue, value, accepted] of numericCases) {
  test(`numeric truth ${accepted ? "accepts" : "rejects"} ${JSON.stringify(text)}`, async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const result = await verifyPrototypeTextTarget({
      reader: {
        read: async () => ({
          kind: "value",
          source: "state",
          stateKey: "name",
          value,
          numericValue,
        }),
      },
      target: { identifiers: ["ptf"] },
      text,
      operation: "replace",
      timer,
      settleMs: 1,
    });
    expect(result.success).toBe(accepted);
  });
}

test("forget only drops the named device binding", () => {
  const bindings = new InMemoryPrototypeTextFieldBindings();
  bindings.record("one", spec);
  bindings.record("two", spec);
  bindings.forget("one");
  expect(bindings.forDevice("one")).toBeUndefined();
  expect(bindings.forDevice("two")?.keys.get("ptf")).toBe("name");
});
