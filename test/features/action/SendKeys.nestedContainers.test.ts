import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { expect, spyOn, test } from "bun:test";
import {
  SendKeys,
  type SendKeysCommand,
  type SendKeysSelector,
  type SendKeysObserver,
} from "../../../src/features/action/SendKeys";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ElementContainerSelector } from "../../../src/models/PinchOnOptions";
import type {
  BootedDevice,
  ObserveResult,
  TapOnElementOptions,
  ViewHierarchyResult,
} from "../../../src/models";
import { encodeAndroidFlat, type LogicalNode } from "../../fixtures/hierarchyArbitraries";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { focused } from "./SendKeysTestHarness";

const scope = { elementId: "item_42", container: { elementId: "cart_A" } };
const scoped = { container: scope, selectionStrategy: "unique" as const };
type ScopeOptions = {
  container?: ElementContainerSelector;
  selectionStrategy?: "first" | "random" | "unique";
};
const commands: SendKeysCommand[] = [
  { action: "type", text: "3" },
  { action: "clear" },
  { action: "key", key: "done" },
];
const routes = ["android", "android-display", "ios", "ios-ime", "ios-display-ime"] as const;
type Route = (typeof routes)[number];

function harness(
  route: Route,
  focus: (options: TapOnElementOptions) => Promise<{ success: boolean; error?: string }>,
) {
  const timer = new FakeTimer();
  // The bounded IME deadline advances only if explicitly requested, not during microtasks.
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", {
    stdout: 'Display id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 500 x 500}',
    stderr: "",
  });
  const device: BootedDevice = {
    deviceId: `fake-scoped-${route}`,
    name: "Scoped field",
    platform: route.startsWith("ios") ? "ios" : "android",
    displays: {
      panels: [{ key: "external", role: "external", sizePx: { width: 500, height: 500 } }],
      postures: [],
    },
  };
  const transitions = new FakeDisplayTransitionReader();
  const observation = {
    ...focused,
    displayRevision: transitions.fullRevision,
    display: {
      key: "external",
      role: "external",
      posture: "unknown",
      generation: transitions.generation,
    },
    viewHierarchy: { ...focused.viewHierarchy, displayId: 2 },
  } as ObserveResult;
  const calls: string[] = [];
  const targets: TapOnElementOptions[] = [];
  const observer: SendKeysObserver = { execute: async () => observation };
  const action = new SendKeys(device, new FakeAdbClientFactory(adb), {
    timer,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    observer,
    timestampProvider: { now: async () => 1 },
    focuser: {
      focus: async (selector, _signal, display, options?: ScopeOptions) => {
        calls.push("focus");
        const target = { ...selector, ...options, display, action: "focus" as const };
        targets.push(target);
        return focus(target);
      },
    },
    executor: {
      type: async () => {
        calls.push("type");
        return { index: -1, action: "type", success: true };
      },
      clear: async () => {
        calls.push("clear");
        return { success: true };
      },
      key: async (command) => {
        calls.push(`key:${command.key}`);
        return { index: -1, action: "key", key: command.key, success: true };
      },
    },
  });
  const execute = (
    options: ScopeOptions = scoped,
    selector: SendKeysSelector | undefined = { elementId: "quantity" },
  ) =>
    action.execute(
      route.endsWith("ime") ? [{ action: "key", key: "done" }] : commands,
      selector,
      undefined,
      undefined,
      route.includes("display") ? "external" : undefined,
      options,
    );
  return { calls, targets, execute, action, adb, observer };
}

