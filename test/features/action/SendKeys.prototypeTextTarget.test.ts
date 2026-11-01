import { runBlockWith } from "../../helpers/observedInteractionStub";
import { createFlatNodeForTest } from "../observe/flatHierarchyBuilders";
import { buildObserveResult } from "../../helpers/observeFixture";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
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
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { TapOnElement, tapResolvedLayer } from "../../../src/features/action/TapOnElement";
import { FakePrototypeAgentClient } from "../../fakes/FakePrototypeAgentClient";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import {
  type InteractionToolDependencies,
  registerInteractionTools,
} from "../../../src/server/interactionTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

const interactionDeps: InteractionToolDependencies = {};
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
            bounds: nodeAttributes(iosField).bounds,
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
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
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
function iosPrototypeObservation(value: string): ObserveResult {
  const field = structuredClone(iosField);
  nodeAttributes(field).value = value;
  nodeAttributes(field)["resource-id"] = "ptf";
  return buildObserveResult({
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    updatedAt: 1,
    viewHierarchy: {
      hierarchy: {
        node: createFlatNodeForTest({
          className: "UIWindow",
          "resource-id": "automobile-prototype-window",
          node: [field],
        }),
      },
    },
  });
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
  const { focused, secure } = options;
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
    execute: async (
      options: Parameters<NonNullable<SendKeysDependencies["observer"]>["execute"]>[0] = {},
    ) => {
      reads.push(options);
      if (platform === "android") {
        return reads.length === 1 && options.hierarchyOnly
          ? androidFrame("old", focused, secure)
          : frame;
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
  ) => action.execute(input, selector, { focus: { layer } });
  return { ...h, action, run, reads, timer, keyboardCalls, observer };
}

function iosReader(values: unknown[] = ["Rb one"], before: unknown = "before") {
  const bindings = new InMemoryPrototypeTextFieldBindings();
  bindings.record(ios.deviceId, textSpec);
  const agent = new FakePrototypeAgentClient();
  agent.queueReplies(
    ...[before, ...values].map((value) => ({
      status: { shown: true, id: "panel", state: { name: value } },
    })),
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
  registerInteractionTools(interactionDeps);
  await harness("android").run();
});
afterEach(() => delete interactionDeps.sendKeysFactory);

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
      if (!observation.focusedElement) {
        throw new Error("Expected focused element");
      }
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

test("iOS accepted state has one before-read and one verification request with no warning", async () => {
  const r = iosReader();
  const result = await harness("ios", { reader: r.reader }).run();
  expect(result.success).toBe(true);
  expect(result.commands[0]?.warning).toBeUndefined();
  expect(r.agent.requests.map((request) => request.type)).toEqual([
    "get_prototype_status",
    "get_prototype_status",
  ]);
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
    Array(4).fill("get_prototype_status"),
  );
  expect(times).toEqual([0, 0, IME_COMMIT_READ_BACK_SETTLE_MS, 2 * IME_COMMIT_READ_BACK_SETTLE_MS]);
});

