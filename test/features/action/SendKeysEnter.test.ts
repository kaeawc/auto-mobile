import { expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { buildObserveResult } from "../../helpers/observeFixture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness } from "./SendKeysTestHarness";
import {
  DefaultSendKeysCommandExecutor,
  type SendKeysCommand,
  type SendKeysObserver,
  type SendKeysTypingMode,
} from "../../../src/features/action/SendKeys";
import { CommandRunner } from "../../../src/features/action/sendkeys/CommandRunner";
import { TargetState } from "../../../src/features/action/sendkeys/TargetState";
import { isSemanticKey } from "../../../src/features/action/sendkeys/SendKeysSupport";

type PostEnterRead = () => ObserveResult;

function fieldObservation(
  updatedAt: number,
  text: string,
  attrs: Record<string, string> = {},
): ObserveResult {
  return buildObserveResult({
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      hierarchy: {
        node: { $: { focused: "true", class: "android.widget.EditText", text, ...attrs } },
      },
    },
  });
}

function harness(
  delay = 150,
  mutation: string | ((value: string) => string) = "\n",
  /** Reads served (in order) after enter is dispatched, before the field-backed observations. */
  postEnter: PostEnterRead[] = [],
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let value = "";
  let pendingAt = Infinity;
  let enterDispatched = false;
  const reads: Parameters<SendKeysObserver["execute"]>[0][] = [];
  const observer: SendKeysObserver = {
    execute: async (options) => {
      reads.push(options);
      const scripted = enterDispatched ? postEnter.shift() : undefined;
      if (scripted) {
        return scripted();
      }
      if (timer.now() >= pendingAt) {
        value = typeof mutation === "function" ? mutation(value) : value + mutation;
        pendingAt = Infinity;
      }
      return fieldObservation(timer.now(), value, { "resource-id": "a" });
    },
  };
  const h = createSendKeysHarness(android, observer, timer);
  const inserted: string[] = [];
  h.client.clear = async () => {
    value = "";
    return { success: true };
  };
  h.client.insert = async (text) => {
    // Like request_insert_text, planning uses the node's current snapshot, even when
    // an acknowledged enter has not yet appeared there.
    value += text;
    pendingAt = Infinity;
    inserted.push(text);
    return { success: true };
  };
  h.client.commitViaIme = async (text) => {
    value += text;
    return { success: true };
  };
  const executor = new DefaultSendKeysCommandExecutor(android, h.adbFactory, observer, {
    timer,
    textClient: h.client,
    inputKey: {
      press: async () => {
        pendingAt = timer.now() + delay;
        enterDispatched = true;
        return { success: true };
      },
    },
  });
  const runner = new CommandRunner({
    device: android,
    adbFactory: h.adbFactory,
    executor,
    timer,
    target: new TargetState(),
    isSemanticKey,
    prototypeTextTarget: {
      read: async () => ({ kind: "unverifiable", reason: "not a prototype" }),
    },
  });
  const run = (mode: SendKeysTypingMode = "a11y", enter = true) => {
    const commands: SendKeysCommand[] = [
      { action: "clear", mode: "a11y" },
      { action: "type", text: "one", mode },
      ...(enter ? [{ action: "key", key: "enter" } satisfies SendKeysCommand] : []),
      { action: "type", text: "two", mode },
    ];
    return runner.executeCommands(commands);
  };
  return { run, timer, reads, inserted, value: () => value };
}

test("a11y insert waits for the enter mutation instead of overwriting it", async () => {
  const h = harness();
  const result = await h.run();
  expect(h.value()).toBe("one\ntwo");
  expect(result.failure).toBeUndefined();
  expect(h.timer.now()).toBe(150);
  expect(h.reads.filter((read) => read?.freshness === "fresh").length).toBeGreaterThan(0);
});