for (const route of routes) {
  test(`${route}: scope reaches focus before any command`, async () => {
    const h = harness(route, async () => ({ success: true }));
    expect((await h.execute()).success).toBe(true);
    expect(h.targets).toHaveLength(1);
    expect(h.targets[0]).toMatchObject({ ...scoped, elementId: "quantity", action: "focus" });
    expect(h.targets[0].display).toBe(route.includes("display") ? "external" : undefined);
    expect(h.calls).toEqual(
      route.endsWith("ime") ? ["focus", "key:done"] : ["focus", "type", "clear", "key:done"],
    );
  });
  test(`${route}: failed scoped focus sends no text, clear, or keys`, async () => {
    const h = harness(route, async (options) =>
      options.container
        ? { success: false, error: "Container level 1 not found: cart_A" }
        : { success: true },
    );
    const result = await h.execute();
    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 0,
      commands: [],
      error: "Container level 1 not found: cart_A",
    });
    expect(h.calls).toEqual(["focus"]);
    expect(h.targets).toHaveLength(1);
    expect(h.adb.getCommandCalls().map(({ command }) => command)).toEqual(
      route === "android-display" ? ["shell cmd display get-displays"] : [],
    );
  });
  test.each([scoped, { selectionStrategy: "unique" as const }])(
    `${route}: resolver failure survives an unavailable post-focus observation (%j)`,
    async (options) => {
      const error =
        "Target ambiguous: 2 matches; Candidates: resourceId=quantity text=quantity bounds=[0,0,100,20]";
      const h = harness(route, async () => ({ success: false, error }));
      const observe = h.observer.execute;
      h.observer.execute = async (request) => {
        if (h.calls.includes("focus")) {
          throw new Error("Post-focus observation unavailable");
        }
        return observe(request);
      };
      expect(await h.execute(options)).toMatchObject({ success: false, commands: [], error });
      expect(h.calls).toEqual(["focus"]);
    },
  );
}

function node(id: string, children: LogicalNode[] = [], top = 0): LogicalNode {
  return {
    attrs: {
      "resource-id": id,
      text: id,
      class: id === "quantity" ? "android.widget.EditText" : "android.view.View",
      editable: id === "quantity",
      focused: id === "quantity",
    },
    bounds: { left: 0, top, right: 100, bottom: top + 20 },
    children,
  };
}
function hierarchy(
  kind:
    | "success"
    | "container-missing"
    | "target-missing"
    | "container-ambiguous"
    | "target-ambiguous",
): ViewHierarchyResult {
  const item = node("item_42", [
    node("", kind === "target-missing" ? [] : [node("quantity", [], 40)]),
  ]);
  if (kind === "target-ambiguous") {
    item.children.push(node("quantity", [], 70));
  }
  const cart = node("cart_A", [node("", [item])]);
  if (kind === "container-ambiguous") {
    cart.children.push(node("item_42"));
  }
  return {
    screenWidth: 500,
    screenHeight: 500,
    hierarchy: {
      node: encodeAndroidFlat(
        node("", [
          // Put the unrelated field first so a global lookup cannot accidentally pass.
          node("cart_B", [node("item_42", [node("quantity", [], 250)])]),
          ...(kind === "container-missing" ? [] : [cart]),
        ]),
      ),
    },
  };
}
function realTap(capture: ViewHierarchyResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { deviceId: "fake-resolver-field", name: "Field", platform: "android" },
    new FakeAdbClient(),
    {
      timer,
      elementSelector: new ResolverElementSelector(),
      tapStrategy: new FakeTapStrategy(),
    },
  );
  tap.prepareSelectionCapture = async () => null;
  tap.observedInteraction = (callback) =>
    callback(
      recordObservationRead({ viewHierarchy: capture, screenSize: { width: 500, height: 500 } }),
    );
  return tap;
}
for (const [kind, message] of [
  ["container-missing", "Container level 1 not found"],
  ["target-missing", "Target not found within container"],
  ["container-ambiguous", "Container level 2 ambiguous"],
  ["target-ambiguous", "Target ambiguous"],
] as const) {
  test(`real scoped focus ${kind}: resolver error survives and no fallback input runs`, async () => {
    const tap = realTap(hierarchy(kind));
    const h = harness("android", (options) => tap.execute(options));
    const result = await h.execute();
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    if (kind.endsWith("ambiguous")) {
      expect(result.error).toMatch(/Candidates:.*resourceId=.*text=.*bounds=/);
    }
    expect(h.calls).toEqual(["focus"]);
    expect(h.targets).toHaveLength(1);
  });
}
test("real nested resolver focuses only the quantity in cart_A/item_42", async () => {
  const tap = realTap(hierarchy("success"));
  const h = harness("android", async (options) => {
    const result = await tap.execute(options);
    expect(result.element?.bounds.top).toBe(40);
    return result;
  });
  expect((await h.execute()).success).toBe(true);
  expect(h.calls).toEqual(["focus", "type", "clear", "key:done"]);
});
test("default focuser forwards sibling scope options into TapOnElement", async () => {
  const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({
    success: false,
    error: "Target not found within container",
  });
  const h = harness("android", async () => ({ success: true }));
  const action = new SendKeys(
    { deviceId: "fake-default-focus", name: "Field", platform: "android" },
    undefined,
    {
      timer: new FakeTimer(),
      observer: { execute: async () => focused },
      timestampProvider: { now: async () => 1 },
      executor: {
        type: async () => {
          h.calls.push("type");
          return { index: -1, action: "type", success: true };
        },
        key: async () => ({ index: -1, action: "key", success: true }),
        clear: async () => ({ success: true }),
      },
    },
  );
  try {
    const result = await action.execute(
      commands,
      { elementId: "quantity" },
      undefined,
      undefined,
      undefined,
      scoped,
    );
    expect(result.error).toBe("Target not found within container");
    expect(tap).toHaveBeenCalledTimes(1);
    expect(tap.mock.calls[0][0]).toMatchObject({
      ...scoped,
      elementId: "quantity",
      action: "focus",
    });
    expect(h.calls).toEqual([]);
  } finally {
    tap.mockRestore();
  }
});
test.each(["container", "selectionStrategy"] as const)(
  "direct caller: %s without selector sends nothing",
  async (field) => {
    const h = harness("android", async () => ({ success: true }));
    const result = await h.action.execute(commands, undefined, undefined, undefined, undefined, {
      [field]: scoped[field],
    });
    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      commands: [],
      error: `${field} requires a selector naming the field to focus`,
    });
    expect(h.calls).toEqual([]);
    expect(h.adb.getCommandCalls()).toHaveLength(0);
  },
);
test("default field focus and currently focused input remain unchanged", async () => {
  const h = harness("android", async () => ({ success: true }));
  expect((await h.execute({})).success).toBe(true);
  expect(h.targets[0].container).toBeUndefined();
  expect(h.targets[0].selectionStrategy).toBeUndefined();
  expect(h.calls).toEqual(["focus", "type", "clear", "key:done"]);
  h.calls.length = 0;
  expect((await h.action.execute(commands)).success).toBe(true);
  expect(h.calls).toEqual(["type", "clear", "key:done"]);
});