test("iOS late acceptance wins on the second read", async () => {
  const r = iosReader(["old", "Rb one"]);
  const h = harness("ios", { reader: r.reader });
  expect((await h.run()).success).toBe(true);
  expect(r.agent.requests).toHaveLength(3);
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
        await h.action.execute(
          commands,
          { elementId: "ptf" },
          {
            focus: {
              layer,
            },
          },
        ),
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
    expect(r.agent.requests).toHaveLength(2);
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
      { focus: { layer: "prototype" } },
    );
    expect(result.success).toBe(true);
    expect(result.commands[0]?.warning).toBeUndefined();
    expect(r.agent.requests).toHaveLength(2);
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
    interactionDeps.sendKeysFactory = () => h.action;
    try {
      const response = await ToolRegistry.getTool("sendKeys")!.deviceAwareHandler!(
        platform === "android" ? android : ios,
        { selector: { elementId: "ptf" }, layer: "prototype", commands },
      );
      if (typeof response !== "object" || response === null || !("structuredContent" in response)) {
        throw new Error("Expected tool response");
      }
      expect("isError" in response ? response.isError : undefined).toBe(
        platform === "ios" ? true : undefined,
      );
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

for (const mode of ["eventLast", "eventAll", "eventOnly"] as const) {
  test(`prototype ${mode} dispatches without a readable focused field`, async () => {
    const h = harness("android", { focused: false });
    const result = await h.run("prototype", [{ action: "type", text: "a", mode }]);
    expect(h.deliveries.length).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("not verified against the prototype");
    expect(result.error).toBeUndefined();
  });
  test(`app ${mode} still refuses without focused input`, async () => {
    const h = harness("android", { focused: false });
    h.observer.execute = async () => {
      const frame = structuredClone(androidFrame("", false));
      const roots = frame.viewHierarchy!.hierarchy.node!;
      for (const root of Array.isArray(roots) ? roots : [roots]) {
        for (const child of Array.isArray(root.node) ? root.node : [root.node!]) {
          nodeAttributes(child).focused = "false";
        }
      }
      return { ...frame, focusedElement: undefined };
    };
    const result = await h.action.execute([{ action: "type", text: "a", mode }], {
      elementId: "ptf",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Android event delivery requires a focused editable field. For printable ASCII, mode: "imeKeyEvents" types without requiring a focused editable node.',
    );
    expect(h.deliveries).toEqual([]);
  });
}

function keyEventArgv(h: ReturnType<typeof harness>): string[] {
  return h.adb
    .getExecutedArgv()
    .map((args) => args.join(" "))
    .filter((line) => line.startsWith("shell input keyevent"));
}

for (const mode of ["eventAll", "eventOnly", "eventLast"] as const) {
  test(`prototype ${mode} password target not flagged focused uses the redacted key path`, async () => {
    const h = harness("android", { focused: false, secure: true });
    const result = await h.run("prototype", [{ action: "type", text: "ab1", mode }]);
    expect(result.success).toBe(true);
    expect(h.deliveries.filter((d) => d.kind === "keyevent" || d.kind === "inputText")).toEqual([]);
    expect(h.adb.getExecutedCommands().filter((c) => c.includes("input text"))).toEqual([]);
    expect(keyEventArgv(h).length).toBe(mode === "eventLast" ? 1 : 3);
    expect(JSON.stringify(result)).not.toContain("ab1");
  });
}

test("prototype eventAll non-password target keeps the ordinary path", async () => {
  const plain = harness("android", { focused: false });
  const second = await plain.run("prototype", [{ action: "type", text: "ab1", mode: "eventAll" }]);
  expect(second.success).toBe(true);
  expect(keyEventArgv(plain)).toEqual([]);
  expect(plain.deliveries.length).toBeGreaterThan(0);
});

test("prototype password flag resets between executes on one executor", async () => {
  let secure = true;
  const h = harness("android", {
    focused: false,
    focus: { focus: async () => ({ success: true, passwordField: secure }) },
  });
  const input = [{ action: "type" as const, text: "ab1", mode: "eventAll" as const }];
  await h.run("prototype", input);
  expect(h.deliveries.filter((d) => d.kind === "keyevent" || d.kind === "inputText")).toEqual([]);
  secure = false;
  await h.run("prototype", input);
  expect(h.deliveries.some((d) => d.kind === "keyevent" || d.kind === "inputText")).toBe(true);
});

for (const platform of ["android", "ios"] as const) {
  test(`${platform} implicit resolved prototype uses prototype truth`, async () => {
    const r = iosReader(["old", "old", "old", "old"]);
    const h = harness(platform, {
      reader: platform === "ios" ? r.reader : undefined,
      focus: { focus: async () => ({ success: true, layer: "prototype" }) },
    });
    const result = await h.action.execute(commands, { elementId: "ptf" });
    expect(result.success).toBe(platform === "android");
    if (platform === "android") {
      expect(result.commands[0]?.imeFailure).toBeUndefined();
    } else {
      expect(result.commands[0]?.partialApplication).toBe(true);
      expect(result.error).toContain('state key "name" holds "old"');
    }
  });
}

for (const changed of [false, true]) {
  test(`prototype insert requires changed truth (${changed})`, async () => {
    const r = iosReader(Array(3).fill(changed ? "101" : "10"), "10");
    const h = harness("ios", { reader: r.reader });
    const order: string[] = [];
    const read = r.reader.read.bind(r.reader);
    r.reader.read = async (...args) => {
      order.push("read");
      return read(...args);
    };
    const insert = h.client.insert;
    h.client.insert = async (...args) => {
      order.push("dispatch");
      return insert(...args);
    };
    const result = await h.run("prototype", [{ action: "type", text: "1", operation: "insert" }]);
    expect(result.success).toBe(changed);
    expect(order).toEqual(
      changed ? ["read", "dispatch", "read"] : ["read", "dispatch", "read", "read", "read"],
    );
    if (!changed) {
      expect(result.error).toContain('holds "10"');
    }
  });
}

test("forgotten iOS bindings make typing unverifiable", async () => {
  const r = iosReader();
  r.bindings.forget(ios.deviceId);
  const result = await harness("ios", { reader: r.reader }).run();
  expect(result.success).toBe(true);
  expect(result.warning).toContain(
    "not verified against the prototype: no shown prototype bindings",
  );
  expect(r.agent.requests).toHaveLength(0);
});

test("unverifiable insert before-read keeps the contains rule", async () => {
  let calls = 0;
  const reader: PrototypeTextTargetReader = {
    read: async () =>
      ++calls === 1
        ? { kind: "unverifiable", reason: "before unavailable" }
        : { kind: "value", source: "state", stateKey: "name", value: "10" },
  };
  const result = await harness("ios", { reader }).run("prototype", [
    { action: "type", text: "1", operation: "insert" },
  ]);
  expect(result.success).toBe(true);
  expect(calls).toBe(2);
});

for (const platform of ["android", "ios"] as const) {
  test(`${platform} real default focus infers prototype from the resolved node`, async () => {
    const r = iosReader(["old", "old", "old"]);
    const h = harness(platform, { reader: platform === "ios" ? r.reader : undefined });
    const frame = platform === "android" ? androidFrame("Rb one") : iosPrototypeObservation("old");
    const interaction = spyOn(TapOnElement.prototype, "observedInteraction").mockImplementation(
      runBlockWith(() => recordObservationRead(frame)),
    );
    const capability =
      platform === "android"
        ? spyOn(AndroidCtrlProxyClient.prototype, "getSupportedCommands").mockResolvedValue([])
        : spyOn(IOSCtrlProxyClient.prototype, "getSupportedCommands").mockResolvedValue([]);
    try {
      const action = new SendKeys(platform === "android" ? android : ios, h.adbFactory, {
        executor: h.executor,
        observer: h.observer,
        timer: h.timer,
        prototypeTextTarget: platform === "ios" ? r.reader : undefined,
        timestampProvider: { now: async () => 1 },
      });
      const result = await action.execute(commands, { elementId: "ptf" });
      if (platform === "android") {
        expect(result.error).toBeUndefined();
      }
      expect(result.success).toBe(platform === "android");
      if (platform === "ios") {
        expect(result.error).toContain('state key "name" holds "old"');
      }
    } finally {
      interaction.mockRestore();
      capability.mockRestore();
    }
  });
}

test("no-prototype focus reports no layer and implicit sendKeys makes no prototype read", async () => {
  const h = harness("ios");
  const frame = typedObservation("Rb one");
  const reader: PrototypeTextTargetReader = {
    read: async () => ({ kind: "unverifiable", reason: "unused" }),
  };
  const read = spyOn(reader, "read");
  const interaction = spyOn(TapOnElement.prototype, "observedInteraction").mockImplementation(
    runBlockWith(() => recordObservationRead(frame)),
  );
  const capability = spyOn(IOSCtrlProxyClient.prototype, "getSupportedCommands").mockResolvedValue(
    [],
  );
  const execute = TapOnElement.prototype.execute;
  const focus = spyOn(TapOnElement.prototype, "execute").mockImplementation(async function (
    this: TapOnElement,
    options,
  ) {
    const result = await execute.call(this, options);
    expect(result.success).toBe(true);
    expect(result[tapResolvedLayer]).toBeUndefined();
    return result;
  });
  try {
    const action = new SendKeys(ios, h.adbFactory, {
      executor: h.executor,
      observer: { execute: async () => frame },
      timer: h.timer,
      prototypeTextTarget: reader,
      timestampProvider: { now: async () => 1 },
    });
    const result = await action.execute(commands, { text: "Email" });
    expect(result.success).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  } finally {
    focus.mockRestore();
    capability.mockRestore();
    interaction.mockRestore();
    read.mockRestore();
  }
});

for (const platform of ["android", "ios"] as const) {
  test(`${platform} resolved app adds no reads and explicit app overrides resolved prototype`, async () => {
    let calls = 0;
    const reader: PrototypeTextTargetReader = {
      read: async () => {
        calls++;
        return { kind: "unverifiable", reason: "unused" };
      },
    };
    const baseline = harness(platform);
    await baseline.action.execute(commands, { elementId: "ptf" });
    for (const layer of ["app", "prototype"] as const) {
      const h = harness(platform, {
        reader,
        focus: { focus: async () => ({ success: true, layer }) },
      });
      await h.action.execute(
        commands,
        { elementId: "ptf" },
        { focus: layer === "prototype" ? { layer: "app" } : undefined },
      );
      expect(h.reads).toHaveLength(baseline.reads.length);
    }
    expect(calls).toBe(0);
  });
}

test("inferred prototype layer does not leak into the next execute", async () => {
  let focuses = 0;
  const h = harness("android", {
    focus: {
      focus: async () => ({ success: true, layer: ++focuses === 1 ? "prototype" : undefined }),
    },
  });
  expect((await h.action.execute(commands, { elementId: "ptf" })).success).toBe(true);
  const result = await h.action.execute(commands, { elementId: "ptf" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("focused field holds");
});

for (const mode of ["eventLast", "eventAll", "eventOnly"] as const) {
  test(`prototype ${mode} proceeds when hierarchy is absent`, async () => {
    const h = harness("android", {
      reader: { read: async () => ({ kind: "unverifiable", reason: "no hierarchy" }) },
    });
    h.observer.execute = async () => ({
      ...androidFrame(""),
      viewHierarchy: undefined,
      focusedElement: undefined,
    });
    const result = await h.run("prototype", [{ action: "type", text: "a", mode }]);
    expect(h.deliveries.length).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("not verified against the prototype");
  });
}

for (const mode of ["eventLast", "eventAll"] as const) {
  test(`prototype ${mode} replacement proceeds without readable focus`, async () => {
    const h = harness("android", { focused: false });
    const clear = h.client.clear;
    const clearing = spyOn(h.client, "clear").mockImplementation(async () => {
      expect(h.deliveries).toEqual([]);
      return clear();
    });
    const result = await h.run("prototype", [
      { action: "type", text: "a", mode, operation: "replace" },
    ]);
    expect(h.deliveries.length).toBeGreaterThan(0);
    expect(clearing).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("not verified against the prototype");
  });
}

test("prototype eventOnly replacement refuses without readable focus before dispatch", async () => {
  const h = harness("android", { focused: false });
  const result = await h.run("prototype", [
    { action: "type", text: "a", mode: "eventOnly", operation: "replace" },
  ]);
  expect(result.success).toBe(false);
  expect(result.error).toContain("requires a known focused text length");
  expect(h.deliveries).toEqual([]);
  expect(h.committed).toEqual([]);
  expect(h.clientCalls).toEqual([]);
  expect(h.adb.getExecutedCommands().some((command) => command.includes("input "))).toBe(false);
});

test("display-routed Android focus applies the inferred prototype layer", async () => {
  const h = harness("android");
  const transitions = new FakeDisplayTransitionReader();
  h.observer.execute = async () => ({
    ...androidFrame(h.committed.length ? "Rb one" : "old"),
    display: { key: "0", role: "unknown", posture: "unknown", generation: transitions.generation },
    displayRevision: transitions.fullRevision,
  });
  const observation = await h.observer.execute();
  const action = new SendKeys(android, h.adbFactory, {
    observer: h.observer,
    executor: h.executor,
    timer: h.timer,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    timestampProvider: { now: async () => 1 },
    focuser: { focus: async () => ({ success: true, layer: "prototype" }) },
  });
  const result = await action.execute(commands, { elementId: "ptf" }, { display: "0" });
  expect(h.committed).toEqual(["Rb one"]);
  expect(result.success).toBe(true);
  expect(result.commands[0]?.imeFailure).toBeUndefined();
});
