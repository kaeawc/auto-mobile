import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FocusNavigate, type FocusKeyPresser } from "../../../src/features/action/FocusNavigate";
import { createFocusNavigateObserver } from "../../../src/features/action/FocusNavigateObserver";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import { textFieldToolkit } from "../../../src/features/action/textFieldToolkit";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { Element } from "../../../src/models/Element";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import {
  nodeAttributes,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
} from "../../../src/models/ViewHierarchyResult";
import { isTruthyFlag } from "../../../src/features/utility/elementProperties";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * #17488: Compose and View text fields both report `android.widget.EditText`, so the toolkit is
 * read from the field's ancestry. The Compose capture is the Playground Text screen (fields under
 * `androidx.compose.ui.platform.ComposeView`); the View capture is Settings' Add network dialog,
 * whose focused `com.android.settings:id/ssid` EditText sits under LinearLayouts.
 */
function capture(path: string): ViewHierarchyResult {
  const raw = JSON.parse(
    readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), "utf8"),
  ) as ViewHierarchyResult | { viewHierarchy: ViewHierarchyResult };
  return "viewHierarchy" in raw ? raw.viewHierarchy : raw;
}

const composeCapture = (): ViewHierarchyResult =>
  capture("android-focus/playground-text-field-post-tap.json");

/** Strip ids from every focused node, as an `EditText` declared without `android:id` reports. */
function withoutFocusedIds(node: ViewHierarchyNode): ViewHierarchyNode {
  const copy: ViewHierarchyNode = { ...node };
  if (isTruthyFlag(nodeAttributes(copy)["focused"])) {
    delete copy["resource-id"];
    delete copy["view-id"];
  }
  if (copy.node) {
    copy.node = (Array.isArray(copy.node) ? copy.node : [copy.node]).map(withoutFocusedIds);
  }
  return copy;
}

/** The Settings capture with the focused EditText id-less and no keyboard window. */
function idlessViewCapture(): ViewHierarchyResult {
  const hierarchy = capture("android-settings/add-network-security-spinner.viewHierarchy.json");
  // Captures carry the top-level nodes as an array; a classless wrapper keeps the Hierarchy type.
  const top = [hierarchy.hierarchy.node ?? []].flat();
  return {
    ...hierarchy,
    hierarchy: { ...hierarchy.hierarchy, node: withoutFocusedIds({ node: top }) },
    windows: (hierarchy.windows ?? []).filter((w) => w.type !== 2),
  };
}

class CapturedScreen implements Pick<ObserveScreen, "execute">, FocusKeyPresser {
  readonly keys: InputKeyName[] = [];
  constructor(private readonly hierarchy: ViewHierarchyResult) {}

  async execute(): Promise<ObserveResult> {
    return { viewHierarchy: this.hierarchy } as ObserveResult;
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    return { success: true };
  }
}

async function focusedIn(hierarchy: ViewHierarchyResult): Promise<Element> {
  const { focused } = await createFocusNavigateObserver(new CapturedScreen(hierarchy)).read();
  if (!focused) {
    throw new Error("capture has no focused element");
  }
  return focused;
}

describe("textFieldToolkit (#17488)", () => {
  test("a captured Compose EditText with no id is Compose by its ComposeView ancestor", async () => {
    const hierarchy = composeCapture();
    const focused = await focusedIn(hierarchy);
    expect(focused.class).toBe("android.widget.EditText");
    expect(focused["resource-id"]).toBeUndefined();
    expect(textFieldToolkit(focused, hierarchy)).toBe("compose");
  });

  test("a captured View EditText with no id is a View: no ComposeView above it", async () => {
    const hierarchy = idlessViewCapture();
    const focused = await focusedIn(hierarchy);
    expect(focused.class).toBe("android.widget.EditText");
    expect(focused["resource-id"]).toBeUndefined();
    expect(textFieldToolkit(focused, hierarchy)).toBe("view");
  });

  test("an unqualified id does not make a View field Compose", async () => {
    const hierarchy = idlessViewCapture();
    const focused = { ...(await focusedIn(hierarchy)), "resource-id": "search" };
    expect(textFieldToolkit(focused, hierarchy)).toBe("view");
  });

  test("a field parsed from another read is located by its focused bounds", async () => {
    const focused = await focusedIn(idlessViewCapture());
    // A fresh parse of the same screen: no shared node identity with `focused`.
    expect(textFieldToolkit({ ...focused }, idlessViewCapture())).toBe("view");
    expect(textFieldToolkit({ ...(await focusedIn(composeCapture())) }, composeCapture())).toBe(
      "compose",
    );
  });

  test("a package-qualified id is a View without consulting the hierarchy", () => {
    const field: Element = {
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      class: "android.widget.EditText",
      "resource-id": "com.example:id/search",
    };
    expect(textFieldToolkit(field, undefined)).toBe("view");
  });

  test("without a hierarchy, or with the field absent from it, a bare id falls back to Compose", () => {
    const field: Element = {
      bounds: { left: 1, top: 2, right: 3, bottom: 4 },
      class: "android.widget.EditText",
      "resource-id": "search_field",
      focused: true,
    };
    expect(textFieldToolkit(field, undefined)).toBe("compose");
    expect(textFieldToolkit(field, idlessViewCapture())).toBe("compose");
  });

  test("FocusNavigate never presses tab into a captured id-less View EditText", async () => {
    const device = new CapturedScreen(idlessViewCapture());
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const navigate = new FocusNavigate(createFocusNavigateObserver(device), device, timer);

    const result = await navigate.execute({ until: { text: "No such target" } });

    expect(result.status).toBe("stuck");
    expect(result.blockedBy).toBe("editable");
    expect(device.keys).not.toContain("tab");
    expect(result.message).toContain("tab would type into it");
  });
});
