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
import typedCapture from "../../fixtures/ios-safari-url-field/runner-typed-keyboard-up.json";
import { observationFromRunnerCapture } from "../../helpers/iosRunnerCapture";
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
  let settledTarget: Element;
  let editingTarget: Element;
  let compactWithKeyboard: ObserveResult;
  let offscreenKeyboard: ObserveResult;
  let overlappingEditor: ObserveResult;
  let settled: ObserveResult;
  let noKeyboard: ObserveResult;
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

    // The settled frame is a real runner capture (round 4 of #15175): the URL editor sits above
    // the on-screen keyboard. Clone it only during setup; each timed test just verifies a capture.
    const settledHierarchy = observationFromRunnerCapture(typedCapture).viewHierarchy!;
    function variant(
      change: (
        hierarchy: ViewHierarchyResult,
        source: NonNullable<ViewHierarchyResult["hierarchy"]["node"]>,
      ) => void,
    ): ObserveResult {
      const hierarchy = structuredClone(settledHierarchy);
      const url = projection
        .project(hierarchy)
        .find((node) => node.className === "UITextField" && node.nativeId === "URL");
      if (!url) {
        throw new Error("Captured settled URL field missing");
      }
      change(hierarchy, url.source);
      return observation(hierarchy);
    }

    settled = variant(() => {});
    const url = projection
      .project(settled.viewHierarchy!)
      .find((node) => node.nativeId === "URL")?.element;
    if (!url) {
      throw new Error("Settled URL missing");
    }
    settledTarget = url;
    const editingUrl = projection
      .project(editing.viewHierarchy!)
      .find((node) => node.nativeId === "URL")?.element;
    const capturedKeyboard = projection
      .project(editing.viewHierarchy!)
      .find((node) => node.className === "UIKeyboard");
    if (!editingUrl || !capturedKeyboard) {
      throw new Error("Captured editing URL or keyboard missing");
    }
    editingTarget = editingUrl;
    const settledKeyboard = projection
      .project(settledHierarchy)
      .find((node) => node.className === "UIKeyboard");
    if (!settledKeyboard) {
      throw new Error("Captured settled keyboard missing");
    }
    const compactWithKeyboardHierarchy = structuredClone(compactHierarchy);
    const keyboard = structuredClone(settledKeyboard.source);
    const compactContainer = projection
      .project(compactWithKeyboardHierarchy)
      .find((node) => Array.isArray(node.source.node));
    if (!compactContainer?.source.node) {
      throw new Error("Captured compact container missing");
    }
    compactContainer.source.node.push(keyboard);
    compactWithKeyboard = observation(compactWithKeyboardHierarchy);
    offscreenKeyboard = variant((hierarchy) => {
      const keyboardNode = projection
        .project(hierarchy)
        .find((node) => node.className === "UIKeyboard");
      if (!keyboardNode) {
        throw new Error("Settled keyboard missing");
      }
      // Restore the captured off-screen preview bounds, retaining the settled editor.
      delete keyboardNode.source.bounds;
      nodeAttributes(keyboardNode.source).bounds = structuredClone(
        nodeAttributes(capturedKeyboard.source).bounds,
      );
    });
    overlappingEditor = variant((_hierarchy, source) => {
      // The captured mid-animation URL frame overlaps the settled keyboard.
      source.bounds = { ...editingTarget.bounds };
    });
    noKeyboard = variant((hierarchy) => {
      const keyboard = projection
        .project(hierarchy)
        .find((node) => node.className === "UIKeyboard");
      const root = hierarchy.hierarchy.node;
      if (!root?.node || !keyboard) {
        throw new Error("Captured keyboard root missing");
      }
      root.node = root.node.filter((node) => node !== keyboard.source);
    });

    equalBounds = variant((_hierarchy, source) => {
      source.bounds = { ...target.bounds };
    });
    shrunkBounds = variant((_hierarchy, source) => {
      source.bounds = { ...target.bounds, left: target.bounds.left + 10 };
    });
    // Negative ambiguity probes promote the captured web input into native scope;
    // reuse its existing identity rather than inventing another field or id.
    function promoteWebInput(hierarchy: ViewHierarchyResult) {
      const nodes = projection.project(hierarchy);
      const web = nodes.find(
        (node) => node.className === "UITextField" && node.element?.text === "Google Search",
      );
      if (!web || web.parentIndex === undefined) {
        throw new Error("Captured web input missing");
      }
      const parent = nodes[web.parentIndex].source;
      parent.node = parent.node?.filter((node) => node !== web.source);
      hierarchy.hierarchy.node?.node?.push(web.source);
      return web.source;
    }
    secondNativeField = variant((hierarchy) => {
      delete nodeAttributes(promoteWebInput(hierarchy)).focused;
    });
    conflictingLabel = variant((_hierarchy, source) => {
      nodeAttributes(source).text = "Google Search";
    });
    otherNativeFocused = variant((hierarchy) => {
      promoteWebInput(hierarchy);
    });
  });

  test("confirms compact target with the settled keyboard-up editor", () => {
    expect(verifier().verify(options, target, settled)).toBe(true);
  });

  test.each([options, { elementId: "URL", action: "focus" } as const])(
    "confirms re-targeted settled native editor with %j",
    (selector) => {
      expect(verifier().verify(selector, settledTarget, settled, "Address")).toBe(true);
    },
  );

  test("rejects unchanged compact target with an appended on-screen keyboard", () => {
    expect(verifier().verify(options, target, compactWithKeyboard)).toBe(false);
  });

  test("rejects re-targeted captured URL with an off-screen preview keyboard", () => {
    expect(verifier().verify(options, editingTarget, editing, "Address")).toBe(false);
  });

  test("rejects settled editor with the keyboard moved off-screen", () => {
    expect(verifier().verify(options, target, offscreenKeyboard)).toBe(false);
    expect(verifier().verify(options, settledTarget, offscreenKeyboard, "Address")).toBe(false);
  });

  test("rejects native editor overlapping the settled keyboard", () => {
    expect(verifier().verify(options, editingTarget, overlappingEditor, "Address")).toBe(false);
  });

  test("rejects settled editor without a keyboard", () => {
    expect(verifier().verify(options, target, noKeyboard)).toBe(false);
    expect(verifier().verify(options, settledTarget, noKeyboard, "Address")).toBe(false);
  });

  test("rejects settled editor on Android", () => {
    expect(verifier("android").verify(options, target, settled)).toBe(false);
    expect(verifier("android").verify(options, settledTarget, settled, "Address")).toBe(false);
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
