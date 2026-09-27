import { afterEach, expect, test } from "bun:test";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { attachRawViewHierarchy } from "../../../src/utils/viewHierarchySearch";
import { serverConfig } from "../../../src/utils/ServerConfig";

afterEach(() => serverConfig.setRawElementSearchEnabled(false));
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
          { bounds, clickable: true, text: "Email" },
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
