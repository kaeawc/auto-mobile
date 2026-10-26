import { expect, test } from "bun:test";
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

function harness(delay = 150, mutation: string | ((value: string) => string) = "\n") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let value = "";
  let pendingAt = Infinity;
  const reads: Parameters<SendKeysObserver["execute"]>[0][] = [];
  const observer: SendKeysObserver = {
    execute: async (options) => {
      reads.push(options);
      if (timer.now() >= pendingAt) {
        value = typeof mutation === "function" ? mutation(value) : value + mutation;
        pendingAt = Infinity;
      }
      return buildObserveResult({
        updatedAt: timer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: {
          hierarchy: {
            node: { $: { focused: "true", class: "android.widget.EditText", text: value } },
          },
        },
      });
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
