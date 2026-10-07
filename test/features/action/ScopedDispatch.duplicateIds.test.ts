import { expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TalkBackTapStrategy } from "../../../src/features/talkback/TalkBackTapStrategy";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { DefaultElementGeometry } from "../../../src/features/utility/ElementGeometry";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../../src/models";
import type { ElementContainerSelector } from "../../../src/models/PinchOnOptions";
import type { AccessibilityNodeSelector } from "../../../src/features/observe/android/types";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { FakeTimer } from "../../fakes/FakeTimer";
import fixture from "../../fixtures/observe/ctrlproxy-notification-group-compact-bounds.json";

const capture: ViewHierarchyResult = { hierarchy: { node: fixture.expanded } };
const nodes = new SearchableHierarchy().project(capture);
const device = {
  name: "Captured duplicates",
  platform: "android" as const,
  deviceId: "fake-10288",
};
const containerId = "android:id/expand_button_touch_container";
const targetId = "android:id/expand_button";
const rows: readonly { name: string; container?: ElementContainerSelector; y: number }[] = [
  { name: "unscoped", y: 641.5 },
  { name: "one-level", container: { elementId: containerId }, y: 825 },
  { name: "container index", container: { elementId: containerId, index: 1 }, y: 1044 },
  {
    name: "per-level strategy",
    container: { elementId: containerId, selectionStrategy: "first" },
    y: 825,
  },
];

// Use the full captured tree, not the traversal-only synthetic hierarchy the base
// navigation fake offers. Forward semantic calls to the existing typed service fake.
class CapturedDriver extends FakeTalkBackNavigationDriver {
  constructor(private readonly service: FakeCtrlProxy) {
    super();
  }
  override async getAccessibilityHierarchy() {
    return this.service.getAccessibilityHierarchy();
  }
  override async requestAction(action: string, resourceId?: string) {
    return this.service.requestAction(action, resourceId);
  }
  override async requestNodeAction(action: string, selector: AccessibilityNodeSelector) {
    return this.service.requestNodeAction(action, selector);
  }
}

for (const row of rows) {
  for (const tool of ["tapOn", "tapAny"] as const) {
    test(`${tool} ${row.name}: duplicate IDs dispatch only the resolved coordinates`, async () => {
      const id =
        tool === "tapAny" && !row.container ? "android:id/alternate_expand_target" : targetId;
      const x = id === targetId ? 964 : 110;
      const y = Math.floor(row.y);
      const expectedNode = nodes.find(
        (node) =>
          node.nativeId === id &&
          node.bounds &&
          (node.bounds.top + node.bounds.bottom) / 2 === row.y,
      );
      expect(expectedNode?.bounds).toBeDefined();
      if (row.container) {
        expect(expectedNode?.parentIndex).toBeDefined();
        expect(nodes[expectedNode!.parentIndex!]?.nativeId).toBe(containerId);
        const outside = nodes.find((node) => node.nativeId === targetId)!;
        expect(nodes[outside.parentIndex!]?.nativeId).not.toBe(containerId);
        expect(outside.bounds).not.toEqual(expectedNode?.bounds);
      }
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adb = new FakeAdbExecutor();
      const service = new FakeCtrlProxy(timer);
      service.setViewHierarchyResult(capture);
      const driver = new CapturedDriver(service);
      const strategy = new TalkBackTapStrategy({ timer });
      const direct = spyOn(strategy, "executeDirectActivation");
      const selector = new ResolverElementSelector();
      const detector = new FakeAccessibilityDetector();
      detector.setTalkBackEnabled(true);
      const dependencies = {
        timer,
        elementSelector: selector,
        accessibilityDetector: detector,
        talkBackStrategy: strategy,
        talkBackDriverFactory: { createDriver: () => driver },
      };
      try {
        if (tool === "tapOn") {
          const tap = new TapOnElement(device, adb, dependencies);
          const options = {
            action: "tap" as const,
            elementId: targetId,
            selectionStrategy: "first" as const,
            container: row.container,
            resolvedHierarchy: capture,
          };
          const element = tap.findElementInHierarchy(options, capture).selection.element;
          expect(element).not.toBeNull();
          if (!element?.bounds) {
            throw new Error("Captured target must have bounds");
          }
          expect(element["resource-id"]).toBe(targetId);
          expect(element.bounds).toEqual(expectedNode?.bounds);
          const point = new DefaultElementGeometry().getElementCenter(element);
          expect(point).toEqual({ x, y });
          await tap.executeAndroidTap(
            "tap",
            point.x,
            point.y,
            500,
            element,
            undefined,
            options,
            true,
          );
        } else {
          const tap = new TapAnyElement(device, adb, {
            ...dependencies,
            accessibilityService: service,
          });
          // Reuse the real capture for fresh lookup. After dispatch the fake
          // probe is unreadable, so retry cannot obscure the first dispatch.
          tap.observedInteraction = (action) =>
            action({ viewHierarchy: capture, screenSize: { width: 1080, height: 2400 } });
          let dispatched = false;
          tap.setBeforeAndroidTapForTesting(() => {
            dispatched = true;
          });
          tap.setRefreshViewHierarchyForTesting(async () => (dispatched ? null : capture));
          const result = await tap.execute({
            action: "tap",
            selectionStrategy: "first",
            container: row.container,
          });
          expect(result.error).toBeUndefined();
          expect(result.success).toBe(true);
        }
        // The complete tree contains four copies of this ID. A global click
        // could target the header, outside each selected touch container.
        expect(nodes.filter((node) => node.nativeId === id)).toHaveLength(4);
        expect(direct.mock.calls).toHaveLength(1);
        expect(direct.mock.calls[0]?.[0]["resource-id"]).toBe(id);
        expect(direct.mock.calls[0]?.[0].bounds).toEqual(expectedNode?.bounds);
        expect(await direct.mock.results[0]?.value).toMatchObject({
          success: false,
          error: `Selected resource-id "${id}" is shared by 4 elements; using coordinate fallback.`,
        });
        expect(service.getActionHistory()).toEqual([]);
        expect(service.getNodeActionHistory()).toEqual([]);
        expect(driver.tapHistory).toEqual([{ x, y, durationMs: 50 }]);
        expect(driver.doubleTapHistory).toEqual([{ x, y }]);
        expect(service.getTapHistory()).toEqual([]);
        expect(adb.getExecutedCommands()).toEqual([]);
      } finally {
        direct.mockRestore();
      }
    });
  }
}
