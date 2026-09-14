import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

/**
 * An app screen with NO keyboard at all, whose single control happens to carry
 * the `key_pos_*` resource-id prefix. Nothing here is authoritative, so the
 * fallback marker is the only evidence — and one borrowed id is not a keyboard
 * (issue #6871).
 */
function loneDecoyKeycapObservation(): ObserveResult {
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
            $: {
              "resource-id": "com.app:id/save",
              text: "Save",
              clickable: true,
              bounds: { left: 0, top: 100, right: 100, bottom: 150 },
            },
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

describe("fallback keycap corroboration (#6871)", () => {
  test("a lone key_pos_* app control never invents a keyboard", () => {
    const result = sanitizeObserveResult(loneDecoyKeycapObservation(), {
      dropElements: true,
      project: "skeleton",
    });
    const ids = result.skeleton!.map((entry) => entry.elementId);
    expect(ids).toEqual(["com.app:id/key_pos_preview", "com.app:id/save"]);
    expect(ids).not.toContain("<ime>");
    expect(result.keyboard).toBeUndefined();
  });

  test("two distinct keycaps from one package still fold without the extra", () => {
    const source = loneDecoyKeycapObservation();
    source.viewHierarchy!.hierarchy.node!.node![1].$["resource-id"] = "com.app:id/key_pos_0_1";
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.skeleton!.map((entry) => entry.elementId)).toEqual(["<ime>"]);
    expect(result.keyboard).toEqual({ visible: true, package: "com.app" });
  });
});

describe("IME-owned affordances fold with the keys (#6871)", () => {
  test("a same-package toolbar control inside the IME window is not kept out", () => {
    const source = keyboardFloodObservation();
    // Gboard's toolbar/emoji/clipboard affordances carry the SAME keycap id
    // family as its letter keys, so they are not separable from a key — and the
    // supported way to drive the keyboard is `inputText` / `sendKeys` anyway.
    source.viewHierarchy!.hierarchy.node!.node![1].node!.push({
      $: {
        "resource-id": "com.google.android.inputmethod.latin:id/key_pos_header_access_points_menu",
        "content-desc": "Toolbar",
        clickable: true,
        bounds: { left: 0, top: 590, right: 40, bottom: 600 },
      },
    });
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    const ids = sanitizeObserveResult(source, {
      dropElements: true,
      project: "skeleton",
    }).skeleton!.map((entry) => entry.elementId);
    expect(ids).not.toContain(
      "com.google.android.inputmethod.latin:id/key_pos_header_access_points_menu",
    );
    expect(ids).toContain("<ime>");
    // Framework chrome from another package still stays individually actionable.
    expect(ids).toContain("android:id/input_method_nav_back");
  });
});

/**
 * The legacy capture path (no `automobile:imePackage` extra) where the IME's own
 * keys hang off an actionable IME-owned container. The container's provenance
 * interval STARTS BEFORE and ENDS AFTER the keycap markers that identified the
 * window, so a membership rule that only admits nodes inside the marker span
 * leaves `keyboard_container | tap` beside `<ime>` — two rows for one keyboard
 * (issue #6871).
 */
