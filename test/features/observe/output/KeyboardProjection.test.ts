import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";

function observation(platform: "android" | "ios" = "android", keyboard = true): ObserveResult {
  const node = (text: string): ViewHierarchyNode => ({
    $: { text, clickable: true, bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
  });
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          node("SAVE"),
          ...(keyboard
            ? [
                {
                  $: { extras: { "automobile:imePackage": "example.keyboard" } },
                  node: [
                    node("Q"),
                    node("Next"),
                    {
                      $: {
                        text: "Suggestion",
                        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
                      },
                    },
                  ],
                },
              ]
            : []),
          node("App control"),
        ],
      },
    },
  };
  return {
    updatedAt: 1,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy, platform),
  };
}

describe("Android keyboard output projection", () => {
  test("reports a captured keyboard even without accessible keys", () => {
    const source = observation();
    source.viewHierarchy!.hierarchy.node!.node![1].node = [];
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.keyboard).toEqual({ visible: true, package: "example.keyboard" });
    expect(JSON.stringify(source.elements)).not.toContain("keyboard");
  });
  test("folds keyboard descendants while retaining overlapping app controls", () => {
    const source = observation();
    const before = JSON.stringify(source);
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.skeleton?.map((entry) => entry.label)).toEqual([
      "SAVE",
      "App control",
      // The folded IME is still announced as ONE row (issue #6871), so a client
      // can see the keyboard is up without being handed a key per cap.
      "Keyboard (example.keyboard)",
    ]);
    expect(result.keyboard).toEqual({ visible: true, package: "example.keyboard" });
    expect(result.context).toBeUndefined();
    expect(JSON.stringify(source)).toBe(before);
  });

  test("full output retains every keyboard node", () => {
    const source = observation();
    const result = sanitizeObserveResult(source, { dropElements: false, project: "full" });
    expect(result.elements?.clickable.map((entry) => entry.text)).toEqual([
      "SAVE",
      "Q",
      "Next",
      "App control",
    ]);
    expect(result.viewHierarchy).toBeDefined();
    expect(result.keyboard).toBeUndefined();
  });

  test("does not invent visibility without keyboard capture evidence", () => {
    expect(
      sanitizeObserveResult(observation("android", false), {
        dropElements: true,
        project: "skeleton",
      }).keyboard,
    ).toBeUndefined();
  });

  test("does not fold iOS nodes carrying Android extras", () => {
    const result = sanitizeObserveResult(observation("ios"), {
      dropElements: true,
      project: "skeleton",
    });
    expect(result.skeleton?.map((entry) => entry.label)).toContain("Q");
    expect(result.keyboard).toBeUndefined();
  });
});

/**
 * The dogfood repro for issue #6871: the IME window floods the skeleton with one
 * tap row per keycap. The #6825 fold keys off the `automobile:imePackage` extra,
 * which only a re-cut control proxy supplies — on an older on-device proxy (and
 * on the `uiautomator dump` path) the extra is absent and every key came
 * through. This fixture therefore carries NO extra, only the real
 * `…:id/key_pos_*` resource-id family the emulator emits.
 */
function keyboardFloodObservation(): ObserveResult {
  const IME = "com.google.android.inputmethod.latin";
  const key = (index: number): ViewHierarchyNode => {
    const left = (index % 10) * 10;
    const top = 600 + Math.floor(index / 10) * 40;
    return {
      $: {
        "resource-id": `${IME}:id/key_pos_${Math.floor(index / 10)}_${index % 10}`,
        text: String.fromCharCode(97 + (index % 26)),
        clickable: true,
        bounds: { left, top, right: left + 10, bottom: top + 40 },
      },
    };
  };
  const keys = Array.from({ length: 40 }, (_, index) => key(index));
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "resource-id": "com.android.systemui:id/remote_input_send",
              text: "Send",
              clickable: true,
              bounds: { left: 0, top: 100, right: 200, bottom: 150 },
            },
          },
          {
            $: { bounds: { left: 0, top: 590, right: 100, bottom: 800 } },
            node: [
              ...keys,
              {
                $: {
                  "resource-id": "android:id/input_method_nav_back",
                  "content-desc": "Back",
                  clickable: true,
                  bounds: { left: 0, top: 780, right: 40, bottom: 800 },
                },
              },
            ],
          },
        ],
      },
    },
  };
  return {
    updatedAt: 1,
    screenSize: { width: 100, height: 800 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy, "android"),
  };
}

