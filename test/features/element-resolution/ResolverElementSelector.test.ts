import { afterEach, expect, test } from "bun:test";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { attachRawViewHierarchy } from "../../../src/features/utility/viewHierarchySearch";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { iosFormsSwitch } from "../../fixtures/observe/ios-forms-switch";

afterEach(() => serverConfig.setRawElementSearchEnabled(false));

test("a checkable SwiftUI Toggle ranks its smaller control ahead of the labelled row", () => {
  const capture = iosFormsSwitch("true");
  const row = capture.hierarchy.node;
  if (!row || Array.isArray(row)) {
    throw new Error("Expected the iOS application node");
  }
  const toggleRow = row.node?.[0];
  if (!toggleRow) {
    throw new Error("Expected the toggle row");
  }
  toggleRow.$!.class = "SwiftUIToggle";
  toggleRow.node![0].$!.class = "SwiftUIToggle";

  const selected = new ResolverElementSelector().selectByText(capture, "Enable Notifications");
  expect(selected.element?.bounds).toEqual({ left: 301, top: 296, right: 364, bottom: 324 });
});
const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
const hierarchy = {
  hierarchy: {
    node: [
      { bounds, clickable: true, text: "Login help", "resource-id": "app:id/login_help" },
      { bounds, clickable: true, text: "Login", "resource-id": "app:id/login" },
    ],
  },
};

test("action adapter defaults to namespace IDs and exact-first text", () => {
  const selector = new ResolverElementSelector();
  expect(selector.selectByResourceId(hierarchy, "login").element?.["resource-id"]).toBe(
    "app:id/login",
  );
  expect(selector.selectByText(hierarchy, "Login").element?.["resource-id"]).toBe("app:id/login");
});

test("fuzzy sibling selection keeps partial label anchors", () => {
  const capture = {
    hierarchy: {
      node: {
        node: [
          { bounds, text: "Email address" },
          { bounds, clickable: true, text: "Email primary" },
          { bounds, clickable: true, text: "Email backup" },
        ],
      },
    },
  };
  const result = new ResolverElementSelector().selectClickableSiblingOfText(capture, "Email", {
    fuzzyMatch: true,
    index: 1,
  });
  expect(result.element?.text).toBe("Email backup");
});

test("raw element search uses attached raw nodes even with an actionable snapshot", () => {
  const raw = {
    hierarchy: { node: { bounds, clickable: true, text: "Hidden target" } },
  };
  const filtered = { hierarchy: { node: { bounds, clickable: true, text: "Visible target" } } };
  identifyObservedHierarchy("android", filtered, "cached-ok");
  attachRawViewHierarchy(filtered, raw);
  serverConfig.setRawElementSearchEnabled(true);
  expect(new ResolverElementSelector().selectByText(filtered, "Hidden target").element?.text).toBe(
    "Hidden target",
  );
});

test("iOS observed selectors cannot reopen an attached offscreen raw tree", () => {
  const visible = {
    screenWidth: 100,
    screenHeight: 100,
    hierarchy: {
      node: { bounds, clickable: true, text: "Visible", "resource-id": "visible" },
    },
  };
  const raw = {
    hierarchy: {
      node: { bounds: [0, 500, 20, 520], clickable: true, text: "Hidden", "resource-id": "hidden" },
    },
  };
  identifyObservedHierarchy("ios", visible, "cached-ok");
  attachRawViewHierarchy(visible, raw);
  serverConfig.setRawElementSearchEnabled(true);
  const selector = new ResolverElementSelector();
  expect(selector.selectByText(visible, "Visible").element?.["resource-id"]).toBe("visible");
  expect(selector.selectByText(visible, "Hidden").element).toBeNull();
  expect(selector.hasContainer(visible, { elementId: "hidden" })).toBe(false);
});

test("adapter fails ambiguity before returning any action target", () => {
  const capture = {
    hierarchy: {
      node: [
        { bounds, clickable: true, "resource-id": "one:id/map" },
        { bounds, clickable: true, "resource-id": "two:id/map" },
      ],
    },
  };
  expect(() => new ResolverElementSelector().selectByResourceId(capture, "map")).toThrow(
    "Ambiguous",
  );
});

test("tapAny only indexes action-eligible nodes across windows", () => {
  const capture = {
    hierarchy: {
      node: [
        { bounds, text: "Not a button" },
        { bounds, clickable: true, "resource-id": "main" },
      ],
    },
    windows: [
      {
        windowLayer: 10,
        hierarchy: { node: { bounds, clickable: true, "resource-id": "dialog" } },
      },
    ],
  };
  const result = new ResolverElementSelector().selectClickable(capture, { strategy: "first" });
  expect(result.element?.["resource-id"]).toBe("dialog");
  expect(result.totalMatches).toBe(2);
});

