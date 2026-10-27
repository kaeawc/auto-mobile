import { beforeEach, describe, expect, test } from "bun:test";
import {
  PerformAccessibilityAction,
  accessibilityActionInputError,
  type AccessibilityActionService,
} from "../../../src/features/accessibility/PerformAccessibilityAction";
import type { AndroidAccessibilityActionRequest } from "../../../src/features/observe/android/AndroidActionDispatcher";
import type { A11yActionResult } from "../../../src/features/observe/android/types";
import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";

const android: BootedDevice = { deviceId: "a11y-action", platform: "android", name: "Pixel" };

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function observeResultWith(nodes: ViewHierarchyNode[]): ObserveResult {
  const viewHierarchy: ViewHierarchyResult = {
    hierarchy: { node: { $: { bounds: bounds(0, 0, 1080, 1920) }, node: nodes } },
  };
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
  } as ObserveResult;
}

class FakeAccessibilityActionService implements AccessibilityActionService {
  readonly requests: AndroidAccessibilityActionRequest[] = [];
  supported = true;
  result: A11yActionResult = { success: true, action: "expand", totalTimeMs: 1 };

  async supportsCommand(name: string): Promise<boolean> {
    return this.supported && name === "semantic_node_actions_v1";
  }

  async requestAccessibilityAction(
    request: AndroidAccessibilityActionRequest,
  ): Promise<A11yActionResult> {
    this.requests.push(request);
    return this.result;
  }
}

describe("PerformAccessibilityAction (#14077)", () => {
  let service: FakeAccessibilityActionService;
  let observeScreen: FakeObserveScreen;
  const feature = (device: BootedDevice = android) =>
    new PerformAccessibilityAction(device, { observeScreen, serviceFactory: () => service });

  beforeEach(() => {
    service = new FakeAccessibilityActionService();
    observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(
      observeResultWith([
        {
          $: {
            "resource-id": "com.example:id/row",
            text: "Inbox",
            bounds: bounds(0, 0, 1080, 120),
          },
        },
        { $: { "resource-id": "com.example:id/volume", bounds: bounds(0, 200, 1080, 260) } },
      ]),
    );
  });

  test("resolves the target and sends the action with its resource-id", async () => {
    const result = await feature().execute({ action: "expand", text: "Inbox" });

    expect(result).toEqual({ success: true, action: "expand", resourceId: "com.example:id/row" });
    expect(service.requests).toEqual([{ action: "expand", resourceId: "com.example:id/row" }]);
  });

  test("routes set_progress and custom arguments", async () => {
    await feature().execute({
      action: "set_progress",
      resourceId: "com.example:id/volume",
      progress: 0.5,
    });
    await feature().execute({
      action: "custom",
      resourceId: "com.example:id/row",
      customAction: "Archive",
    });

    expect(service.requests).toEqual([
      { action: "set_progress", resourceId: "com.example:id/volume", progress: 0.5 },
      { action: "custom", resourceId: "com.example:id/row", customAction: "Archive" },
    ]);
  });

  test("a device refusal is a failure that carries the available actions", async () => {
    service.result = {
      success: false,
      action: "dismiss",
      totalTimeMs: 1,
      error: "Accessibility action is unavailable: dismiss (available: click, expand)",
    };

    const result = await feature().execute({ action: "dismiss", text: "Inbox" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("(available: click, expand)");
  });

  test("an APK without the capability is refused before anything is sent", async () => {
    service.supported = false;

    await expect(feature().execute({ action: "expand", text: "Inbox" })).rejects.toThrow(
      "semantic_node_actions_v1",
    );
    expect(service.requests).toEqual([]);
  });

  test("contradictory arguments are rejected", () => {
    expect(accessibilityActionInputError({ action: "custom" })).toContain("customAction");
    expect(accessibilityActionInputError({ action: "set_progress" })).toContain("progress");
    expect(accessibilityActionInputError({ action: "expand", progress: 1 })).toContain(
      "set_progress",
    );
    expect(accessibilityActionInputError({ action: "expand", customAction: "x" })).toContain(
      "custom",
    );
    expect(accessibilityActionInputError({ action: "custom", customAction: "Archive" })).toBe(
      undefined,
    );
  });

  test("iOS is refused", async () => {
    await expect(
      feature({ deviceId: "sim", platform: "ios", name: "iPhone" }).execute({
        action: "expand",
        text: "Inbox",
      }),
    ).rejects.toThrow("only supported on Android");
  });
});
