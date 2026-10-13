import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
  SendKeys,
  IME_COMMIT_READ_BACK_SETTLE_MS,
  type SendKeysCommand,
  type SendKeysDependencies,
  type SendKeysSelector,
} from "../../../src/features/action/SendKeys";
import {
  IosPrototypeTextTargetReader,
  InMemoryPrototypeTextFieldBindings,
  type PrototypeTextTargetReader,
} from "../../../src/features/prototype/prototypeTextTarget";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { android, ios, createSendKeysHarness } from "./SendKeysTestHarness";
import { typedObservation } from "./IosTypedTextTestHarness";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import type { ViewHierarchyNode, ObserveResult } from "../../../src/models";
import {
  capturedFloatingCoverHierarchy,
  observationOf,
} from "../../helpers/prototypeWindowCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakePrototypeAgentClient } from "../../fakes/FakePrototypeAgentClient";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import {
  registerInteractionTools,
  setSendKeysFactory,
  resetSendKeysFactory,
} from "../../../src/server/interactionTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();
const textSpec = prototypeSpecSchema.parse({
  id: "panel",
  window: { placement: { type: "fullscreen" } },
  root: { type: "textField", id: "field-id", testTag: "ptf", stateKey: "name" },
});
const commands: SendKeysCommand[] = [{ action: "type", text: "Rb one", mode: "ime" }];
const captured = capturedFloatingCoverHierarchy();
// Compose the captured prototype window with the app EditText from the defect report.
// Preserve captured window/root metadata; compose the field nodes beneath those roots.
const androidFrames = new Map<string, ObserveResult>();
function androidFrame(value: string, focused = true, secure = false, hint?: string) {
  const key = JSON.stringify([value, focused, secure, hint]);
  const cached = androidFrames.get(key);
  if (cached) {
    return cached;
  }
  const hierarchy = structuredClone(captured);
  const roots = hierarchy.hierarchy.node!;
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (Number(root.windowId) === 170) {
      root.node = [
        {
          $: {
            class: "android.widget.EditText",
            focused: String(focused),
            text: value,
            password: String(secure),
            "hint-text": hint,
            "resource-id": "ptf",
          },
        },
      ];
    } else if (Number(root.windowId) === 150) {
      root.node = [
        {
          $: {
            class: "android.widget.EditText",
            focused: "true",
            text: "First name",
            "hint-text": "First name",
          },
        },
      ];
    }
  }
  const frame = {
    ...observationOf(hierarchy),
    focusedElement: {
      focused: true,
      text: "First name",
      "hint-text": "First name",
      class: "android.widget.EditText",
    },
  };
  androidFrames.set(key, frame);
  return frame;
}

// Compose the captured iOS editable node under an agent-marked prototype window.
const iosField = (() => {
  const parser = new DefaultElementParser();
  let field: ViewHierarchyNode | undefined;
  for (const root of parser.extractRootNodes(typedObservation("old").viewHierarchy!)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attributes = nodeAttributes(node);
      if (attributes.focused === "true" && attributes["hint-text"] === "Email") {
        field = node;
      }
    });
  }
  if (!field) {
    throw new Error("Captured iOS field missing");
  }
  return field;
})();
function iosPrototypeObservation(value: string) {
  const field = structuredClone(iosField);
  nodeAttributes(field).value = value;
  return {
    timestamp: 1,
    viewHierarchy: {
      hierarchy: {
        node: {
          className: "UIWindow",
          "resource-id": "automobile-prototype-window",
          node: [field],
        },
      },
    },
  };
}

function harness(
  platform: "android" | "ios",
  options: {
    value?: string;
    focused?: boolean;
    secure?: boolean;
    reader?: PrototypeTextTargetReader;
    focus?: SendKeysDependencies["focuser"];
  } = {},
) {
  const device = platform === "android" ? android : ios;
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let draft = "old";
  const reads: Array<Parameters<NonNullable<SendKeysDependencies["observer"]>["execute"]>[0]> = [];
  const frame =
    platform === "android"
      ? androidFrame(options.value ?? "Rb one", options.focused, options.secure)
      : iosPrototypeObservation("old");
  const observer = {
    execute: async (options = {}) => {
      reads.push(options);
      if (platform === "android") {
        return frame;
      }
      return iosPrototypeObservation(draft);
    },
  };
  const h = createSendKeysHarness(device, observer, timer);
  h.client.clear = async () => {
    draft = "";
    return { success: true };
  };
  const insert = h.client.insert;
  h.client.insert = async (...args) => {
    draft = args[0];
    return insert(...args);
  };
  const keyboardCalls: string[] = [];
  const action = new SendKeys(device, h.adbFactory, {
    observer,
    executor: h.executor,
    timer,
    prototypeTextTarget: options.reader,
    timestampProvider: { now: async () => 1 },
    focuser: options.focus ?? {
      focus: async () => ({ success: true, passwordField: options.secure }),
    },
    keyboard: {
      execute: async (action) => {
        keyboardCalls.push(action);
        return { success: true };
      },
    },
  });
  const run = (
    layer: "prototype" | "app" | undefined = "prototype",
    input = commands,
    selector: SendKeysSelector = { elementId: "ptf" },
  ) => action.execute(input, selector, undefined, undefined, undefined, { layer });
  return { ...h, action, run, reads, timer, keyboardCalls, observer };
}