test("sendKeys default focuser reaches the opted-in tapOn field resolution by hint", async () => {
  const capture: ViewHierarchyResult = {
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        class: "android.widget.EditText",
        "resource-id": "phone",
        text: "5551234",
        "hint-text": "Phone",
        clickable: true,
        focusable: true,
      },
    },
  };
  const fieldTap = realTap(capture);
  const resolve = spyOn(ElementResolver.prototype, "resolve");
  const tap = spyOn(TapOnElement.prototype, "execute").mockImplementation(async (options) => {
    expect(options.action).toBe("focus");
    const result = fieldTap.findElementInHierarchy(options, capture);
    expect(result.selection.element?.["resource-id"]).toBe("phone");
    return { success: result.selection.element !== null };
  });
  const action = new SendKeys(
    { deviceId: "fake-hint-focus", name: "Field", platform: "android" },
    undefined,
    {
      timer: new FakeTimer(),
      observer: { execute: async () => focused },
      timestampProvider: { now: async () => 1 },
      executor: {
        type: async () => ({ index: -1, action: "type", success: true }),
        key: async () => ({ index: -1, action: "key", success: true }),
        clear: async () => ({ success: true }),
      },
    },
  );
  try {
    expect((await action.execute([{ action: "type", text: "6" }], { text: "Phone" })).success).toBe(
      true,
    );
    expect(
      resolve.mock.calls.some(
        ([, selector, intent]) => selector.text === "Phone" && intent.allowHintFallback === true,
      ),
    ).toBe(true);
  } finally {
    tap.mockRestore();
    resolve.mockRestore();
  }
});
