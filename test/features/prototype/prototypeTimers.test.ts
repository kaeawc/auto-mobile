import {
  prototypeTimerFields,
  prototypeTimerWarnings,
} from "../../../src/features/prototype/prototypeTimers";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";
import { parsePrototypeTimerReports } from "../../../src/features/prototype/prototypeTimerSchema";
import { expect, test } from "bun:test";
import { actionSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
const timer = {
  type: "startTimer",
  id: "tick",
  afterMs: 100,
  actions: [{ type: "emit", name: "tick" }],
};
const spec = (actions: unknown[]) => ({
  id: "timers",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Tick", onTap: actions },
});
test("timer schema bounds and nested actions", () => {
  expect(actionSchema.safeParse(timer).success).toBe(true);
  for (const changes of [
    { everyMs: 99 },
    { everyMs: 3600001 },
    { maxRuns: 0 },
    { maxRuns: 10001 },
    { maxRuns: 1.5 },
    { id: "" },
    { id: "x".repeat(65) },
    { actions: [] },
    { extra: true },
  ]) {
    expect(actionSchema.safeParse({ ...timer, ...changes }).success).toBe(false);
  }
  expect(actionSchema.safeParse({ ...timer, id: "x".repeat(64) }).success).toBe(true);
  for (const afterMs of [99, 3600001, 100.5]) {
    expect(actionSchema.safeParse({ ...timer, afterMs }).success).toBe(false);
  }
  expect(
    actionSchema.safeParse({
      ...timer,
      afterMs: 3600000,
      everyMs: 100,
      maxRuns: 10000,
      actions: [timer],
    }).success,
  ).toBe(true);
  expect(actionSchema.safeParse({ type: "cancelTimer", id: "tick" }).success).toBe(true);
});
test("maxRuns requires everyMs at its exact action path", () => {
  expect(validatePrototypeSpec(spec([{ ...timer, maxRuns: 1 }]))).toMatchObject({
    success: false,
    error: { path: "root.onTap[0].maxRuns" },
  });
});
test("ninth distinct timer id is refused; replacement ids are allowed", () => {
  expect(
    validatePrototypeSpec(spec(Array.from({ length: 9 }, (_, i) => ({ ...timer, id: String(i) })))),
  ).toMatchObject({ success: false, error: { path: "root.onTap[8].id" } });
  expect(validatePrototypeSpec(spec(Array.from({ length: 9 }, () => timer))).success).toBe(true);
});

test("gate locates nested timers, follow-ups, handlers and unused components", () => {
  const input = {
    ...spec([{ ...timer, actions: [timer, { type: "cancelTimer", id: "tick" }] }]),
    components: { unused: { root: { type: "button", label: "Go", onTap: [timer] } } },
    platform: {
      on: {
        "test.tick": [
          { type: "request", url: "https://example.com", onSuccess: [timer] },
          { type: "platform", call: "test.echo", onError: [timer] },
        ],
      },
    },
  };
  expect(prototypeTimerFields(input)).toEqual([
    "root.onTap[0]",
    "root.onTap[0].actions[0]",
    "root.onTap[0].actions[1]",
    'platform.on["test.tick"][0].onSuccess[0]',
    'platform.on["test.tick"][1].onError[0]',
    "components.unused.root.onTap[0]",
  ]);
});
test("cancel advisory sees declarations in every container and permits unknown ids", () => {
  const input = {
    ...spec([
      { type: "cancelTimer", id: "missing" },
      { type: "cancelTimer", id: "tick" },
    ]),
    requires: { platform: ["test"] },
    platform: { on: { "test.tick": [timer] } },
  };
  expect(validatePrototypeSpec(input).success).toBe(true);
  expect(prototypeTimerWarnings(input)).toEqual([
    'root.onTap[0]: cancelTimer id "missing" has no matching startTimer; cancelling it is a no-op.',
  ]);
});
test("timer ids stay literal while nested actions bind repeat operands", () => {
  const result = bindNodeFields(
    {
      type: "button",
      onTap: [{ ...timer, id: "{item.name}", actions: [{ type: "emit", name: "{item.name}" }] }],
    },
    "root",
    { binding: { alias: "item", index: true }, values: { name: "bound" }, index: 0 },
  );
  expect(result.onTap).toEqual([
    { ...timer, id: "{item.name}", actions: [{ type: "emit", name: "bound" }] },
  ]);
});
test("timer report parsing drops malformed reports", () => {
  expect(parsePrototypeTimerReports([{ id: "tick", nextFireInMs: 100, runs: 10001 }])).toEqual([
    { id: "tick", nextFireInMs: 100, runs: 10001 },
  ]);
  expect(parsePrototypeTimerReports([{ id: "tick", nextFireInMs: 0, runs: 1 }])).toEqual([
    { id: "tick", nextFireInMs: 0, runs: 1 },
  ]);
  for (const report of [
    [{ id: "tick", nextFireInMs: -1, runs: 0 }],
    [{ id: "tick", nextFireInMs: 1, runs: 1.5 }],
    {},
  ]) {
    expect(parsePrototypeTimerReports(report)).toBeUndefined();
  }
});

test("unused component timer declarations count toward the static id cap", () => {
  const input = {
    ...spec(Array.from({ length: 8 }, (_, i) => ({ ...timer, id: String(i) }))),
    components: {
      unused: { root: { type: "button", label: "Go", onTap: [{ ...timer, id: "ninth" }] } },
    },
  };
  expect(validatePrototypeSpec(input)).toMatchObject({
    success: false,
    error: { path: "components.unused.root.onTap[0].id" },
  });
});
test("handler timers and nested timers participate in cross-field checks", () => {
  const input = {
    ...spec([timer]),
    requires: { platform: ["test"] },
    platform: { on: { "test.tick": [{ ...timer, actions: [{ ...timer, maxRuns: 1 }] }] } },
  };
  expect(validatePrototypeSpec(input)).toMatchObject({
    success: false,
    error: { path: 'platform.on["test.tick"][0].actions[0].maxRuns' },
  });
});
