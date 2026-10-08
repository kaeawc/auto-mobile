import { describe, expect, test } from "bun:test";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ViewHierarchyResult } from "../../../src/models";
import capturedRecents from "../../fixtures/android-launcher/launcher-recents-emulator-5600.json";
import capturedHome from "../../fixtures/android-launcher/launcher-home-emulator-5600.json";
import { hideCapturedNode } from "../../helpers/hideCapturedNode";

const launcher = "com.google.android.apps.nexuslauncher";
const recents: ViewHierarchyResult = capturedRecents.viewHierarchy;
const home: ViewHierarchyResult = capturedHome.viewHierarchy;

describe("ResolverElementSelector.resolveContainerMatch", () => {
  const selector = new ResolverElementSelector();

  test.each([
    { name: "visible overview panel", capture: recents, id: "overview_panel", visible: true },
    // Captured as visible-to-user false by CtrlProxy on the Recents overview.
    { name: "hidden show_windows button", capture: recents, id: "show_windows", visible: false },
    { name: "visible home workspace", capture: home, id: "workspace", visible: true },
  ])("reports the captured flag for the $name", ({ capture, id, visible }) => {
    const container = { elementId: `${launcher}:id/${id}` };
    const match = selector.resolveContainerMatch(capture, container);

    expect(match?.visibleToUser).toBe(visible);
    expect(match?.element?.["resource-id"]).toBe(container.elementId);
  });

  test("keeps a hidden container matchable and flags it hidden", () => {
    const container = { elementId: `${launcher}:id/workspace` };
    const hidden = hideCapturedNode(home, container.elementId);

    expect(selector.hasContainer(hidden, container)).toBe(true);
    expect(selector.resolveContainerMatch(hidden, container)?.visibleToUser).toBe(false);
  });

  test("resolves nothing for a container the capture lacks", () => {
    const container = { elementId: `${launcher}:id/workspace` };

    expect(selector.resolveContainerMatch(recents, container)).toBeUndefined();
    expect(selector.hasContainer(recents, container)).toBe(false);
  });

  test("resolveContainer still returns the same element", () => {
    const container = { elementId: `${launcher}:id/overview_panel` };

    expect(selector.resolveContainer(recents, container)).toBe(
      selector.resolveContainerMatch(recents, container)?.element,
    );
  });
});
