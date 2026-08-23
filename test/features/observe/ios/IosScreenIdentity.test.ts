import { describe, expect, test } from "bun:test";
import { deriveIosScreenIdentity } from "../../../../src/features/observe/ios/IosScreenIdentity";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../../src/models/ViewHierarchyResult";

type Attrs = Record<string, unknown>;

function node(attrs: Attrs, children: ViewHierarchyNode[] = []): ViewHierarchyNode {
  return {
    $: attrs,
    ...(children.length > 0 ? { node: children } : {}),
  };
}

function hierarchy(
  children: ViewHierarchyNode[],
  packageName = "com.apple.reminders",
): ViewHierarchyResult {
  return {
    packageName,
    screenScale: 3,
    hierarchy: {
      node: node({ class: "XCUIApplication" }, children),
    },
  };
}

function navigationBar(title: string): ViewHierarchyNode {
  return node({ class: "UINavigationBar", text: title }, [
    node({ class: "_UINavigationBarTitleControl", text: title }),
  ]);
}

describe("deriveIosScreenIdentity", () => {
  test("distinguishes Reminders main list, new reminder sheet, discard action sheet, and keyboard editor", () => {
    const main = deriveIosScreenIdentity(
      hierarchy([
        navigationBar("Reminders"),
        node({ class: "UIToolbar", text: "Toolbar" }, [
          node({ class: "UIButton", text: "New Reminder", clickable: "true" }),
        ]),
      ]),
    );

    const sheet = deriveIosScreenIdentity(
      hierarchy([
        navigationBar("New Reminder"),
        node({
          class: "UITextField",
          text: "Title",
          "resource-id": "Quick Entry Title Field",
          focused: "true",
        }),
        node({ class: "UIView", text: "Quick bar" }),
      ]),
    );

    const actionSheet = deriveIosScreenIdentity(
      hierarchy([
        node({ class: "UIActionSheet" }, [
          node({ class: "UIButton", text: "Discard Changes", clickable: "true" }),
          node({ class: "UIButton", text: "Cancel", clickable: "true" }),
        ]),
      ]),
    );

    const keyboardEditor = deriveIosScreenIdentity(
      hierarchy([
        navigationBar("New Reminder"),
        node({
          class: "UITextField",
          text: "Title",
          value: "Diff test",
          "resource-id": "Quick Entry Title Field",
          focused: "true",
        }),
        node({ class: "UIKeyboard" }, [
          node({ class: "UIKeyboardKey", text: "Q", clickable: "true" }),
        ]),
      ]),
    );

    const keys = [main, sheet, actionSheet, keyboardEditor].map((identity) => identity?.key);

    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(4);
    expect(actionSheet?.components.modalClass).toBe("UIActionSheet");
    expect(keyboardEditor?.components.keyboardVisible).toBe(true);
  });

  test("is stable across minor bounds churn", () => {
    const first = deriveIosScreenIdentity(
      hierarchy([
        navigationBar("Reminders"),
        node({
          class: "UITableViewCell",
          text: "Reminders, 1 reminder",
          bounds: { left: 20, top: 559, right: 382, bottom: 614 },
        }),
      ]),
    );
    const second = deriveIosScreenIdentity(
      hierarchy([
        navigationBar("Reminders"),
        node({
          class: "UITableViewCell",
          text: "Reminders, 1 reminder",
          bounds: { left: 21, top: 560, right: 383, bottom: 615 },
        }),
      ]),
    );

    expect(first?.key).toBe(second?.key);
    expect(first?.components).toEqual(second?.components);
  });

  test("is deterministic for a Playground tab screen", () => {
    const playground = hierarchy(
      [
        navigationBar("Demos"),
        node({ class: "UITabBar", text: "Tab Bar" }, [
          node({ class: "UIButton", text: "Discover" }),
          node({ class: "UIButton", text: "Demos", selected: "true", "resource-id": "play.fill" }),
          node({ class: "UIButton", text: "Settings" }),
        ]),
      ],
      "dev.jasonpearson.automobile.Playground",
    );

    const first = deriveIosScreenIdentity(playground);
    const second = deriveIosScreenIdentity(JSON.parse(JSON.stringify(playground)));

    expect(first).toEqual(second);
    expect(first?.components.selectedTab).toBe("Demos");
    expect(first?.components.navigationTitle).toBe("Demos");
  });

  test("uses selected role-based tab items even when class is generic", () => {
    const identity = deriveIosScreenIdentity(
      hierarchy([
        navigationBar("Home"),
        node({ class: "UITabBar", text: "Tab Bar" }, [
          node({ class: "UIView", role: "tab", text: "Inbox" }),
          node({ class: "UIView", role: "tab", text: "Search", selected: "true" }),
        ]),
      ]),
    );

    expect(identity?.components.navigationTitle).toBe("Home");
    expect(identity?.components.selectedTab).toBe("Search");
    expect(JSON.parse(identity!.key)).toEqual([
      ["bundle", "com.apple.reminders"],
      ["nav", "Home"],
      ["tab", "Search"],
    ]);
  });

  test("ignores selected non-tab buttons before the selected tab bar item", () => {
    const screen = (selectedTab: string): ViewHierarchyResult =>
      hierarchy([
        navigationBar("Home"),
        node({ class: "UIView", text: "Filters" }, [
          node({ class: "UIButton", text: "Pinned", selected: "true" }),
        ]),
        node({ class: "UITabBar", text: "Tab Bar" }, [
          node({
            class: "UIButton",
            text: "Inbox",
            selected: selectedTab === "Inbox" ? "true" : "false",
          }),
          node({
            class: "UIButton",
            text: "Search",
            selected: selectedTab === "Search" ? "true" : "false",
          }),
        ]),
      ]);

    const inbox = deriveIosScreenIdentity(screen("Inbox"));
    const search = deriveIosScreenIdentity(screen("Search"));

    expect(inbox?.components.selectedTab).toBe("Inbox");
    expect(search?.components.selectedTab).toBe("Search");
    expect(inbox?.key).not.toBe(search?.key);
  });

  test("encodes key components without delimiter collisions", () => {
    const titledAndTabbed = deriveIosScreenIdentity(
      hierarchy([
        navigationBar("Foo"),
        node({ class: "UITabBar", text: "Tab Bar" }, [
          node({ class: "UIButton", text: "Bar", selected: "true" }),
        ]),
      ]),
    );
    const delimiterTitle = deriveIosScreenIdentity(hierarchy([navigationBar("Foo|tab=Bar")]));

    expect(titledAndTabbed?.key).not.toBe(delimiterTitle?.key);
    expect(JSON.parse(titledAndTabbed!.key)).toEqual([
      ["bundle", "com.apple.reminders"],
      ["nav", "Foo"],
      ["tab", "Bar"],
    ]);
  });

  test("handles raw XCTest root nodes with direct attrs and child arrays", () => {
    const identity = deriveIosScreenIdentity({
      packageName: "com.apple.reminders",
      screenScale: 3,
      hierarchy: {
        class: "XCUIElementTypeApplication",
        "view-id": "root",
        node: [
          {
            class: "XCUIElementTypeNavigationBar",
            node: [{ class: "XCUIElementTypeStaticText", text: "Reminders", "view-id": "title" }],
          },
          {
            class: "XCUIElementTypeButton",
            text: "New Reminder",
            clickable: "true",
          },
        ],
      } as any,
    });

    expect(identity?.components.bundleId).toBe("com.apple.reminders");
    expect(identity?.components.navigationTitle).toBe("Reminders");
    expect(identity?.key).toBe(
      JSON.stringify([
        ["bundle", "com.apple.reminders"],
        ["nav", "Reminders"],
      ]),
    );
  });

  test("omits identity when no useful signal is available", () => {
    expect(
      deriveIosScreenIdentity(
        hierarchy([node({ class: "XCUIApplication" }), node({ class: "UIView" })]),
      ),
    ).toBeUndefined();
  });
});