function iosReader(values: unknown[] = ["Rb one"]) {
  const bindings = new InMemoryPrototypeTextFieldBindings();
  bindings.record(ios.deviceId, textSpec);
  const agent = new FakePrototypeAgentClient();
  agent.queueReplies(
    ...values.map((value) => ({ status: { shown: true, id: "panel", state: { name: value } } })),
  );
  const reader = new IosPrototypeTextTargetReader({
    deviceId: ios.deviceId,
    connections: { get: () => agent },
    bindings,
  });
  return { reader, agent, bindings };
}

// Warm imported IME catalog/ICU paths outside the per-test 15ms budget.
beforeAll(async () => {
  registerInteractionTools();
  await harness("android").run();
});
afterEach(() => resetSendKeysFactory());

test("Android prototype never compares the focused app field behind it", async () => {
  const h = harness("android");
  const result = await h.run();
  expect(result.success).toBe(true);
  expect(result.commands[0]?.imeFailure).toBeUndefined();
  expect(result.commands[0]?.warning).toBeUndefined();
  expect(result.error).toBeUndefined();
});

test("Android missing prototype focus is unverifiable, never a failed commit", async () => {
  const result = await harness("android", { focused: false }).run();
  expect(result.success).toBe(true);
  expect(result.commands[0]?.warning).toContain(
    "not verified against the prototype: no focused readable prototype",
  );
  expect(result.commands[0]?.imeFailure).toBeUndefined();
});

for (const focused of [true, false]) {
  test(`Android auto-mode pre-read scopes out an app password field (${focused})`, async () => {
    const h = harness("android", { focused });
    const observe = h.observer.execute;
    h.observer.execute = async (options) => {
      const observation = await observe(options);
      return { ...observation, focusedElement: { ...observation.focusedElement, password: true } };
    };
    const result = await h.run("prototype", [{ action: "type", text: "Rb one", mode: "auto" }]);
    expect(result.success).toBe(true);
    expect(result.commands[0]?.resolvedMode).toBe("ime");
    expect(h.committed).toEqual(["Rb one"]);
    expect(result.commands[0]?.imeFailure).toBeUndefined();
    expect(Boolean(result.commands[0]?.warning)).toBe(!focused);
  });
}

test("Android refused and reverted text fails with stored value and final observation", async () => {
  const h = harness("android", { value: "stored" });
  const result = await h.run();
  expect(result).toMatchObject({ success: false, failedIndex: 0, completedCommands: 0 });
  expect(result.commands[0]).toMatchObject({
    success: false,
    partialApplication: true,
    imeFailure: { stage: "verification", expectedText: "Rb one", observedText: "stored" },
  });
  expect(result.error).toBe(
    'Prototype refused the text: sent "Rb one" but the prototype field holds "stored"',
  );
  expect(result.commands[0]?.retryable).toBeUndefined();
  expect(result.observation).toBeDefined();
  expect(h.timer.getSleepHistory()).toEqual([
    IME_COMMIT_READ_BACK_SETTLE_MS,
    IME_COMMIT_READ_BACK_SETTLE_MS,
  ]);
});

test("iOS accepted state is verified in exactly one status request with no warning", async () => {
  const r = iosReader();
  const result = await harness("ios", { reader: r.reader }).run();
  expect(result.success).toBe(true);
  expect(result.commands[0]?.warning).toBeUndefined();
  expect(r.agent.requests.map((request) => request.type)).toEqual(["get_prototype_status"]);
});

