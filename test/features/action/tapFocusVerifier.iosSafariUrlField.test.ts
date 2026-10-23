import { beforeAll, describe, expect, test } from "bun:test";
import { FocusVerifier } from "../../../src/features/action/tapFocusVerifier";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import compactCapture from "../../fixtures/ios-safari-url-field/hierarchy-compact.json";
import editingCapture from "../../fixtures/ios-safari-url-field/hierarchy-editing.json";
import { buildObserveResult, viewHierarchyFromFixture } from "../../helpers/observeFixture";

function verifier(platform: BootedDevice["platform"] = "ios"): FocusVerifier {
  return new FocusVerifier({
    device: { platform, deviceId: "fixture", name: "fixture" } as BootedDevice,
    findElementInHierarchy: () => {
      throw new Error("scope unresolved");
    },
    withObservationScreenSize: (options) => options,
  });
}

function observation(viewHierarchy: ViewHierarchyResult): ObserveResult {
  return buildObserveResult({
    viewHierarchy,
    updatedAt: 0,
    screenSize: { width: 402, height: 874 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  });
}

describe("FocusVerifier Safari expanded URL field", () => {
  const options = { text: "Address", action: "focus" } as const;
  let target: Element;
  let compact: ObserveResult;
  let editing: ObserveResult;
  let equalBounds: ObserveResult;
  let shrunkBounds: ObserveResult;
  let secondNativeField: ObserveResult;
  let conflictingLabel: ObserveResult;
  let otherNativeFocused: ObserveResult;

  beforeAll(() => {
    const projection = new SearchableHierarchy();
    const compactHierarchy = viewHierarchyFromFixture(compactCapture);
    const compactTarget = projection
      .project(compactHierarchy)
      .find(
        (node) => node.className === "UITextField" && node.element?.text === "Address",
      )?.element;
    if (!compactTarget) {
      throw new Error("Captured compact Address field missing");
    }
    target = compactTarget;
    compact = observation(compactHierarchy);
    editing = observation(viewHierarchyFromFixture(editingCapture));

    // Clone captures only during setup; each timed test just projects and verifies its capture.
    function variant(
      change: (
        hierarchy: ViewHierarchyResult,
        source: NonNullable<ViewHierarchyResult["hierarchy"]["node"]>,
      ) => void,
    ): ObserveResult {
      const hierarchy = structuredClone(viewHierarchyFromFixture(editingCapture));
      const url = projection
        .project(hierarchy)
        .find((node) => node.className === "UITextField" && node.nativeId === "URL");
      if (!url) {
        throw new Error("Captured editing URL field missing");
      }
      change(hierarchy, url.source);
      return observation(hierarchy);
    }

    equalBounds = variant((_hierarchy, source) => {
      source.bounds = { ...target.bounds };
    });
    shrunkBounds = variant((_hierarchy, source) => {
      source.bounds = { ...target.bounds, left: target.bounds.left + 10 };
    });
    secondNativeField = variant((hierarchy, source) => {
      const other = structuredClone(source);
      nodeAttributes(other)["resource-id"] = "other-url";
      nodeAttributes(other)["view-id"] = "other-url";
      other.bounds = { left: 10, top: 100, right: 300, bottom: 148 };
      hierarchy.hierarchy.node?.node?.push(other);
    });
    conflictingLabel = variant((_hierarchy, source) => {
      nodeAttributes(source).text = "Different field";
    });
    otherNativeFocused = variant((hierarchy, source) => {
      const other = structuredClone(source);
      Object.assign(nodeAttributes(other), {
        class: "UITextView",
        "resource-id": "other-input",
        "view-id": "other-input",
        focused: "true",
      });
      other.bounds = { left: 10, top: 100, right: 300, bottom: 148 };
      hierarchy.hierarchy.node?.node?.push(other);
    });
  });

  test("confirms the captured compact target in the expanded editing capture", () => {
    expect(verifier().verify(options, target, editing)).toBe(true);
  });

  test("rejects the unchanged compact capture after a tap that did not focus", () => {
    expect(verifier().verify(options, target, compact)).toBe(false);
  });

  test("rejects editing bounds equal to or smaller than the compact target", () => {
    expect(verifier().verify(options, target, equalBounds)).toBe(false);
    expect(verifier().verify(options, target, shrunkBounds)).toBe(false);
  });

  test("rejects a second native editable field elsewhere on screen", () => {
    expect(verifier().verify(options, target, secondNativeField)).toBe(false);
  });

  test("rejects a conflicting non-empty URL field label", () => {
    expect(verifier().verify(options, target, conflictingLabel)).toBe(false);
  });

  test("rejects another keyboard-focused native editable field outside WKWebView", () => {
    expect(verifier().verify(options, target, otherNativeFocused)).toBe(false);
  });

  test("does not accept the expanded editing capture on Android", () => {
    expect(verifier("android").verify(options, target, editing)).toBe(false);
  });
});
