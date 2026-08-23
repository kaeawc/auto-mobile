import { describe, expect, test, beforeEach } from "bun:test";
import { SetAccessibilityFocus } from "../../../src/features/accessibility/SetAccessibilityFocus";
import {
  ActionableError,
  BootedDevice,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAccessibilityFocusService } from "../../fakes/FakeAccessibilityFocusService";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";

const androidDevice: BootedDevice = {
  deviceId: "test-a11y-focus",
  platform: "android",
  isEmulator: true,
  name: "Test Device",
};

const iosDevice: BootedDevice = {
  deviceId: "test-a11y-focus-ios",
  platform: "ios",
  isEmulator: true,
  name: "Test Simulator",
};

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function makeViewHierarchy(nodes: any[]): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { bounds: bounds(0, 0, 1080, 1920) },
        node: nodes,
      },
    },
  } as ViewHierarchyResult;
}

function makeObserveResult(viewHierarchy: ViewHierarchyResult): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
  } as ObserveResult;
}

describe("SetAccessibilityFocus", () => {
  let service: FakeAccessibilityFocusService;
  let observeScreen: FakeObserveScreen;

  const makeFeature = (device: BootedDevice = androidDevice) =>
    new SetAccessibilityFocus(device, {
      finder: new DefaultElementFinder(),
      observeScreen,
      serviceFactory: () => service,
    });

  beforeEach(() => {
    service = new FakeAccessibilityFocusService();
    observeScreen = new FakeObserveScreen();
  });

  test("set focus by resource-id sends the 'focus' command", async () => {
    const feature = makeFeature();
    const result = await feature.execute({ action: "set", resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/title" }]);
  });

  test("action defaults to 'set' when omitted", async () => {
    const feature = makeFeature();
    await feature.execute({ resourceId: "com.example:id/title" });

    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/title" }]);
  });

  test("clear focus by resource-id sends the 'clear' command", async () => {
    const feature = makeFeature();
    const result = await feature.execute({ action: "clear", resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(service.calls).toEqual([{ method: "clear", resourceId: "com.example:id/title" }]);
  });

  test("returns focusedElement from requestCurrentFocus on success", async () => {
    service.currentFocusElement = {
      bounds: bounds(0, 0, 100, 50),
      "resource-id": "com.example:id/title",
    } as any;
    const feature = makeFeature();

    const result = await feature.execute({ resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(result.focusedElement?.["resource-id"]).toBe("com.example:id/title");
    // Focus was read back, so the move is confirmed and there is no warning (#3922).
    expect(result.confirmed).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test("resolves text selector to a resource-id via the element finder", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              text: "Settings",
              "resource-id": "com.example:id/settings",
              bounds: bounds(10, 20, 200, 60),
            },
          },
        ]),
      ),
    );
    const feature = makeFeature();

    const result = await feature.execute({ action: "set", text: "Settings" });

    expect(result.success).toBe(true);
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/settings" }]);
  });

  test("resolves contentDesc selector to a resource-id", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              "content-desc": "Close",
              "resource-id": "com.example:id/close",
              bounds: bounds(0, 0, 50, 50),
            },
          },
        ]),
      ),
    );
    const feature = makeFeature();

    await feature.execute({ action: "set", contentDesc: "Close" });

    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/close" }]);
  });

  test("contentDesc selector only matches content-desc, not a same-text label", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          // A visible text label "Close" — must NOT win for a contentDesc selector.
          {
            $: {
              text: "Close",
              "resource-id": "com.example:id/close_label",
              bounds: bounds(0, 0, 80, 40),
            },
          },
          // The icon whose content-desc is "Close" — the intended target.
          {
            $: {
              "content-desc": "Close",
              "resource-id": "com.example:id/close_icon",
              bounds: bounds(90, 0, 130, 40),
            },
          },
        ]),
      ),
    );
    const feature = makeFeature();

    await feature.execute({ action: "set", contentDesc: "Close" });

    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/close_icon" }]);
  });

  test("throws when a resourceId selector is shared by repeated rows", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              text: "Alice",
              "resource-id": "com.example:id/title",
              bounds: bounds(0, 0, 200, 60),
            },
          },
          {
            $: {
              text: "Bob",
              "resource-id": "com.example:id/title",
              bounds: bounds(0, 60, 200, 120),
            },
          },
        ]),
      ),
    );
    const feature = makeFeature();

    await expect(
      feature.execute({ action: "set", resourceId: "com.example:id/title" }),
    ).rejects.toThrow(/shared by 2 elements/);
    expect(service.calls).toHaveLength(0);
  });

  test("resourceId selector proceeds when the hierarchy cannot be observed", async () => {
    // No observe result configured -> getViewHierarchy throws; the resourceId guard is
    // best-effort, so the focus command is still sent.
    const feature = makeFeature();

    const result = await feature.execute({ action: "set", resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/title" }]);
  });

  test("resourceId selector proceeds when it is unique in the hierarchy", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              text: "Alice",
              "resource-id": "com.example:id/title",
              bounds: bounds(0, 0, 200, 60),
            },
          },
        ]),
      ),
    );
    const feature = makeFeature();

    const result = await feature.execute({ action: "set", resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/title" }]);
  });

  test("throws when text selector resolves to a resource-id shared by repeated rows", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              text: "Alice",
              "resource-id": "com.example:id/title",
              bounds: bounds(0, 0, 200, 60),
            },
          },
          {
            $: {
              text: "Bob",
              "resource-id": "com.example:id/title",
              bounds: bounds(0, 60, 200, 120),
            },
          },
        ]),
      ),
    );
    const feature = makeFeature();

    await expect(feature.execute({ action: "set", text: "Bob" })).rejects.toThrow(
      /shared by 2 elements/,
    );
    expect(service.calls).toHaveLength(0);
  });

  test("throws when matched element has no resource-id", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([{ $: { text: "Settings", bounds: bounds(10, 20, 200, 60) } }]),
      ),
    );
    const feature = makeFeature();

    await expect(feature.execute({ action: "set", text: "Settings" })).rejects.toThrow(
      /no resource-id/,
    );
    expect(service.calls).toHaveLength(0);
  });

  test("throws ActionableError when text selector matches nothing (node not found)", async () => {
    observeScreen.setObserveResult(makeObserveResult(makeViewHierarchy([])));
    const feature = makeFeature();

    await expect(feature.execute({ action: "set", text: "DoesNotExist" })).rejects.toThrow(
      /Element not found/,
    );
    expect(service.calls).toHaveLength(0);
  });

  test("throws ActionableError when no selector is provided", async () => {
    const feature = makeFeature();
    await expect(feature.execute({ action: "set" })).rejects.toBeInstanceOf(ActionableError);
    expect(service.calls).toHaveLength(0);
  });

  test("returns success:false with the service error when set fails", async () => {
    service.setSetThrows(new Error("Element not found with resource-id: com.example:id/missing"));
    const feature = makeFeature();

    const result = await feature.execute({ action: "set", resourceId: "com.example:id/missing" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found with resource-id");
  });

  test("returns success:false with the service error when clear fails", async () => {
    service.setClearThrows(new Error("Action timeout after 5000ms"));
    const feature = makeFeature();

    const result = await feature.execute({ action: "clear", resourceId: "com.example:id/title" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });

  test("still succeeds when requestCurrentFocus throws (best-effort confirmation)", async () => {
    service.setCurrentFocusThrows(new Error("focus read failed"));
    const feature = makeFeature();

    const result = await feature.execute({ resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(result.focusedElement).toBeUndefined();
    // The confirmation read failed: surface confirmed:false + a warning so callers
    // can distinguish "focused, couldn't confirm" from "didn't focus" (#3922).
    expect(result.confirmed).toBe(false);
    expect(result.warning).toContain("could not be read back");
  });

  test("throws ActionableError on iOS (Android-only gating)", async () => {
    const feature = makeFeature(iosDevice);
    await expect(feature.execute({ action: "set", resourceId: "x" })).rejects.toThrow(
      /only supported on Android/,
    );
    expect(service.calls).toHaveLength(0);
  });
});
