import { describe, expect, test } from "bun:test";
import {
  deviceInputModeResolver,
  dpadReplayInteraction,
  focusTargetForElement,
  focusTargetFromSelector,
} from "../../../src/features/navigation/focusDrivenInput";
import {
  elementMatchesTarget,
  screenTargetMatcher,
} from "../../../src/features/action/FocusNavigate";
import { extractNavigationElements } from "../../../src/features/navigation/ExploreElementExtraction";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { androidDeviceTraits, FakeDeviceTraits } from "../../fakes/FakeDeviceTraits";
import { createHierarchyForTest } from "../observe/observeScreenTestBuilders";

const android: BootedDevice = { deviceId: "emulator-5554", name: "TV", platform: "android" };

function resolverFor(device: BootedDevice, traits: FakeDeviceTraits) {
  return deviceInputModeResolver(device, { traits, adbFactory: new FakeAdbClientFactory() });
}

describe("deviceInputModeResolver", () => {
  test("a device whose build announces tv uses the D-pad, read once", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "tv" }));
    const resolve = resolverFor(android, traits);
    expect(await resolve()).toBe("dpad");
    expect(await resolve()).toBe("dpad");
    expect(traits.reads).toHaveLength(1);
  });

  test("a phone build stays on touch", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: null }));
    expect(await resolverFor(android, traits)()).toBe("touch");
  });

  test("a known tv form factor skips the traits read", async () => {
    const traits = new FakeDeviceTraits();
    expect(await resolverFor({ ...android, formFactor: "tv" }, traits)()).toBe("dpad");
    expect(traits.reads).toEqual([]);
  });

  test("iOS never reads Android traits and stays on touch", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "tv" }));
    expect(await resolverFor({ ...android, platform: "ios" }, traits)()).toBe("touch");
    expect(traits.reads).toEqual([]);
  });

  test("an unreadable build falls back to touch", async () => {
    const traits = new FakeDeviceTraits(new Error("adb offline"));
    expect(await resolverFor(android, traits)()).toBe("touch");
  });
});

describe("focusTargetFromSelector", () => {
  test("prefers the element id, then text", () => {
    expect(focusTargetFromSelector({ elementId: "app:id/row", text: "Movies" })).toEqual({
      resourceId: "app:id/row",
    });
    expect(focusTargetFromSelector({ elementId: "save" })).toEqual({ resourceId: "save" });
    expect(focusTargetFromSelector({ text: "Movies" })).toEqual({ label: "Movies" });
    expect(focusTargetFromSelector({ text: "  " })).toBeNull();
    expect(focusTargetFromSelector({ x: 1, y: 2 })).toBeNull();
  });
});

describe("a namespaced recorded id", () => {
  const at = (id: string) => ({
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    "resource-id": id,
  });

  test("matches a control whose native id is the bare name", () => {
    const until = focusTargetFromSelector({ elementId: "com.example:id/save" })!;
    expect(until).toEqual({ resourceId: "com.example:id/save" });
    expect(elementMatchesTarget(at("save"), until)).toBe(true);
    expect(elementMatchesTarget(at("com.example:id/save"), until)).toBe(true);
  });

  test("prefers the exact qualified id over another namespace's same name", () => {
    const until = { resourceId: "com.example:id/save" };
    const other = at("com.other:id/save");
    const isTarget = screenTargetMatcher([other, at("com.example:id/save")], until);
    expect(isTarget(other)).toBe(false);
    expect(screenTargetMatcher([other], until)(other)).toBe(false);
    expect(screenTargetMatcher([at("save")], until)(at("save"))).toBe(true);
  });
});

describe("dpadReplayInteraction", () => {
  const replay = (toolName: string, args: Record<string, unknown>) =>
    dpadReplayInteraction({ toolName, args });

  test("rewrites a public and an explore-flat tapOn into focusNavigate with select", () => {
    expect(replay("tapOn", { selector: { text: "Movies" }, action: "tap" })).toEqual({
      toolName: "focusNavigate",
      args: { until: { label: "Movies" }, select: true },
    });
    expect(replay("tapOn", { elementId: "app:id/row" })).toEqual({
      toolName: "focusNavigate",
      args: { until: { resourceId: "app:id/row" }, select: true },
    });
  });

  test("leaves other actions and tools unchanged", () => {
    const unchanged: Array<{ toolName: string; args: Record<string, unknown> }> = [
      { toolName: "tapOn", args: { selector: { text: "Row" }, action: "longPress" } },
      { toolName: "tapAt", args: { x: 1, y: 2 } },
      { toolName: "focusNavigate", args: { until: { text: "Row" }, select: true } },
      { toolName: "tapOn", args: { x: 1, y: 2 } },
      { toolName: "tapOn", args: { selector: { text: "Row" }, duration: 800 } },
      { toolName: "tapOn", args: { selector: { text: "More" }, index: 1, action: "tap" } },
      { toolName: "tapOn", args: { text: "More", index: 1 } },
      {
        toolName: "tapOn",
        args: { selector: { elementId: "app:id/more" }, container: { elementId: "app:id/row_2" } },
      },
      {
        toolName: "tapOn",
        args: { selector: { elementId: "app:id/more", container: { text: "Row 2" } } },
      },
    ];
    for (const interaction of unchanged) {
      expect(dpadReplayInteraction(interaction)).toBe(interaction);
    }
  });
});

describe("focusTargetForElement", () => {
  const parser = new DefaultElementParser();

  function candidate(attributes: Record<string, string>) {
    const hierarchy = createHierarchyForTest({
      hierarchy: {
        node: [
          {
            $: {
              class: "android.widget.FrameLayout",
              clickable: "true",
              enabled: "true",
              focusable: "true",
              bounds: "[0,0][200,100]",
              ...attributes,
            },
          },
        ],
      },
      packageName: "com.example.tv",
    });
    const [element] = extractNavigationElements(hierarchy, parser);
    return { element, hierarchy };
  }

  test("returns null for a duplicate that needs an occurrence index", () => {
    const tile = {
      class: "android.widget.FrameLayout",
      clickable: "true",
      enabled: "true",
      focusable: "true",
      "resource-id": "app:id/more",
      text: "More",
    };
    const hierarchy = createHierarchyForTest({
      hierarchy: {
        node: [
          { $: { ...tile, bounds: "[0,0][200,100]" } },
          { $: { ...tile, bounds: "[0,100][200,200]" } },
        ],
      },
      packageName: "com.example.tv",
    });
    const [, second] = extractNavigationElements(hierarchy, parser);
    expect(focusTargetForElement(second, hierarchy)).toBeNull();
  });

  test("uses the resource id when the element has one", () => {
    const { element, hierarchy } = candidate({ "resource-id": "app:id/movies", text: "Movies" });
    expect(focusTargetForElement(element, hierarchy)).toEqual({ resourceId: "app:id/movies" });
  });

  test("matches a text label on text and a description-only label on content-desc", () => {
    const text = candidate({ "resource-id": "", text: "Movies" });
    expect(focusTargetForElement(text.element, text.hierarchy)).toEqual({ text: "Movies" });
    const described = candidate({ "resource-id": "", text: "", "content-desc": "Search" });
    expect(focusTargetForElement(described.element, described.hierarchy)).toEqual({
      contentDesc: "Search",
    });
  });
});