test("action adapter skips offscreen duplicate targets", () => {
  const capture = {
    screenWidth: 200,
    screenHeight: 200,
    hierarchy: {
      node: [
        { clickable: true, text: "Done", bounds: { left: -300, top: 0, right: -200, bottom: 50 } },
        { clickable: true, text: "Done", bounds: { left: 20, top: 20, right: 120, bottom: 70 } },
      ],
    },
  };
  expect(new ResolverElementSelector().selectByText(capture, "Done").element?.bounds?.left).toBe(
    20,
  );
});

test("missing container remains retryable but synthetic container keys are recognized", () => {
  const selector = new ResolverElementSelector();
  expect(
    selector.selectByText(hierarchy, "Login", { container: { elementId: "missing" } }).element,
  ).toBeNull();
  const capture = {
    hierarchy: {
      node: { "view-id": "s-container", bounds, node: { text: "Login", bounds, clickable: true } },
    },
  };
  expect(selector.hasContainer(capture, { elementId: "s-container" })).toBe(true);
  expect(
    selector.selectByText(capture, "Login", { container: { elementId: "s-container" } }).element
      ?.text,
  ).toBe("Login");
});

test("tapAny scrollable scope selects clickable rows instead of the scrolling list", () => {
  const capture = {
    hierarchy: {
      node: [
        { bounds, clickable: true, "resource-id": "outside" },
        {
          bounds,
          scrollable: true,
          "resource-id": "list",
          node: [{ bounds, clickable: true, "resource-id": "row" }],
        },
      ],
    },
  };
  const selector = new ResolverElementSelector();
  expect(
    selector.selectClickable(capture, { scrollableContainer: true }).element?.["resource-id"],
  ).toBe("row");
  expect(
    selector.selectClickable(capture, {
      scrollableContainer: true,
      container: { elementId: "outside" },
    }).element,
  ).toBeNull();
});

test("long press falls back to ordinary clickable targets for tapOn and tapAny", () => {
  const selector = new ResolverElementSelector();
  expect(
    selector.selectByText(hierarchy, "Login", { intentAction: "long-press" }).element?.[
      "resource-id"
    ],
  ).toBe("app:id/login");
  expect(
    selector.selectClickable(hierarchy, { intentAction: "long-press", index: 0 }).element?.[
      "resource-id"
    ],
  ).toBe("app:id/login_help");
});

test("long-press candidate set includes an ordinary clickable control alongside a long-clickable one (#7707)", async () => {
  const { ElementResolver } = await import("../../../src/features/utility/ElementResolver");
  const capture = {
    hierarchy: {
      node: [
        { bounds, clickable: true, "resource-id": "A" },
        { bounds, clickable: true, longClickable: true, "resource-id": "B" },
      ],
    },
  };
  const first = new ResolverElementSelector(new ElementResolver(() => 0)).selectClickable(capture, {
    intentAction: "long-press",
    strategy: "first",
  });
  expect(first.totalMatches).toBe(2);
  expect(first.element?.["resource-id"]).toBe("A");
  const randomFirst = new ResolverElementSelector(new ElementResolver(() => 0)).selectClickable(
    capture,
    { intentAction: "long-press", strategy: "random" },
  );
  const randomLast = new ResolverElementSelector(new ElementResolver(() => 0.99)).selectClickable(
    capture,
    { intentAction: "long-press", strategy: "random" },
  );
  expect(randomFirst.totalMatches).toBe(2);
  expect(randomFirst.element?.["resource-id"]).toBe("A");
  expect(randomLast.totalMatches).toBe(2);
  expect(randomLast.element?.["resource-id"]).toBe("B");
});

test("indexed and random selection count only onscreen action candidates", async () => {
  const { ElementResolver } = await import("../../../src/features/utility/ElementResolver");
  const capture = {
    screenWidth: 200,
    screenHeight: 200,
    hierarchy: {
      node: [
        { clickable: true, text: "Done", bounds: { left: -300, top: 0, right: -200, bottom: 50 } },
        { clickable: true, text: "Done", bounds: { left: 20, top: 20, right: 120, bottom: 70 } },
      ],
    },
  };
  const selector = new ResolverElementSelector(new ElementResolver(() => 0));
  const first = selector.selectByText(capture, "Done", { index: 0 });
  expect(first.element?.bounds?.left).toBe(20);
  expect(first.totalMatches).toBe(1);
  expect(selector.selectByText(capture, "Done", { index: 1 }).element).toBeNull();
  expect(selector.selectByText(capture, "Done", { strategy: "random" }).element?.bounds?.left).toBe(
    20,
  );
});

