import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { describe, expect, it, spyOn } from "bun:test";
import fc from "fast-check";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { ElementContainerSelector } from "../../../src/models/PinchOnOptions";
import {
  encodeAndroidFlat,
  encodeIosDollar,
  logicalNodeArb,
  type LogicalNode,
} from "../../fixtures/hierarchyArbitraries";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTalkBackSwipeExecutor } from "../../fakes/FakeTalkBackSwipeExecutor";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";

// Main a9d3fc38: observe.waitFor has no selectionStrategy and its finder adapter
// drops nested container fields. Do not claim conformance for that legacy route.
const scenarios = [
  "success",
  "outer-miss",
  "inner-miss",
  "target-miss",
  "target-ambiguous",
  "inner-ambiguous",
  "inner-index",
  "outer-index",
] as const;
type Scenario = (typeof scenarios)[number];
interface Outcome {
  success: boolean;
  gestures: Array<{ x?: number; y?: number; kind?: "input" }>;
  error?: string;
  selectedTop?: number;
}
interface Adapter {
  name: string;
  run: (scenario: Scenario) => Promise<Outcome>;
}
const android: BootedDevice = {
  deviceId: "fake-conformance",
  name: "Conformance",
  platform: "android",
};
const ios: BootedDevice = { ...android, deviceId: "fake-conformance-ios", platform: "ios" };
function timer() {
  const clock = new FakeTimer();
  clock.enableAutoAdvance();
  return clock;
}
function node(id: string, children: LogicalNode[] = [], top = 50, bottom = 300): LogicalNode {
  return {
    attrs: {
      "resource-id": id,
      text: id,
      class: id === "target" ? "android.widget.EditText" : "android.view.View",
      clickable: id === "target",
      editable: id === "target",
      focused: id === "target",
      scrollable: id === "item",
    },
    bounds: { left: 20, top, right: 480, bottom },
    children,
  };
}
function tree(scenario: Scenario): LogicalNode {
  const target = node("target", [], 120, 180);
  const item = node("item", [node("", scenario === "target-miss" ? [] : [target])], 80, 280);
  if (scenario === "target-ambiguous") {
    item.children.push(node("target", [], 200, 260));
  }
  const cart = node("cart", scenario === "inner-miss" ? [] : [node("", [item])]);
  if (scenario === "inner-ambiguous" || scenario === "inner-index") {
    cart.children.push(node("item", [node("target", [], 200, 260)], 80, 280));
  }
  const carts = scenario === "outer-miss" ? [] : [cart];
  if (scenario === "outer-index") {
    carts.push(node("cart", [node("item", [node("target", [], 200, 260)], 80, 280)]));
  }
  // A global match comes first, and anonymous wrappers must not break ancestry.
  return node(
    "root",
    [node("peer", [node("item", [node("target", [], 360, 420)])], 340, 460), ...carts],
    0,
    500,
  );
}
function hierarchy(
  scenario: Scenario,
  platform: "android" | "ios" = "android",
): ViewHierarchyResult {
  return {
    screenWidth: 500,
    screenHeight: 500,
    hierarchy: { node: (platform === "ios" ? encodeIosDollar : encodeAndroidFlat)(tree(scenario)) },
  };
}
function observation(capture: ViewHierarchyResult): ObserveResult {
  return {
    updatedAt: 1,
    observationId: "fake-conformance-observation",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 1 },
    screenSize: { width: 500, height: 500 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: capture,
  };
}
function scope(scenario: Scenario): ElementContainerSelector {
  return {
    elementId: "item",
    selectionStrategy: "unique",
    ...(scenario === "inner-index" ? { index: 1 } : {}),
    container: {
      elementId: "cart",
      selectionStrategy: "unique",
      ...(scenario === "outer-index" ? { index: 1 } : {}),
    },
  };
}
function selector(scenario: Scenario) {
  return { elementId: "target", container: scope(scenario), selectionStrategy: "unique" as const };
}
// Preserve concrete AdbClient constructor contracts while all process output
// comes from the existing fake; spawning is forbidden even on a fallback path.
function boundaryAdb(fake = new FakeAdbClient()) {
  return new AdbClient(
    android,
    (command: string) => fake.executeCommand(command),
    () => {
      throw new Error("Conformance must not spawn a process");
    },
    undefined,
    timer(),
  );
}
class ScopedObserver extends FakeObserveScreen {
  override captureCacheGeneration(): number {
    return 0;
  }
}
class BoundaryTap extends TapOnElement {
  readonly gestures: Outcome["gestures"] = [];
  override async prepareSelectionCapture() {
    return null;
  }
  override async executeAndroidTap(
    _action: string,
    x: number,
    y: number,
    _duration: number,
    _element: Element,
  ) {
    this.gestures.push({ x, y });
    return undefined;
  }
}
function buildTap(scenario: Scenario) {
  const action = new BoundaryTap(android, boundaryAdb(), {
    timer: timer(),
    elementSelector: new ResolverElementSelector(new ElementResolver(() => 0)),
    tapStrategy: new FakeTapStrategy(),
  });
  action.observedInteraction = (run) =>
    run(recordObservationRead(observation(hierarchy(scenario))));
  return action;
}
async function tapOn(scenario: Scenario): Promise<Outcome> {
  const action = buildTap(scenario);
  const result = await action.execute({ ...selector(scenario), action: "tap" });
  return { ...result, gestures: action.gestures, selectedTop: result.element?.bounds.top };
}
async function tapAny(scenario: Scenario): Promise<Outcome> {
  const gestures: Outcome["gestures"] = [];
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy();
  const action = new TapAnyElement(android, boundaryAdb(adb), {
    timer: timer(),
    elementSelector: new ResolverElementSelector(new ElementResolver(() => 0)),
    accessibilityDetector: new FakeAccessibilityDetector(),
    accessibilityService: service,
  });
  action.setRefreshViewHierarchyForTesting(async () => null);
  action.observedInteraction = (run) =>
    run(recordObservationRead(observation(hierarchy(scenario))));
  const result = await action.execute({
    container: scope(scenario),
    selectionStrategy: "unique",
    action: "tap",
  });
  gestures.push(...service.getTapHistory());
  // The fake adb boundary also records coordinate dispatch when CtrlProxy is off.
  for (const { command } of adb.getCommandCalls()) {
    const match = /input (?:touchscreen )?tap (\d+) (\d+)/.exec(command);
    if (match) {
      gestures.push({ x: Number(match[1]), y: Number(match[2]) });
    }
  }
  return { ...result, gestures, selectedTop: result.element?.bounds.top };
}
async function drag(scenario: Scenario, endpoint: "source" | "target"): Promise<Outcome> {
  const capture = hierarchy(scenario);
  const action = new DragAndDrop(android, boundaryAdb(), timer(), {
    hierarchyCapture: new FakeHierarchyCapture(() => capture),
    selector: new ResolverElementSelector(new ElementResolver(() => 0)),
  });
  action.observedInteraction = (run) => run(observation(capture));
  const client = AndroidCtrlProxyClient.getExistingInstance(android.deviceId)!;
  const dispatch = spyOn(client, "requestDrag").mockResolvedValue({
    success: true,
    totalTimeMs: 0,
  });
  const available = spyOn(AndroidCtrlProxyManager.prototype, "isAvailable").mockResolvedValue(true);
  try {
    const fixed = { elementId: "peer" };
    const result = await action.execute({
      source: endpoint === "source" ? selector(scenario) : fixed,
      target: endpoint === "target" ? selector(scenario) : fixed,
    });
    const offset = endpoint === "source" ? 0 : 2;
    return {
      ...result,
      gestures: dispatch.mock.calls.map((call: Parameters<typeof client.requestDrag>) => ({
        x: call[offset],
        y: call[offset + 1],
      })),
    };
  } finally {
    dispatch.mockRestore();
    available.mockRestore();
    AndroidCtrlProxyClient.removeInstance(android.deviceId);
  }
}
async function pinch(scenario: Scenario): Promise<Outcome> {
  const capture = hierarchy(scenario, "ios");
  const observe = new ScopedObserver();
  observe.setObserveResult(observation(capture));
  const action = new PinchOn(ios, null, {
    timer: timer(),
    capture: new FakeHierarchyCapture(() => capture, "ios"),
    resolver: new ElementResolver(() => 0),
  });
  action.observeScreen = observe;
  action.observedInteraction = (run) => run(observation(capture));
  const client = IOSCtrlProxyClient.getInstance(ios, 9999);
  const dispatch = spyOn(client, "requestPinch").mockResolvedValue({
    success: true,
    totalTimeMs: 0,
  });
  try {
    const result = await action.execute({
      direction: "in",
      container: selector(scenario),
      autoTarget: false,
    });
    return {
      ...result,
      gestures: dispatch.mock.calls.map(([x, y]: Parameters<typeof client.requestPinch>) => ({
        x,
        y,
      })),
    };
  } finally {
    dispatch.mockRestore();
    IOSCtrlProxyClient.clearInstanceRegistryForTesting();
  }
}
async function sendKeys(scenario: Scenario): Promise<Outcome> {
  const tap = buildTap(scenario);
  let selectedTop: number | undefined;
  const gestures: Outcome["gestures"] = [];
  const action = new SendKeys(
    android,
    { create: () => boundaryAdb() },
    {
      timer: timer(),
      observer: { execute: async () => observation(hierarchy(scenario)) },
      timestampProvider: { now: async () => 1 },
      focuser: {
        focus: async (target, _signal, _display, options) => {
          const result = await tap.execute({ ...target, ...options, action: "focus" });
          selectedTop = result.element?.bounds.top;
          return result;
        },
      },
      executor: {
        type: async () => {
          gestures.push({ kind: "input" });
          return { index: -1, action: "type", success: true };
        },
        clear: async () => ({ success: true }),
        key: async () => ({ index: -1, action: "key", success: true }),
      },
    },
  );
  const request = selector(scenario);
  const result = await action.execute(
    [{ action: "type", text: "3" }],
    { elementId: request.elementId },
    undefined,
    undefined,
    undefined,
    { container: request.container, selectionStrategy: request.selectionStrategy },
  );
  // A pre-focused field needs no extra tap. Record actual text dispatch at
  // the injected executor and return the element selected by real focus code.
  return { ...result, gestures: [...tap.gestures, ...gestures], selectedTop };
}
async function swipe(scenario: Scenario, lookFor: boolean, reveal = false): Promise<Outcome> {
  const clock = timer();
  const capture = hierarchy(scenario);
  let frame = observation(reveal ? hierarchy("target-miss") : capture);
  const observe = new ScopedObserver();
  observe.setObserveResult(() => frame);
  const runner = new FakeTalkBackSwipeExecutor();
  class BoundarySwipe extends SwipeOn {
    override async observedInteraction<T>(
      run: (current: ObserveResult) => Promise<T>,
    ): Promise<T & { observation: ObserveResult }> {
      const result = await run(frame);
      clock.advanceTime(200);
      if (reveal) {
        frame = observation(capture);
      }
      return { ...result, observation: frame };
    }
  }
  const action = new BoundarySwipe(ios, null, {
    timer: clock,
    observeScreen: observe,
    voiceOverExecutor: runner,
    accessibilityDetector: new FakeAccessibilityDetector(),
    resolver: new ElementResolver(() => 0),
  });
  const result = await action.execute(
    lookFor
      ? {
          direction: "down",
          container: scope(scenario),
          lookFor: { ...selector(scenario), container: undefined, maxTime: reveal ? 400 : 200 },
        }
      : { direction: "down", container: selector(scenario) },
  );
  return {
    ...result,
    gestures: runner.getSwipeCalls().map((call) => ({ x: call.x1, y: call.y1 })),
    selectedTop: result.element?.bounds.top,
  };
}
const adapters: Adapter[] = [
  { name: "tapOn", run: tapOn },
  { name: "tapAny", run: tapAny },
  { name: "dragAndDrop source", run: (scenario) => drag(scenario, "source") },
  { name: "dragAndDrop target", run: (scenario) => drag(scenario, "target") },
  { name: "pinchOn", run: pinch },
  { name: "sendKeys", run: sendKeys },
  { name: "swipeOn", run: (scenario) => swipe(scenario, false) },
  { name: "swipeOn lookFor", run: (scenario) => swipe(scenario, true) },
];
const failures: Partial<Record<Scenario, RegExp>> = {
  "outer-miss": /Container level 1 not found: cart/,
  "inner-miss": /Container level 2 not found: item/,
  "target-miss": /not found within container/i,
  "target-ambiguous": /Target ambiguous: 2 matches/i,
  "inner-ambiguous": /Container level 2 ambiguous/i,
};
for (const adapter of adapters) {
  describe(adapter.name, () => {
    for (const scenario of scenarios) {
      it(scenario, async () => {
        const result = await adapter.run(scenario);
        const family = failures[scenario];
        if (family) {
          expect(result.success).toBe(false);
          // swipeOn's target is the final container level, unlike action leaves.
          const expected =
            adapter.name === "swipeOn" && scenario.startsWith("target-")
              ? scenario === "target-miss"
                ? /Container level 3 not found: target/
                : /Container level 3 ambiguous/
              : family;
          expect(result.error).toMatch(expected);
          if (scenario.includes("ambiguous")) {
            expect(result.error).toMatch(/Candidates:.*resourceId=.*text=.*bounds=/);
          }
          const searching = adapter.name === "swipeOn lookFor" && scenario === "target-miss";
          expect(result.gestures).toHaveLength(searching ? 1 : 0);
          if (searching) {
            expect(result.gestures[0].y).toBeGreaterThanOrEqual(80);
          }
          return;
        }
        expect(result).toMatchObject({ success: true });
        const top = scenario.endsWith("index") ? 200 : 120;
        if (adapter.name === "swipeOn lookFor") {
          // Already-visible lookFor matches return without scrolling.
          expect(result.gestures).toHaveLength(0);
          expect(result.selectedTop).toBe(top);
        } else {
          expect(result.gestures).toHaveLength(1);
          if (adapter.name === "sendKeys") {
            expect(result.gestures[0].kind).toBe("input");
            expect(result.selectedTop).toBe(top);
            return;
          }
          expect(result.gestures[0].x).toBeGreaterThanOrEqual(20);
          expect(result.gestures[0].x).toBeLessThanOrEqual(480);
          expect(result.gestures[0].y).toBeGreaterThanOrEqual(top);
          expect(result.gestures[0].y).toBeLessThanOrEqual(top + 60);
          if (result.selectedTop !== undefined) {
            expect(result.selectedTop).toBe(top);
          }
        }
      });
    }
  });
}
it("swipeOn lookFor finds the scoped target after a search gesture inside the resolved container", async () => {
  const result = await swipe("success", true, true);
  expect(result.success).toBe(true);
  expect(result.selectedTop).toBe(120);
  expect(result.gestures).toHaveLength(1);
  expect(result.gestures[0].x).toBeGreaterThanOrEqual(20);
  expect(result.gestures[0].x).toBeLessThanOrEqual(480);
  expect(result.gestures[0].y).toBeGreaterThanOrEqual(80);
  expect(result.gestures[0].y).toBeLessThanOrEqual(280);
});
describe("expected swipeOn semantics", () => {
  // Direct swipeOn resolves its innermost scope as the swipe container, with no separate leaf target.
  it("reports container-level failures at each resolved scope level", async () => {
    const cases = [
      ["target-miss", /Container level 3 not found: target/],
      ["target-ambiguous", /Container level 3 ambiguous/],
      ["inner-miss", /Container level 2 not found: item/],
      ["inner-ambiguous", /Container level 2 ambiguous/],
    ] as const;
    for (const [scenario, family] of cases) {
      const result = await swipe(scenario, false);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(family);
    }
  });
  it("lookFor swipes to search for a missing scoped target before timeout", async () => {
    const result = await swipe("target-miss", true);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found within container/i);
    expect(result.gestures).toHaveLength(1);
    expect(result.gestures[0].y).toBeGreaterThanOrEqual(80);
  });
  it("lookFor returns an already-visible scoped target without a gesture", async () => {
    const result = await swipe("success", true);
    expect(result.success).toBe(true);
    expect(result.gestures).toHaveLength(0);
    expect(result.selectedTop).toBe(120);
  });
});