test("iOS prototype refuses stored state while its draft still shows typed text", async () => {
  const r = iosReader(["old", "old", "old"]);
  const h = harness("ios", { reader: r.reader });
  const times: number[] = [];
  const read = r.reader.read.bind(r.reader);
  r.reader.read = async (...args) => {
    times.push(h.timer.now());
    return read(...args);
  };
  const result = await h.run();
  expect(result).toMatchObject({ success: false, failedIndex: 0, completedCommands: 0 });
  expect(result.commands[0]).toMatchObject({
    success: false,
    partialApplication: true,
    imeFailure: { expectedText: "Rb one", observedText: "old", stage: "verification" },
  });
  expect(result.error).toBe(
    'Prototype refused the text: sent "Rb one" but prototype state key "name" holds "old"; the field keeps showing the typed text until editing ends',
  );
  expect(result.observation).toBeDefined();
  expect(result.commands[0]?.retryable).toBeUndefined();
  expect(h.clientCalls).toEqual(["insert:Rb one"]);
  expect(h.keyboardCalls).toEqual([]);
  expect(r.agent.requests.map((request) => request.type)).toEqual(
    Array(3).fill("get_prototype_status"),
  );
  expect(times).toEqual([0, IME_COMMIT_READ_BACK_SETTLE_MS, 2 * IME_COMMIT_READ_BACK_SETTLE_MS]);
});

test("iOS late acceptance wins on the second read", async () => {
  const r = iosReader(["old", "Rb one"]);
  const h = harness("ios", { reader: r.reader });
  expect((await h.run()).success).toBe(true);
  expect(r.agent.requests).toHaveLength(2);
  expect(h.timer.getSleepHistory()).toEqual([IME_COMMIT_READ_BACK_SETTLE_MS]);
});

for (const variant of [
  "connection",
  "binding",
  "device binding",
  "id",
  "hidden",
  "malformed",
  "throws",
  "failed",
] as const) {
  test(`iOS unverifiable ${variant} preserves success and explains why`, async () => {
    const r = iosReader([]);
    const reasons = {
      connection: "no prototype agent connection",
      binding: "no text-field binding",
      "device binding": "no shown prototype bindings",
      id: "different prototype id",
      hidden: "not shown",
      malformed: "malformed",
      throws: "broken",
      failed: "denied",
    };
    if (variant === "device binding") {
      r.bindings.clear();
    }
    const reader = new IosPrototypeTextTargetReader({
      deviceId: ios.deviceId,
      bindings: r.bindings,
      connections: { get: () => (variant === "connection" ? undefined : r.agent) },
    });
    r.agent.queueReplies(
      variant === "throws"
        ? new Error("broken")
        : variant === "failed"
          ? { success: false, error: "denied" }
          : {
              status:
                variant === "malformed"
                  ? { state: [] }
                  : {
                      shown: variant !== "hidden",
                      id: variant === "id" ? "other" : "panel",
                      state: {},
                    },
            },
    );
    const result = await harness("ios", { reader }).run("prototype", commands, {
      elementId: variant === "binding" ? "unknown" : "ptf",
    });
    expect(result.success).toBe(true);
    expect(result.commands[0]?.warning).toContain(
      `Typed text was not verified against the prototype: `,
    );
    expect(result.commands[0]?.warning).toContain(reasons[variant]);
    expect(result.commands[0]?.imeFailure).toBeUndefined();
  });
}

for (const row of [
  { operation: "replace", text: "Rb one", value: "Rb one", success: true },
  { operation: "replace", text: "Rb one", value: "prefix Rb one", success: false },
  { operation: "insert", text: "Rb one", value: "prefix Rb one suffix", success: true },
  { operation: "replace", text: "Rb one\n", value: "Rb one", success: true },
  { operation: "insert", text: "Rb one\n", value: "prefix Rb one", success: true },
  { operation: "replace", text: "01", value: 1, success: true },
  { operation: "replace", text: "true", value: true, success: true },
  { operation: "replace", text: "01", value: "1", success: false },
] as const) {
  test(`prototype ${row.operation} comparison ${JSON.stringify(row)}`, async () => {
    const r = iosReader(Array(3).fill(row.value));
    const result = await harness("ios", { reader: r.reader }).run("prototype", [
      { action: "type", text: row.text, operation: row.operation },
    ]);
    expect(result.success).toBe(row.success);
    if (row.success) {
      expect(result.commands[0]?.warning).toBeUndefined();
    }
  });
}

for (const platform of ["android", "ios"] as const) {
  for (const layer of [undefined, "app"] as const) {
    test(`${platform} ${layer ?? "implicit"} layer adds no reader calls or observations`, async () => {
      let calls = 0;
      const reader: PrototypeTextTargetReader = {
        read: async () => {
          calls++;
          return { kind: "unverifiable", reason: "unused" };
        },
      };
      const baseline = harness(platform);
      const baselineResult = await baseline.action.execute(commands, { elementId: "ptf" });
      const h = harness(platform, { reader });
      expect(
        await h.action.execute(commands, { elementId: "ptf" }, undefined, undefined, undefined, {
          layer,
        }),
      ).toEqual(baselineResult);
      expect(h.reads).toHaveLength(baseline.reads.length);
      expect(calls).toBe(0);
    });
  }
}