function enclosingImeContainerObservation(): ObserveResult {
  const key = (index: number): ViewHierarchyNode => ({
    $: {
      "resource-id": `com.ime:id/key_pos_0_${index}`,
      text: String.fromCharCode(113 + index),
      clickable: true,
      bounds: { left: index * 10, top: 620, right: index * 10 + 10, bottom: 660 },
    },
  });
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "resource-id": "com.app:id/save",
              text: "Save",
              clickable: true,
              bounds: { left: 0, top: 100, right: 100, bottom: 150 },
            },
          },
          {
            $: {
              "resource-id": "com.ime:id/keyboard_container",
              clickable: true,
              bounds: { left: 0, top: 600, right: 100, bottom: 800 },
            },
            node: [
              // An anonymous key BEFORE the first marker: inside the container's
              // subtree, outside the marker span.
              {
                $: {
                  text: "?123",
                  clickable: true,
                  bounds: { left: 0, top: 600, right: 20, bottom: 620 },
                },
              },
              key(0),
              key(1),
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

describe("enclosing IME container folds with its keys (#6871)", () => {
  test("an IME-owned container enclosing the marker span is not a second row", () => {
    const result = sanitizeObserveResult(enclosingImeContainerObservation(), {
      dropElements: true,
      project: "skeleton",
    });
    const ids = result.skeleton!.map((entry) => entry.elementId);
    expect(ids).toEqual(["com.app:id/save", "<ime>"]);
    expect(result.skeleton!.find((entry) => entry.elementId === "<ime>")).toEqual({
      elementId: "<ime>",
      label: "Keyboard (com.ime)",
      // The whole keyboard subtree, including the anonymous key that precedes
      // the first marker.
      bounds: [0, 600, 100, 800],
      affordances: ["input"],
    });
    expect(result.keyboard).toEqual({ visible: true, package: "com.ime" });
  });
});

/**
 * The `<ime>` row is conditional: a visible IME that exposes no bounded
 * accessible descendant is announced by the `keyboard` summary alone, because a
 * synthetic row must never claim a box it cannot measure (issue #6871). The
 * user-facing documentation has to say so — a docs-driven consumer that reads
 * the summary as a guarantee of an accompanying row would dereference a row
 * that is legitimately absent.
 */
describe("documented IME row shape matches the projection (#6871)", () => {
  test("docs/tools.md conditions the <ime> row on a bounded IME node", () => {
    // Prose wraps, so compare on a single-spaced flattening of the file.
    const doc = readFileSync("docs/tools.md", "utf8").replace(/\s+/g, " ");
    expect(doc).toContain("at most one skeleton row");
    expect(doc).not.toContain("plus exactly one skeleton row");
    expect(doc).toContain("at least one bounded accessible descendant");
  });

  test("a captured keyboard with no accessible keys emits the summary and no row", () => {
    const source = observation();
    source.viewHierarchy!.hierarchy.node!.node![1].node = [];
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.keyboard).toEqual({ visible: true, package: "example.keyboard" });
    expect(result.skeleton!.map((entry) => entry.elementId)).not.toContain("<ime>");
  });
});

/**
 * The legacy capture path (no `automobile:imePackage` extra) where the IME's
 * own wrapper is NOT actionable and carries no text — an
 * `com.ime:id/keyboard_view` `FrameLayout` — so the collector never places it
 * in any `elements` category. The marker span is then keycap-only, and the
 * anonymous keys before the first / after the last `key_pos_*` marker fall
 * outside it: each stayed an individual tap row while `<ime>` claimed only the
 * marker box (issue #6908 item 1).
 */
function uncollectedImeWrapperObservation(): ObserveResult {
  const key = (index: number): ViewHierarchyNode => ({
    $: {
      "resource-id": `com.ime:id/key_pos_0_${index}`,
      text: String.fromCharCode(113 + index),
      clickable: true,
      bounds: { left: index * 10, top: 620, right: index * 10 + 10, bottom: 660 },
    },
  });
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "resource-id": "com.app:id/save",
              text: "Save",
              clickable: true,
              bounds: { left: 0, top: 100, right: 100, bottom: 150 },
            },
          },
          {
            // Non-actionable, unlabelled, IME-owned: never collected.
            $: {
              "resource-id": "com.ime:id/keyboard_view",
              bounds: { left: 0, top: 600, right: 100, bottom: 800 },
            },
            node: [
              {
                $: {
                  text: "?123",
                  clickable: true,
                  bounds: { left: 0, top: 600, right: 20, bottom: 620 },
                },
              },
              key(0),
              key(1),
              {
                $: {
                  "content-desc": "Enter",
                  clickable: true,
                  bounds: { left: 80, top: 760, right: 100, bottom: 800 },
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

describe("uncollected IME wrapper still bounds the fold (#6908)", () => {
  test("anonymous keys outside the marker span fold into one <ime> row with the wrapper's bounds", () => {
    const source = uncollectedImeWrapperObservation();
    // Precondition: the wrapper really is absent from every collected category.
    expect(JSON.stringify(source.elements)).not.toContain("com.ime:id/keyboard_view");
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.skeleton!.map((entry) => entry.elementId)).toEqual(["com.app:id/save", "<ime>"]);
    expect(result.skeleton!.find((entry) => entry.elementId === "<ime>")).toEqual({
      elementId: "<ime>",
      label: "Keyboard (com.ime)",
      bounds: [0, 600, 100, 800],
      affordances: ["input"],
    });
    expect(result.keyboard).toEqual({ visible: true, package: "com.ime" });
  });

  test("an uncollected wrapper owned by ANOTHER package never widens the fold", () => {
    const source = uncollectedImeWrapperObservation();
    // The framework's own decor wrapper encloses the keys but is not the IME's.
    source.viewHierarchy!.hierarchy.node!.node![1].$["resource-id"] = "android:id/content";
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    const ime = result.skeleton!.find((entry) => entry.elementId === "<ime>");
    expect(ime?.bounds).toEqual([0, 620, 20, 660]);
    // The anonymous keys stay individual rows: nothing IME-owned encloses them.
    expect(result.skeleton!.map((entry) => entry.label)).toContain("?123");
    expect(result.skeleton!.map((entry) => entry.label)).toContain("Enter");
  });

  test("the authoritative path is unchanged by an uncollected IME-owned wrapper", () => {
    // The capture vouches for the IME, and its root is ALSO an uncollected,
    // IME-owned wrapper wider than the keys. Membership comes from the inherited
    // provenance alone, and the row keeps the keys' own box, as before.
    const source = observation();
    const imeRoot = source.viewHierarchy!.hierarchy.node!.node![1];
    imeRoot.$["resource-id"] = "example.keyboard:id/keyboard_view";
    imeRoot.$.bounds = { left: 0, top: 0, right: 100, bottom: 200 };
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    expect(JSON.stringify(source.elements)).not.toContain("example.keyboard:id/keyboard_view");
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.skeleton?.map((entry) => entry.label)).toEqual([
      "SAVE",
      "App control",
      "Keyboard (example.keyboard)",
    ]);
    expect(result.skeleton!.find((entry) => entry.elementId === "<ime>")?.bounds).toEqual([
      0, 0, 100, 100,
    ]);
  });
});

/**
 * Legacy capture where the SAME package owns `key_pos_*` controls in two
 * different root/window groups: the keyboard app's own settings screen shows a
 * `key_pos_preview` control in the main root while its IME is up in a window
 * root. Counting markers per package across groups let the decoy and the real
 * keys corroborate each other, and `detectImeWindow` then locked onto the FIRST
 * group's span — the decoy folded into `<ime>` while the real keys stayed
 * individual rows (issue #6908 item 2).
 */
function crossWindowKeycapObservation(windowKeyCount: number): ObserveResult {
  const key = (index: number): ViewHierarchyNode => ({
    $: {
      "resource-id": `com.keyboard:id/key_pos_0_${index}`,
      text: String.fromCharCode(113 + index),
      clickable: true,
      bounds: { left: index * 10, top: 600, right: index * 10 + 10, bottom: 640 },
    },
  });
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "resource-id": "com.keyboard:id/key_pos_preview",
              text: "Preview",
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
            $: { bounds: { left: 0, top: 590, right: 100, bottom: 800 } },
            node: Array.from({ length: windowKeyCount }, (_, index) => key(index)),
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

describe("keycap corroboration is scoped to one window group (#6908)", () => {
  test("a decoy in another window neither corroborates nor captures the fold", () => {
    const result = sanitizeObserveResult(crossWindowKeycapObservation(2), {
      dropElements: true,
      project: "skeleton",
    });
    const ids = result.skeleton!.map((entry) => entry.elementId);
    expect(ids).toEqual(["com.keyboard:id/key_pos_preview", "<ime>"]);
    expect(result.skeleton!.find((entry) => entry.elementId === "<ime>")).toEqual({
      elementId: "<ime>",
      label: "Keyboard (com.keyboard)",
      bounds: [0, 600, 20, 640],
      affordances: ["input"],
    });
    expect(result.keyboard).toEqual({ visible: true, package: "com.keyboard" });
  });

  test("one marker per window is not a keyboard", () => {
    const result = sanitizeObserveResult(crossWindowKeycapObservation(1), {
      dropElements: true,
      project: "skeleton",
    });
    expect(result.skeleton!.map((entry) => entry.elementId)).toEqual([
      "com.keyboard:id/key_pos_preview",
      "com.keyboard:id/key_pos_0_0",
    ]);
    expect(result.keyboard).toBeUndefined();
  });
});