test("tap lookup preserves a bounded inert label inside a scroll container", () => {
  const labelBounds = { left: 20, top: 40, right: 130, bottom: 70 };
  const capture = {
    hierarchy: {
      node: {
        scrollable: true,
        bounds: { left: 0, top: 0, right: 300, bottom: 500 },
        node: { text: "Details", bounds: labelBounds },
      },
    },
  };
  expect(
    new ResolverElementSelector().selectByText(capture, "Details", {
      intentAction: "inspect",
      selectionIntent: "tap",
    }).element?.bounds,
  ).toEqual(labelBounds);
});

test("tap intent ranks a clickable text peer ahead of a smaller input", () => {
  const capture = {
    hierarchy: {
      node: [
        {
          class: "android.widget.EditText",
          text: "Login",
          bounds: { left: 0, top: 0, right: 80, bottom: 30 },
        },
        {
          clickable: true,
          text: "Login",
          bounds: { left: 0, top: 40, right: 200, bottom: 100 },
        },
      ],
    },
  };
  expect(
    new ResolverElementSelector().selectByText(capture, "Login", {
      intentAction: "inspect",
      selectionIntent: "tap",
    }).element?.bounds?.top,
  ).toBe(40);
});

test("focus promotes a Compose label child to its editable ancestor (#7759)", () => {
  const inputBounds = { left: 84, top: 1115, right: 996, bottom: 1262 };
  const labelBounds = { left: 126, top: 1157, right: 461, bottom: 1220 };
  const capture = {
    hierarchy: {
      bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      node: {
        class: "android.widget.EditText",
        bounds: inputBounds,
        node: [{ class: "android.widget.TextView", text: "Basic Text Field", bounds: labelBounds }],
      },
    },
  };
  const result = new ResolverElementSelector().selectByText(capture, "Basic Text Field", {
    intentAction: "focus-input",
  });
  expect(result.element?.bounds).toEqual(inputBounds);
});

test("focus prefers an exact label's promoted field over a partial match elsewhere (PR #7780 review)", () => {
  const exactInputBounds = { left: 20, top: 100, right: 220, bottom: 160 };
  const partialInputBounds = { left: 20, top: 200, right: 320, bottom: 280 };
  const capture = {
    hierarchy: {
      bounds: { left: 0, top: 0, right: 400, bottom: 400 },
      node: {
        class: "android.widget.EditText",
        bounds: exactInputBounds,
        node: {
          class: "android.widget.TextView",
          text: "Email",
          bounds: { left: 30, top: 110, right: 100, bottom: 140 },
        },
      },
    },
    windows: [
      {
        windowLayer: 10,
        hierarchy: {
          node: {
            class: "android.widget.EditText",
            text: "Email Address",
            bounds: partialInputBounds,
          },
        },
      },
    ],
  };
  const result = new ResolverElementSelector().selectByText(capture, "Email", {
    intentAction: "focus-input",
  });
  expect(result.element?.bounds).toEqual(exactInputBounds);
});

test("focus rejects a nested label outside a distant editable ancestor (#7759)", () => {
  const outerBounds = { left: 0, top: 0, right: 200, bottom: 80 };
  const labelBounds = { left: 20, top: 200, right: 100, bottom: 230 };
  const capture = {
    hierarchy: {
      node: {
        class: "android.widget.EditText",
        bounds: outerBounds,
        node: {
          bounds: { left: 0, top: 180, right: 200, bottom: 250 },
          node: { class: "android.widget.TextView", text: "Email", bounds: labelBounds },
        },
      },
    },
  };
  const result = new ResolverElementSelector().selectByText(capture, "Email", {
    intentAction: "focus-input",
  });
  expect(result.element).toBeNull();
  expect(result.element?.bounds).not.toEqual(outerBounds);
});

test("focus rejects a label three hops below a full-screen editable ancestor (#7759)", () => {
  const outerBounds = { left: 0, top: 0, right: 1080, bottom: 2400 };
  const capture = {
    hierarchy: {
      node: {
        class: "android.widget.EditText",
        bounds: outerBounds,
        node: {
          bounds: { left: 0, top: 900, right: 1080, bottom: 1400 },
          node: {
            bounds: { left: 40, top: 1080, right: 1040, bottom: 1250 },
            node: {
              class: "android.widget.TextView",
              text: "Email",
              bounds: { left: 126, top: 1157, right: 461, bottom: 1220 },
            },
          },
        },
      },
    },
  };
  const result = new ResolverElementSelector().selectByText(capture, "Email", {
    intentAction: "focus-input",
  });
  expect(result.element).toBeNull();
  expect(result.element?.bounds).not.toEqual(outerBounds);
});