test("unconfirmed enter stops before another a11y insert with partial-application guidance", async () => {
  const h = harness(Infinity);
  const result = await h.run();
  expect(result.failure).toBeDefined();
  expect(result.results.at(-1)).toMatchObject({
    success: false,
    partialApplication: true,
    retryable: false,
  });
  expect(result.failure?.error).toContain("newline");
  expect(result.failure?.error).toContain("do not retry");
  expect(h.inserted).toEqual(["one"]);
  expect(h.timer.now()).toBe(300);
});

test("an already visible enter needs no settle sleep", async () => {
  const h = harness(0);
  const result = await h.run();
  expect(result.failure).toBeUndefined();
  expect(h.value()).toBe("one\ntwo");
  expect(h.timer.now()).toBe(0);
});

test("a11y sequence without enter keeps its existing behavior", async () => {
  const h = harness();
  expect((await h.run("a11y", false)).failure).toBeUndefined();
  expect(h.value()).toBe("onetwo");
  expect(h.timer.now()).toBe(0);
});

for (const mode of ["ime", "auto"] as const) {
  test(`${mode} sequence retains its existing delivery without the a11y settle poll`, async () => {
    const h = harness(Infinity);
    const result = await h.run(mode);
    expect(result.failure).toBeUndefined();
    expect(h.inserted).toEqual([]);
    expect(h.timer.now()).toBe(0);
  });
}

test("an unrelated field change does not confirm a newline", async () => {
  const h = harness(0, "!");
  const result = await h.run();
  expect(result.failure?.index).toBe(2);
  expect(result.results.at(-1)).toMatchObject({
    action: "key",
    success: false,
    partialApplication: true,
  });
  expect(h.inserted).toEqual(["one"]);
});

test("an enter that submits and clears the field is accepted", async () => {
  const h = harness(0, () => "");
  const result = await h.run();
  expect(result.failure).toBeUndefined();
  expect(h.inserted).toEqual(["one", "two"]);
});

const STALE: PostEnterRead = () => ({
  ...fieldObservation(0, "one", { "resource-id": "a" }),
  freshness: { isFresh: false, category: "cache_age" },
});
const HIERARCHY_ERROR: PostEnterRead = () =>
  buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: { hierarchy: { error: "accessibility service unavailable" } },
  });

test("a stale post-enter observation is retried instead of confirming the newline", async () => {
  const h = harness(150, "\n", [STALE, HIERARCHY_ERROR]);
  const result = await h.run();
  expect(result.failure).toBeUndefined();
  expect(h.value()).toBe("one\ntwo");
  expect(h.timer.now()).toBe(300);
});

test("enter that stays unavailable reports partial application without a further insert", async () => {
  const h = harness(0, "\n", [STALE, HIERARCHY_ERROR, STALE]);
  const result = await h.run();
  expect(result.failure?.error).toContain("fresh observations were unavailable");
  expect(result.results.at(-1)).toMatchObject({
    action: "key",
    success: false,
    partialApplication: true,
    retryable: false,
  });
  expect(h.inserted).toEqual(["one"]);
});

test("a fresh observation without a focused field still confirms (focus left)", async () => {
  const noFocus: PostEnterRead = () =>
    buildObserveResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: { hierarchy: { node: { $: { class: "android.widget.FrameLayout" } } } },
    });
  const h = harness(Infinity, "\n", [noFocus]);
  expect((await h.run()).failure).toBeUndefined();
});

for (const [name, destination] of [
  ["identical", "one"],
  ["baseline-prefixed", "one two"],
] as const) {
  test(`a focus move to another field with ${name} text confirms enter`, async () => {
    const moved: PostEnterRead = () => fieldObservation(0, destination, { "resource-id": "b" });
    const h = harness(Infinity, "\n", [moved]);
    const result = await h.run();
    expect(result.failure).toBeUndefined();
    expect(h.timer.now()).toBe(0);
  });
}

test("the same field with an unchanged identity and text is still unconfirmed", async () => {
  const same: PostEnterRead = () => fieldObservation(0, "one", { "resource-id": "a" });
  const h = harness(Infinity, "\n", [same, same, same]);
  expect((await h.run()).failure?.error).toContain("newline");
});