// Reuse the existing bounded hierarchy arbitrary as unrelated generated content.
// Randomized wrappers/order/cardinality exercise structural, not geometric scope.
const generatedTree = fc.tuple(
  logicalNodeArb,
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }),
  fc.boolean(),
  fc.boolean(),
);
function unrelated(node: LogicalNode): LogicalNode {
  return {
    ...node,
    attrs: {
      ...node.attrs,
      "resource-id": `noise:${node.attrs["resource-id"] ?? ""}`,
      "view-id": `noise:${node.attrs["view-id"] ?? ""}`,
    },
    children: node.children.map(unrelated),
  };
}
function propertyCapture(
  noise: LogicalNode,
  count: number,
  wrappers: number,
  outsideFirst: boolean,
) {
  let inside = node(
    "",
    Array.from({ length: count }, (_, i) => node("target", [], 120 + i * 20, 135 + i * 20)),
  );
  for (let i = 0; i < wrappers; i++) {
    inside = node("", [inside]);
  }
  const scoped = node("cart", [node("item", [inside, unrelated(noise)])]);
  const peer = node("peer", [node("item", [node("target", [], 360, 420)])]);
  return node("root", outsideFirst ? [peer, scoped] : [scoped, peer], 0, 500);
}
function snapshot(root: LogicalNode, dollar: boolean) {
  return {
    id: "property",
    nodes: new SearchableHierarchy().project({
      hierarchy: { node: (dollar ? encodeIosDollar : encodeAndroidFlat)(root) },
    }),
  };
}
it("property: scoped resolution never selects a node outside its structural scope", () => {
  fc.assert(
    fc.property(generatedTree, ([noise, count, wrappers, outsideFirst, dollar]) => {
      const capture = snapshot(propertyCapture(noise, count, wrappers, outsideFirst), dollar);
      const result = new ElementResolver(() => 0).resolve(
        capture,
        { elementId: "target", container: scope("success"), selectionStrategy: "first" },
        { action: "inspect" },
      );
      expect(result.candidates).toHaveLength(count);
      if (!count) {
        expect(result.chosen).toBeNull();
        return;
      }
      expect(result.chosen).not.toBeNull();
      expect(result.candidates).toContain(result.chosen);
      expect(result.scope).toBeDefined();
      for (const candidate of result.candidates) {
        let parent = candidate.parentIndex;
        while (parent !== undefined && parent !== result.scope?.index) {
          parent = capture.nodes[parent].parentIndex;
        }
        expect(parent).toBe(result.scope?.index);
      }
    }),
    { numRuns: 20, seed: 7156 },
  );
});
it("property: first and unique choose the same node when exactly one scoped match exists", () => {
  fc.assert(
    fc.property(generatedTree, ([noise, _count, wrappers, outsideFirst, dollar]) => {
      const capture = snapshot(propertyCapture(noise, 1, wrappers, outsideFirst), dollar);
      const resolver = new ElementResolver(() => 0);
      const request = { elementId: "target", container: scope("success") };
      const first = resolver.resolve(
        capture,
        { ...request, selectionStrategy: "first" },
        { action: "inspect" },
      );
      const unique = resolver.resolve(
        capture,
        { ...request, selectionStrategy: "unique" },
        { action: "inspect" },
      );
      expect(first.candidates).toHaveLength(1);
      expect(first.error).toBeUndefined();
      expect(unique.error).toBeUndefined();
      expect(first.chosen).not.toBeNull();
      expect(unique.chosen).toBe(first.chosen);
    }),
    { numRuns: 20, seed: 7156 },
  );
});
