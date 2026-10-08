import { logger } from "../../../src/utils/logger";
import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import { SetAccessibilityFocus } from "../../../src/features/accessibility/SetAccessibilityFocus";
import {
  ActionableError,
  BootedDevice,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAccessibilityFocusService } from "../../fakes/FakeAccessibilityFocusService";

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
      observeScreen,
      serviceFactory: () => service,
    });

  beforeEach(() => {
    service = new FakeAccessibilityFocusService();
    observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          { $: { "resource-id": "com.example:id/title", bounds: bounds(0, 0, 100, 50) } },
        ]),
      ),
    );
  });

  test("set focus by resource-id sends the 'focus' command", async () => {
    const feature = makeFeature();
    const result = await feature.execute({ action: "set", resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/title" }]);
  });

  test("reports alreadySatisfied when the runner found the node already focused (#10148)", async () => {
    service.outcome = { alreadySatisfied: true };
    const result = await makeFeature().execute({ resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(result.alreadySatisfied).toBe(true);
  });

  test("reports alreadySatisfied when clearing a node that was not focused (#10148)", async () => {
    service.outcome = { alreadySatisfied: true };
    const result = await makeFeature().execute({
      action: "clear",
      resourceId: "com.example:id/title",
    });

    expect(result.success).toBe(true);
    expect(result.alreadySatisfied).toBe(true);
  });

  test("omits alreadySatisfied when the action was actually performed", async () => {
    const result = await makeFeature().execute({ resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect("alreadySatisfied" in result).toBe(false);
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

  test("resolves text selector to a resource-id via the shared resolver", async () => {
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

  test.each([
    ["text", "Settings"],
    ["contentDesc", "Settings"],
  ] as const)("%s selector rejects an ID-bearing match without bounds", async (selector, value) => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              "resource-id": "com.example:id/hidden",
              [selector === "text" ? "text" : "content-desc"]: value,
            },
          },
        ]),
      ),
    );

    await expect(makeFeature().execute({ [selector]: value })).rejects.toThrow("Element not found");
    expect(service.calls).toEqual([]);
  });

  test("text selector does not focus a substring near miss", async () => {
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
    await expect(makeFeature().execute({ action: "set", text: "Set" })).rejects.toThrow(
      "Element not found",
    );
    expect(service.calls).toEqual([]);
  });

  test("text focus sends the matched child's native ID instead of its clickable row", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              "resource-id": "com.example:id/row",
              clickable: true,
              bounds: bounds(0, 0, 300, 80),
            },
            node: [
              {
                $: {
                  "resource-id": "com.example:id/label",
                  text: "Settings",
                  bounds: bounds(10, 10, 200, 60),
                },
              },
            ],
          },
        ]),
      ),
    );

    await makeFeature().execute({ text: "Settings" });

    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/label" }]);
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

  test("contentDesc focus uses the matching child's native ID", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              "resource-id": "com.example:id/row",
              clickable: true,
              bounds: bounds(0, 0, 100, 100),
            },
            node: [
              {
                $: {
                  "resource-id": "com.example:id/close_icon",
                  "content-desc": "Close",
                  bounds: bounds(10, 10, 40, 40),
                },
              },
            ],
          },
        ]),
      ),
    );
    await makeFeature().execute({ action: "set", contentDesc: "Close" });
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/close_icon" }]);
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

  test("contentDesc selector also matches the documented accessible label", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              "ios-accessibility-label": "Save",
              "resource-id": "com.example:id/save",
              bounds: bounds(0, 0, 80, 40),
            },
          },
        ]),
      ),
    );

    await makeFeature().execute({ action: "set", contentDesc: "Save" });

    expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/save" }]);
  });

  test("mixed selector fields retain resource ID then text precedence", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              "resource-id": "com.example:id/id_target",
              text: "ID row",
              bounds: bounds(0, 0, 80, 40),
            },
          },
          {
            $: {
              "resource-id": "com.example:id/text_target",
              text: "Name",
              bounds: bounds(0, 50, 80, 90),
            },
          },
          {
            $: {
              "resource-id": "com.example:id/desc_target",
              "content-desc": "Description",
              bounds: bounds(0, 100, 80, 140),
            },
          },
        ]),
      ),
    );
    await makeFeature().execute({
      resourceId: "id_target",
      text: "Name",
      contentDesc: "Description",
    });
    await makeFeature().execute({ text: "Name", contentDesc: "Description" });
    expect(service.calls).toEqual([
      { method: "set", resourceId: "com.example:id/id_target" },
      { method: "set", resourceId: "com.example:id/text_target" },
    ]);
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

  test("bare native IDs count namespace-equivalent service targets", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          { $: { "resource-id": "title", bounds: bounds(0, 0, 100, 50) } },
          { $: { "resource-id": "com.example:id/title", bounds: bounds(0, 60, 100, 110) } },
        ]),
      ),
    );

    await expect(makeFeature().execute({ resourceId: "title" })).rejects.toThrow(
      /shared by 2 elements/,
    );
    expect(service.calls).toHaveLength(0);
  });

  test("resourceId selector fails when the hierarchy cannot be observed", async () => {
    observeScreen = new FakeObserveScreen();
    await expect(
      makeFeature().execute({ action: "set", resourceId: "com.example:id/title" }),
    ).rejects.toThrow();
    expect(service.calls).toEqual([]);
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
    const failure = new Error("Element not found with resource-id: com.example:id/missing");
    service.setSetThrows(failure);
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          { $: { "resource-id": "com.example:id/missing", bounds: bounds(0, 0, 100, 50) } },
        ]),
      ),
    );
    const feature = makeFeature();

    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await feature.execute({ action: "set", resourceId: "com.example:id/missing" });
      expect(result).toEqual({ success: false, error: failure.message });
      expect(warn).toHaveBeenCalledWith(
        `[accessibilityFocus] Failed to set focus: ${failure.message}`,
        failure,
      );
    } finally {
      warn.mockRestore();
    }
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

  test("treats an error-carrying read-back result as unconfirmed (#10036)", async () => {
    // The real client resolves an error result on timeout/disconnect instead of throwing.
    service.setCurrentFocusError("Current focus timeout after 5000ms");
    const feature = makeFeature();

    const result = await feature.execute({ resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(result.focusedElement).toBeUndefined();
    expect(result.confirmed).toBe(false);
    expect(result.warning).toContain("could not be read back");
    expect(result.warning).toContain("acknowledged");
    expect(result.warning).toContain("Current focus timeout after 5000ms");
  });

  test("treats an error-carrying read-back after clear as unconfirmed (#10036)", async () => {
    service.setCurrentFocusError("Failed to connect to accessibility service");
    const feature = makeFeature();

    const result = await feature.execute({ action: "clear", resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.warning).toContain("Focus clear was acknowledged");
    expect(result.warning).toContain("Failed to connect to accessibility service");
  });

  test("a read-back with no focused element and no error stays confirmed", async () => {
    const feature = makeFeature();

    const result = await feature.execute({ action: "clear", resourceId: "com.example:id/title" });

    expect(result.success).toBe(true);
    expect(result.focusedElement).toBeUndefined();
    expect(result.confirmed).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test("throws ActionableError on iOS (Android-only gating)", async () => {
    const feature = makeFeature(iosDevice);
    await expect(feature.execute({ action: "set", resourceId: "x" })).rejects.toThrow(
      /only supported on Android/,
    );
    expect(service.calls).toHaveLength(0);
  });
  test("rejects an unknown native ID without contacting the service", async () => {
    observeScreen.setObserveResult(makeObserveResult(makeViewHierarchy([])));
    await expect(makeFeature().execute({ resourceId: "com.app:id/missing" })).rejects.toThrow(
      /not found/i,
    );
    expect(service.calls).toEqual([]);
  });

  test("resolves an observed synthetic ID locally without fabricating a native ID", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          { $: { "view-id": "s-abcdef123456", text: "Save", bounds: bounds(10, 20, 60, 80) } },
        ]),
      ),
    );
    await expect(makeFeature().execute({ resourceId: "s-abcdef123456" })).rejects.toThrow(
      /resource-id/,
    );
    expect(service.calls).toEqual([]);
  });

  test("bare native ID resolves and forwards the exact qualified ID", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          { $: { "resource-id": "com.app:id/save", text: "Save", bounds: bounds(10, 20, 60, 80) } },
        ]),
      ),
    );
    await makeFeature().execute({ resourceId: "save" });
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.app:id/save" }]);
  });

  test("text focus prefers the topmost window rather than the smallest background label", async () => {
    const hierarchy = makeViewHierarchy([
      { $: { text: "Save", "resource-id": "com.app:id/background", bounds: bounds(0, 0, 10, 10) } },
    ]);
    hierarchy.windows = [
      {
        windowLayer: 9,
        hierarchy: {
          node: {
            text: "Save",
            "resource-id": "com.app:id/dialog",
            bounds: bounds(100, 100, 400, 200),
          },
        },
      },
    ] as any;
    observeScreen.setObserveResult(makeObserveResult(hierarchy));
    await makeFeature().execute({ text: "Save" });
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.app:id/dialog" }]);
  });

  test("an observed node key forwards its real native ID when present", async () => {
    observeScreen.setObserveResult(
      makeObserveResult(
        makeViewHierarchy([
          {
            $: {
              "view-id": "s-abcdef123456",
              "resource-id": "com.app:id/save",
              bounds: bounds(10, 20, 60, 80),
            },
          },
        ]),
      ),
    );
    await makeFeature().execute({ resourceId: "s-abcdef123456" });
    expect(service.calls).toEqual([{ method: "set", resourceId: "com.app:id/save" }]);
  });
});