describe("IME window collapses to one skeleton node (#6871)", () => {
  test("keycaps identified by the key_pos_* family collapse without the imePackage extra", () => {
    const result = sanitizeObserveResult(keyboardFloodObservation(), {
      dropElements: true,
      project: "skeleton",
    });
    const ids = result.skeleton!.map((entry) => entry.elementId);
    expect(ids.filter((id) => id?.includes("key_pos_"))).toEqual([]);
    expect(ids).toContain("com.android.systemui:id/remote_input_send");
    // Non-keycap chrome inside the IME window stays individually actionable.
    expect(ids).toContain("android:id/input_method_nav_back");
    const ime = result.skeleton!.find((entry) => entry.elementId === "<ime>");
    expect(ime).toEqual({
      elementId: "<ime>",
      label: "Keyboard (com.google.android.inputmethod.latin)",
      bounds: [0, 600, 100, 760],
      affordances: ["input"],
    });
    expect(result.keyboard).toEqual({
      visible: true,
      package: "com.google.android.inputmethod.latin",
    });
  });

  test("project: full keeps every keycap", () => {
    const result = sanitizeObserveResult(keyboardFloodObservation(), {
      dropElements: false,
      project: "full",
    });
    expect(
      result.elements!.clickable.filter((el) => `${el["resource-id"]}`.includes("key_pos_")).length,
    ).toBe(40);
    expect(result.skeleton).toBeUndefined();
  });

  test("the captured-extra path emits the same single node", () => {
    const result = sanitizeObserveResult(observation(), {
      dropElements: true,
      project: "skeleton",
    });
    expect(result.skeleton?.map((entry) => entry.label)).toEqual([
      "SAVE",
      "App control",
      "Keyboard (example.keyboard)",
    ]);
  });
});

/**
 * A decoy app control whose resource-id happens to match the `key_pos_*` keycap
 * family, emitted BEFORE the real IME window. The fallback marker must never
 * outrank the authoritative `automobile:imePackage` identity (issue #6871).
 */
function decoyKeycapObservation(): ObserveResult {
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "resource-id": "com.app:id/key_pos_preview",
              text: "Preview",
              clickable: true,
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            },
          },
          {
            $: { extras: { "automobile:imePackage": "com.real.ime" } },
            node: [
              {
                $: {
                  "resource-id": "com.real.ime:id/key_pos_0_0",
                  text: "q",
                  clickable: true,
                  bounds: { left: 0, top: 600, right: 10, bottom: 640 },
                },
              },
            ],
          },
        ],
      },
    },
  };
  return {
    updatedAt: 1,
    screenSize: { width: 100, height: 800 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy, "android"),
  };
}

describe("IME identity precedence (#6871)", () => {
  test("authoritative IME identity outranks an earlier key_pos_* app control", () => {
    const result = sanitizeObserveResult(decoyKeycapObservation(), {
      dropElements: true,
      project: "skeleton",
    });
    const ids = result.skeleton!.map((entry) => entry.elementId);
    // The decoy is an app control, not a keycap: it stays individually actionable.
    expect(ids).toContain("com.app:id/key_pos_preview");
    // The real keycap is folded, and the row is labelled with the REAL IME.
    expect(ids).not.toContain("com.real.ime:id/key_pos_0_0");
    expect(result.skeleton!.find((entry) => entry.elementId === "<ime>")).toEqual({
      elementId: "<ime>",
      label: "Keyboard (com.real.ime)",
      bounds: [0, 600, 10, 640],
      affordances: ["input"],
    });
    expect(result.keyboard).toEqual({ visible: true, package: "com.real.ime" });
  });
});
/**
 * The active app and the IME share a package (a keyboard app showing its own
 * settings screen while its IME is up). Group 0 carries the app's own Save
 * button; the IME lives in its own window root. Package-only membership must
 * not reach across the window boundary (issue #6871).
 */
function sharedPackageObservation(): ObserveResult {
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "resource-id": "com.keyboard:id/save",
              text: "Save",
              clickable: true,
              bounds: { left: 0, top: 100, right: 100, bottom: 150 },
            },
          },
        ],
      },
    },
    windows: [
      {
        windowLayer: 5,
        hierarchy: {
          node: {
            $: { extras: { "automobile:imePackage": "com.keyboard" } },
            node: [
              {
                $: {
                  "resource-id": "com.keyboard:id/key_pos_0_0",
                  text: "q",
                  clickable: true,
                  bounds: { left: 0, top: 600, right: 10, bottom: 640 },
                },
              },
            ],
          },
        },
      },
    ],
  };
  return {
    updatedAt: 1,
    screenSize: { width: 100, height: 800 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: viewHierarchy as never,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy as never, "android"),
  };
}

describe("IME window membership (#6871)", () => {
  test("a captured IME with no accessible keys never folds same-package app controls", () => {
    const source = sharedPackageObservation();
    // Drop every key: the capture still vouches for the IME, but no collected
    // node can place its window, so nothing may be folded by package alone.
    (
      source.viewHierarchy as unknown as { windows: { hierarchy: { node: ViewHierarchyNode } }[] }
    ).windows[0].hierarchy.node.node = [];
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.skeleton!.map((entry) => entry.elementId)).toEqual(["com.keyboard:id/save"]);
    expect(result.keyboard).toEqual({ visible: true, package: "com.keyboard" });
  });

  test("a same-package app control in another window is not folded into the IME", () => {
    const result = sanitizeObserveResult(sharedPackageObservation(), {
      dropElements: true,
      project: "skeleton",
    });
    const ids = result.skeleton!.map((entry) => entry.elementId);
    expect(ids).toContain("com.keyboard:id/save");
    expect(ids).not.toContain("com.keyboard:id/key_pos_0_0");
    // The synthetic row spans the IME window only, never the app's own row.
    expect(result.skeleton!.find((entry) => entry.elementId === "<ime>")?.bounds).toEqual([
      0, 600, 10, 640,
    ]);
  });
});