/**
 * PARAM-4: confidence-tier table.
 *
 * `confidence()` (IosScreenIdentity.ts:236) tiers signals:
 *   - high   ← modalClass OR navigationTitle present
 *   - medium ← selectedTab OR focusedElementId OR keyboardVisible present
 *   - low    ← a useful signal present but none of the above
 * and `deriveIosScreenIdentity` returns undefined entirely when NO useful
 * signal is present.
 *
 * The selected-tab fixtures use `class: "XCUIElementTypeButton", role: "tab"` —
 * `findSelectedTab` (IosScreenIdentity.ts:154-159) recognizes a selected tab by
 * `role === "tab"` (or a tab-bar-child button class). `XCUIElementTypeTabBarButton`
 * is NOT one of those classes, so a fixture built on it would silently yield no
 * `selectedTab` and make the row vacuous.
 *
 * The "low" tier is intentionally omitted: it is unreachable through the public
 * deriver, since the only useful-but-non-high/medium signal is `modalTitle`, and
 * `findModal` never emits `modalTitle` without also emitting `modalClass` (which
 * forces "high"). Fabricating a "low" fixture would misrepresent real input.
 */
describe("deriveIosScreenIdentity confidence tiers (PARAM-4)", () => {
  function selectedTabBar(selected: string): ViewHierarchyNode {
    return node({ class: "UITabBar", text: "Tab Bar" }, [
      node({ class: "XCUIElementTypeButton", role: "tab", text: selected, selected: "true" }),
    ]);
  }

  function focusedField(): ViewHierarchyNode {
    return node({
      class: "UITextField",
      text: "Title",
      "resource-id": "quick-entry-field",
      focused: "true",
    });
  }

  function keyboard(): ViewHierarchyNode {
    return node({ class: "UIKeyboard" }, [
      node({ class: "UIKeyboardKey", text: "Q", clickable: "true" }),
    ]);
  }

  function actionSheet(): ViewHierarchyNode {
    return node({ class: "UIActionSheet" }, [
      node({ class: "UIButton", text: "Discard Changes", clickable: "true" }),
    ]);
  }

  const rows: Array<{
    name: string;
    children: ViewHierarchyNode[];
    expected: "high" | "medium" | undefined;
  }> = [
    { name: "a navigation title alone", children: [navigationBar("Home")], expected: "high" },
    { name: "a modal class alone", children: [actionSheet()], expected: "high" },
    {
      name: "a navigation title plus a selected tab (prefers high over medium)",
      children: [navigationBar("Home"), selectedTabBar("Search")],
      expected: "high",
    },
    { name: "only a selected tab", children: [selectedTabBar("Search")], expected: "medium" },
    { name: "only a focused element", children: [focusedField()], expected: "medium" },
    { name: "only a visible keyboard", children: [keyboard()], expected: "medium" },
    {
      name: "no useful signal",
      children: [node({ class: "XCUIApplication" }), node({ class: "UIView", text: "hello" })],
      expected: undefined,
    },
  ];

  for (const { name, children, expected } of rows) {
    test(`tiers ${name} as ${expected ?? "no identity"}`, () => {
      const identity = deriveIosScreenIdentity(hierarchy(children));
      if (expected === undefined) {
        expect(identity).toBeUndefined();
      } else {
        expect(identity?.confidence).toBe(expected);
      }
    });
  }
});