test("layer is reset between calls on the same executor", async () => {
  const h = harness("android");
  expect((await h.run()).success).toBe(true);
  const result = await h.action.execute(commands, { elementId: "ptf" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("focused field holds");
});

for (const selector of [{ text: "Name" }, { testTag: "ptf" }]) {
  test(`resolved iOS identifier supports ${JSON.stringify(selector)}`, async () => {
    const r = iosReader();
    const h = harness("ios", {
      reader: r.reader,
      focus: { focus: async () => ({ success: true, identifiers: ["field-id"] }) },
    });
    expect((await h.run("prototype", commands, selector)).success).toBe(true);
    expect(r.agent.requests).toHaveLength(1);
  });
}

test("text-only unresolved iOS target warns without a status request", async () => {
  const r = iosReader();
  const result = await harness("ios", { reader: r.reader }).run("prototype", commands, {
    text: "Name",
  });
  expect(result.success).toBe(true);
  expect(result.commands[0]?.warning).toContain("binding");
  expect(r.agent.requests).toHaveLength(0);
});

test("the default focuser reports the resolved node identifiers for an iOS text selector", async () => {
  const r = iosReader();
  const h = harness("ios", { reader: r.reader });
  const focus = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({
    success: true,
    action: "focus",
    focusVerified: true,
    element: {
      "resource-id": "field-id",
      "test-tag": "ptf",
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    },
  });
  try {
    const action = new SendKeys(ios, h.adbFactory, {
      executor: h.executor,
      observer: h.observer,
      timer: h.timer,
      prototypeTextTarget: r.reader,
      timestampProvider: { now: async () => 1 },
    });
    const result = await action.execute(
      commands,
      { text: "Name" },
      undefined,
      undefined,
      undefined,
      { layer: "prototype" },
    );
    expect(result.success).toBe(true);
    expect(result.commands[0]?.warning).toBeUndefined();
    expect(r.agent.requests).toHaveLength(1);
  } finally {
    focus.mockRestore();
  }
});

for (const scenario of ["empty", "password", "clear", "key"] as const) {
  test(`${scenario} prototype command does not invoke the reader`, async () => {
    let calls = 0;
    const reader: PrototypeTextTargetReader = {
      read: async () => {
        calls++;
        return { kind: "unverifiable", reason: "unused" };
      },
    };
    const h = harness("ios", { reader, secure: scenario === "password" });
    const input: SendKeysCommand[] =
      scenario === "empty"
        ? [{ action: "type", text: "" }]
        : scenario === "clear"
          ? [{ action: "clear" }]
          : scenario === "key"
            ? [{ action: "key", key: "tab" }]
            : commands;
    expect((await h.run("prototype", input)).success).toBe(true);
    expect(calls).toBe(0);
  });
}

for (const platform of ["android", "ios"] as const) {
  test(`${platform} real sendKeys tool reports prototype truth in its structured payload`, async () => {
    const r = iosReader(["old", "old", "old"]);
    const h = harness(platform, { reader: platform === "ios" ? r.reader : undefined });
    const capability =
      platform === "android"
        ? spyOn(AndroidCtrlProxyClient.prototype, "getSupportedCommands").mockResolvedValue([
            "request_insert_text",
          ])
        : spyOn(IOSCtrlProxyClient.prototype, "getSupportedCommands").mockResolvedValue([
            "request_press_key",
          ]);
    setSendKeysFactory(() => h.action);
    try {
      const response = await ToolRegistry.getTool("sendKeys")!.deviceAwareHandler!(
        platform === "android" ? android : ios,
        { selector: { elementId: "ptf" }, layer: "prototype", commands },
      );
      expect(response.isError).toBe(platform === "ios" ? true : undefined);
      expect(response.structuredContent).toMatchObject({
        success: platform === "android",
        commands: [{ success: platform === "android" }],
      });
      expect(
        ToolRegistry.getTool("sendKeys")!.outputSchema!.safeParse(response.structuredContent)
          .success,
      ).toBe(true);
      if (platform === "ios") {
        expect(response.structuredContent).toMatchObject({
          failedIndex: 0,
          commands: [
            {
              partialApplication: true,
              imeFailure: { expectedText: "Rb one", observedText: "old" },
            },
          ],
        });
      }
    } finally {
      capability.mockRestore();
    }
  });
}
