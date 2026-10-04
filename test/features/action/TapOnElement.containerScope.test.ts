import { describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ElementContainerSelector } from "../../../src/models/PinchOnOptions";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import fixture from "../../fixtures/observe/ctrlproxy-notification-group-compact-bounds.json";

// Real CtrlProxy capture (see systemTray.test.ts). No Settings text_frame capture
// exists in-tree. Fake only tap affordances on the captured long-clickable rows;
// keep their captured title labels, containers, bounds and ancestry unchanged.
class ClickableRowProjection extends SearchableHierarchy {
  override project(capture: ViewHierarchyResult) {
    return super
      .project(capture)
      .map((node) =>
        node.nativeId === "com.android.systemui:id/expandableNotificationRow"
          ? { ...node, affordances: ["tap", "long-press"] as typeof node.affordances }
          : node,
      );
  }
}

const capture = { hierarchy: { node: fixture.expanded } } as ViewHierarchyResult;
const projection = new ClickableRowProjection();
const nodes = projection.project(capture);
const snapshot = { id: "captured-notification-rows", nodes };
const resolver = new ElementResolver();
const title = nodes.find((node) => node.nativeId === "android:id/title" && node.label === "Rev3")!;
const inner: ElementContainerSelector = {
  elementId: "android:id/notification_headerless_view_column",
  index: 0,
};
const nested: ElementContainerSelector = {
  ...inner,
  container: { elementId: "com.android.systemui:id/notification_children_container" },
};
const tap = new TapOnElement(
  { name: "Captured hierarchy", platform: "android", deviceId: "fixture-only" },
  new FakeAdbExecutor(),
  {
    timer: new FakeTimer(),
    elementSelector: new ResolverElementSelector(resolver, projection),
  },
);

describe("tapOn captured container scope (#8986)", () => {
  for (const [chain, container] of [
    ["one-level", inner],
    ["nested", nested],
  ] as const) {
    for (const selectionStrategy of ["first", "unique"] as const) {
      for (const action of ["tap", "longPress"] as const) {
        test(`${action} ${selectionStrategy} ${chain} keeps an inert title inside its scope`, () => {
          const result = tap.findElementInHierarchy(
            { action, elementId: "android:id/title", selectionStrategy, container },
            capture,
          );
          expect(result.containerFound).toBe(true);
          expect(result.selection.totalMatches).toBe(1);
          expect(result.selection.element?.text).toBe("Rev3");
          expect(result.selection.element?.bounds).toEqual(title.bounds);
          expect(result.selection.matchedElement?.text).toBe("Rev3");
          const textResult = tap.findElementInHierarchy(
            { action, text: "Rev3", selectionStrategy, container },
            capture,
          );
          expect(textResult.selection.element?.bounds).toEqual(title.bounds);
          expect(textResult.selection.totalMatches).toBe(1);
        });

        test(`${action} ${selectionStrategy} ${chain} never searches outside a true miss`, () => {
          const options = { action, text: "Rev2", selectionStrategy, container };
          if (selectionStrategy === "unique") {
            expect(() => tap.findElementInHierarchy(options, capture)).toThrow(
              "Target not found within container",
            );
          } else {
            const result = tap.findElementInHierarchy(options, capture);
            expect(result.selection.element).toBeNull();
            expect(result.selection.totalMatches).toBe(0);
          }
        });
      }
    }
  }

  test.each(["tap", "long-press"] as const)(
    "%s unique keeps distinct captured titles ambiguous",
    (action) => {
      const result = resolver.resolve(
        snapshot,
        {
          elementId: "android:id/title",
          selectionStrategy: "unique",
          container: { elementId: "com.android.systemui:id/notification_children_container" },
        },
        { action },
      );
      expect(result.chosen).toBeNull();
      expect(result.error).toContain("Target ambiguous: 3 matches");
    },
  );

  for (const action of ["tap", "long-press"] as const) {
    for (const selector of [
      { elementId: "column", match: "contains" as const },
      { text: "Rev3|1 hour ago", match: "regex" as const },
    ]) {
      test(`${action} unique counts ${JSON.stringify(selector)} matches sharing an owner`, () => {
        // Fake a common owner inside scope without changing captured parser input.
        const sharedOwnerNodes = nodes.map((node) =>
          node.nativeId === "android:id/notification_headerless_view_column"
            ? { ...node, affordances: ["tap", "long-press"] as typeof node.affordances }
            : node,
        );
        const result = resolver.resolve(
          { ...snapshot, nodes: sharedOwnerNodes },
          {
            ...selector,
            selectionStrategy: "unique",
            container: {
              elementId: "android:id/notification_headerless_view_row",
              index: 0,
            },
          },
          { action },
        );
        expect(result.chosen).toBeNull();
        expect(result.error).toContain("Target ambiguous: 2 matches");
      });
    }
  }

  test.each(["tap", "long-press"] as const)(
    "%s promotes to the nearest captured owner including the scope itself",
    (action) => {
      const result = resolver.resolve(
        snapshot,
        {
          elementId: "android:id/title",
          selectionStrategy: "unique",
          container: {
            elementId: "com.android.systemui:id/expandableNotificationRow",
            index: 0,
            container: { elementId: "com.android.systemui:id/notification_children_container" },
          },
        },
        { action },
      );
      expect(result.error).toBeUndefined();
      expect(result.chosen).toBe(result.scope!);
      expect(result.scope?.nativeId).toBe("com.android.systemui:id/expandableNotificationRow");
      expect(result.matches[0].node).toBe(title);
    },
  );

  test.each(["first", "unique"] as const)(
    "focus-input %s cannot turn the captured non-editable title into a tap",
    (selectionStrategy) => {
      const result = resolver.resolve(
        snapshot,
        { elementId: "android:id/title", selectionStrategy, container: nested },
        { action: "focus-input" },
      );
      expect(result.chosen).toBeNull();
      expect(result.candidates).toHaveLength(0);
    },
  );
});

test.each(["tap", "focus"] as const)(
  "tapOn %s explicitly opts its text field target into hint fallback",
  (action) => {
    const resolve = spyOn(resolver, "resolve");
    const fieldCapture: ViewHierarchyResult = {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          class: "android.widget.EditText",
          "resource-id": "phone",
          text: "5551234",
          "hint-text": "Phone",
          clickable: true,
          focusable: true,
        },
      },
    };
    try {
      for (const selector of [{ text: "Phone" }, { textAny: ["Missing", "Phone"] }]) {
        const selected = tap.findElementInHierarchy({ action, ...selector }, fieldCapture);
        expect(selected.selection.element?.["resource-id"]).toBe("phone");
      }
      expect(
        resolve.mock.calls
          .filter(([, selector]) => selector.text === "Phone")
          .every(([, , intent]) => intent.allowHintFallback === true),
      ).toBe(true);
    } finally {
      resolve.mockRestore();
    }
  },
);

test("tapOn long press and sibling anchors do not opt into hint fallback", () => {
  const resolve = spyOn(resolver, "resolve");
  try {
    tap.findElementInHierarchy({ action: "longPress", text: "Rev3" }, capture);
    tap.findElementInHierarchy({ action: "tap", text: "Rev3", sibling: true }, capture);
    expect(resolve.mock.calls.length).toBeGreaterThan(0);
    expect(resolve.mock.calls.every(([, , intent]) => intent.allowHintFallback !== true)).toBe(
      true,
    );
  } finally {
    resolve.mockRestore();
  }
});
