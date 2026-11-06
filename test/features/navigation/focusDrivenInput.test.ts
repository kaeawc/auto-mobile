import { describe, expect, test } from "bun:test";
import {
  deviceInputModeResolver,
  focusTargetForElement,
} from "../../../src/features/navigation/focusDrivenInput";
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