test("focus stops at an interactive ancestor before a distant editable input (#7759)", () => {
  const capture = {
    hierarchy: {
      node: {
        class: "android.widget.EditText",
        bounds: { left: 0, top: 0, right: 300, bottom: 300 },
        node: {
          clickable: true,
          bounds: { left: 0, top: 0, right: 200, bottom: 100 },
          node: { text: "Email", bounds: { left: 10, top: 10, right: 100, bottom: 40 } },
        },
      },
    },
  };
  expect(
    new ResolverElementSelector().selectByText(capture, "Email", { intentAction: "focus-input" })
      .element,
  ).toBeNull();
});

test("focus promotes an iOS text label to its text-field role ancestor (#7759)", () => {
  const inputBounds = { left: 0, top: 0, right: 200, bottom: 70 };
  const capture = {
    hierarchy: {
      node: {
        role: "textfield",
        bounds: inputBounds,
        node: [{ text: "Email", bounds: { left: 10, top: 10, right: 100, bottom: 40 } }],
      },
    },
  };
  // owner decision D43 (#6523): the screen size follows the capture platform; this fixture is an iOS capture, so say so
  expect(
    new ResolverElementSelector(undefined, undefined, { platform: "ios" }).selectByText(
      capture,
      "Email",
      { intentAction: "focus-input" },
    ).element?.bounds,
  ).toEqual(inputBounds);
});

test("focus resolves a label merged from flattened skeleton siblings (#7759)", () => {
  const inputBounds = { left: 0, top: 0, right: 200, bottom: 70 };
  const labelBounds = { left: 10, top: 10, right: 100, bottom: 40 };
  const input = { class: "android.widget.EditText", clickable: true, bounds: inputBounds };
  const label = { class: "android.widget.TextView", text: "Email", bounds: labelBounds };
  const skeleton = projectSkeleton({
    clickable: [input],
    scrollable: [],
    text: [label],
    media: [],
  }).skeleton;
  expect(skeleton.find((row) => row.affordances.includes("input"))?.label).toBe("Email");
  const capture = { hierarchy: { node: { ...input, node: [label] } } };
  expect(
    new ResolverElementSelector().selectByText(capture, "Email", { intentAction: "focus-input" })
      .element?.bounds,
  ).toEqual(inputBounds);
});

test("focus rejects a stray non-editable label beside an unrelated input (#7759)", () => {
  const capture = {
    hierarchy: {
      node: [
        { class: "android.widget.TextView", text: "Email", bounds },
        { class: "android.widget.EditText", bounds: { ...bounds, top: 120, bottom: 180 } },
      ],
    },
  };
  expect(
    new ResolverElementSelector().selectByText(capture, "Email", { intentAction: "focus-input" })
      .element,
  ).toBeNull();
});

test("indexed focus excludes an exact clickable Email before the exact input (#7708)", () => {
  const inputBounds = { left: 0, top: 120, right: 100, bottom: 180 };
  const capture = {
    hierarchy: {
      node: [
        { clickable: true, text: "Email", bounds },
        { class: "android.widget.EditText", text: "Email", bounds: inputBounds },
      ],
    },
  };
  const result = new ResolverElementSelector().selectByText(capture, "Email", {
    intentAction: "focus-input",
    index: 0,
  });
  expect(result.element?.bounds).toEqual(inputBounds);
  expect(result.totalMatches).toBe(1);
});

test("tap lookup falls back to a bounded Compose ID when exact native ID is unbounded", () => {
  const capture = {
    hierarchy: {
      node: [
        { "resource-id": "app:id/login", text: "Unbounded" },
        {
          "resource-id": "login",
          clickable: true,
          bounds: { left: 20, top: 40, right: 120, bottom: 90 },
        },
      ],
    },
  };
  expect(
    new ResolverElementSelector().selectByResourceId(capture, "app:id/login", {
      intentAction: "inspect",
    }).element?.["resource-id"],
  ).toBe("login");
});

test("selector adapter requires an explicit hint opt-in even for focus-input", () => {
  const capture = {
    hierarchy: {
      node: {
        bounds,
        class: "android.widget.EditText",
        "resource-id": "phone",
        text: "5551234",
        "hint-text": "Phone",
        focusable: true,
        clickable: true,
      },
    },
  };
  const selector = new ResolverElementSelector();
  expect(selector.selectByText(capture, "Phone").element).toBeNull();
  expect(
    selector.selectByText(capture, "Phone", { intentAction: "focus-input" }).element,
  ).toBeNull();
  expect(
    selector.selectByText(capture, "Phone", {
      intentAction: "focus-input",
      allowHintFallback: true,
    }).element?.["resource-id"],
  ).toBe("phone");
});
