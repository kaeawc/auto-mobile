import { describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = {
  deviceId: "fixture-ios",
  platform: "ios",
  name: "Fixture iPhone",
};

const searchBounds = { left: 20, top: 100, right: 380, bottom: 144 };
const otherBounds = { left: 20, top: 200, right: 380, bottom: 244 };

function searchBar(focused: boolean) {
  return {
    $: {
      class: "UISearchBar",
      role: "textfield",
      text: "Search videos",
      focused,
      bounds: searchBounds,
    },
    node: [
      {
        $: { class: "UISearchBarTextField", text: "Search videos", bounds: searchBounds },
        node: [
          {
            $: { class: "UISearchBarTextFieldLabel", text: "Search videos", bounds: searchBounds },
          },
          { $: { class: "_UISearchBarFieldEditor", bounds: searchBounds } },
        ],
      },
    ],
  };
}

function fixture(duplicates: number, focusedOther = false): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { class: "XCUIApplication", bounds: { left: 0, top: 0, right: 400, bottom: 800 } },
        node: [
          ...Array.from({ length: duplicates }, () => searchBar(!focusedOther)),
          {
            $: {
              class: "UITextField",
              role: "textfield",
              text: "Account",
              focused: focusedOther,
              bounds: otherBounds,
            },
          },
        ],
      },
    },
  };
}

function verifySelectedField(
  hierarchy: ViewHierarchyResult,
  target: Element,
  options: TapOnElementOptions = { text: "Search videos", action: "focus" },
): boolean {
  const tap = new TapOnElement(device, null, { timer: new FakeTimer() });
  const verifier = tap as unknown as {
    verifyFocusedInputTarget: (
      options: TapOnElementOptions,
      target: Element,
      observation: ObserveResult,
      labelText?: string,
    ) => boolean;
  };
  const observation = { viewHierarchy: hierarchy } as ObserveResult;
  return verifier.verifyFocusedInputTarget(options, target, observation, "Search videos");
}

describe("iOS search bar focus fixture", () => {
  test.each([1, 3])("accepts parent focus for the inner field with %i subtree copies", (copies) => {
    const hierarchy = fixture(copies);
    const inner = new SearchableHierarchy()
      .project(hierarchy)
      .find((node) => node.properties.class === "UISearchBarTextField")?.element;
    expect(inner).toBeDefined();
    expect(verifySelectedField(hierarchy, inner!)).toBe(true);
  });

  test("accepts the editable parent selected from text shared with its label", () => {
    const hierarchy = fixture(1);
    // owner decision D43 (#6523): the screen size follows the capture platform; this fixture is an iOS capture, so say so
    const selection = new ResolverElementSelector(undefined, undefined, {
      platform: "ios",
    }).selectByText(hierarchy, "Search videos", {
      selectionIntent: "focus-input",
    });
    expect(selection.element?.class).toBe("UISearchBar");
    expect(verifySelectedField(hierarchy, selection.element!)).toBe(true);
  });

  test("recognizes a selector match on the inner label as the same focused field", () => {
    const hierarchy = fixture(1);
    const label = new SearchableHierarchy()
      .project(hierarchy)
      .find((node) => node.properties.class === "UISearchBarTextFieldLabel")?.element;
    expect(label).toBeDefined();
    expect(verifySelectedField(hierarchy, label!)).toBe(true);
  });

  test("keeps a duplicated field's indexed identity when focus is on its parent", () => {
    const hierarchy = fixture(3);
    for (const bar of hierarchy.hierarchy.node!.node!.slice(0, 3)) {
      bar.node![0].$["view-id"] = "search-field";
      bar.node![0].$.role = "textfield";
    }
    const inner = new SearchableHierarchy()
      .project(hierarchy)
      .find((node) => node.properties.class === "UISearchBarTextField")?.element;
    expect(inner).toBeDefined();
    expect(
      verifySelectedField(hierarchy, inner!, { elementId: "search-field", action: "focus" }),
    ).toBe(true);
  });

  test("verifies the indexed field against its own focused parent", () => {
    const hierarchy = fixture(3);
    const bars = hierarchy.hierarchy.node!.node!.slice(0, 3);
    for (const [index, bar] of bars.entries()) {
      bar.$.focused = index === 1;
      bar.node![0].$["view-id"] = "search-field";
      bar.node![0].$.role = "textfield";
    }
    const inner = new SearchableHierarchy()
      .project(hierarchy)
      .filter((node) => node.properties.class === "UISearchBarTextField")[1]?.element;
    expect(inner).toBeDefined();
    expect(
      verifySelectedField(hierarchy, inner!, {
        elementId: "search-field",
        action: "focus",
        index: 1,
      }),
    ).toBe(true);
    expect(
      verifySelectedField(hierarchy, inner!, {
        elementId: "search-field",
        action: "focus",
        index: 0,
      }),
    ).toBe(false);
  });

  test("accepts focus on the inner field when the editable parent is selected", () => {
    const hierarchy = fixture(1);
    // owner decision D43 (#6523): the screen size follows the capture platform; this fixture is an iOS capture, so say so
    const parent = new ResolverElementSelector(undefined, undefined, {
      platform: "ios",
    }).selectByText(hierarchy, "Search videos", {
      selectionIntent: "focus-input",
    }).element!;
    const root = hierarchy.hierarchy.node!;
    const bar = root.node![0];
    bar.$.focused = false;
    bar.node![0].$.focused = true;
    bar.node![0].$.role = "textfield";
    expect(
      verifySelectedField(hierarchy, { ...parent, class: "UISearchBar", role: "textfield" }),
    ).toBe(true);
  });

  test("rejects focus on an unrelated editable field", () => {
    const hierarchy = fixture(3, true);
    // owner decision D43 (#6523): the screen size follows the capture platform; this fixture is an iOS capture, so say so
    const selection = new ResolverElementSelector(undefined, undefined, {
      platform: "ios",
    }).selectByText(hierarchy, "Search videos", {
      selectionIntent: "focus-input",
    });
    expect(selection.element).toBeDefined();
    expect(verifySelectedField(hierarchy, selection.element!)).toBe(false);
  });
});
