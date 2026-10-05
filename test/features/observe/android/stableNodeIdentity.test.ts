import { capturedAndroidControl } from "../../../helpers/androidDisabledControlCapture";
import { describe, expect, test } from "bun:test";
import {
  assignStableViewIds,
  GENERATED_VIEW_ID_PATTERN,
  STABLE_VIEW_ID_PREFIX,
} from "../../../../src/features/observe/android/StableNodeIdentity";
import { DefaultElementFinder } from "../../../../src/features/utility/ElementFinder";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import { DefaultTextMatcher } from "../../../../src/features/utility/TextMatcher";
import type { ViewHierarchyResult } from "../../../../src/models";

/**
 * Capture-layer stable node identity (issue #3228): the ingest pass that
 * rewrites the Android runner's positional (path-derived UUID) `view-id`s into
 * content-derived stable ids, so id-less rows keep their identity across a
 * scroll and `diffObserveResult`'s content-identity re-pair can collapse the
 * scroll cascade. Fixture-level acceptance (the #3132 scroll pair) is pinned
 * separately in `test/features/observe/output/stableIdentityScrollDiff.test.ts`.
 */

/** A fresh path-derived UUID the runner would emit for an id-less node. */
function generatedUuid(seed: string): string {
  // Any UUID-shaped lowercase hex string; vary by seed for uniqueness.
  const hex = (seed.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) >>> 0)
    .toString(16)
    .padStart(8, "0");
  return `${hex}-0000-4000-8000-00000000000${seed.length % 10}`;
}

function node(
  attrs: Record<string, unknown>,
  children?: Record<string, unknown>[],
): Record<string, unknown> {
  const n: Record<string, unknown> = { ...attrs };
  if (children && children.length > 0) {
    n.node = children.length === 1 ? children[0] : children;
  }
  return n;
}

describe("assignStableViewIds (#3228)", () => {
  test("rewrites a generated UUID view-id into a prefixed content hash", () => {
    const root = node({
      "view-id": generatedUuid("row"),
      "content-desc": "Basic long press card",
      bounds: { left: 0, top: 100, right: 500, bottom: 200 },
    });
    assignStableViewIds(root);
    const id = root["view-id"] as string;
    expect(id.startsWith(STABLE_VIEW_ID_PREFIX)).toBe(true);
    expect(GENERATED_VIEW_ID_PATTERN.test(id)).toBe(false);
  });

  test("leaves resource-id-backed and non-UUID view-ids untouched", () => {
    const withResourceId = node({
      "view-id": "com.example:id/button",
      "resource-id": "com.example:id/button",
    });
    const withCustom = node({ "view-id": "custom-id-shape" });
    const withoutViewId = node({ text: "no view-id at all" });
    for (const n of [withResourceId, withCustom, withoutViewId]) {
      const before = { ...n };
      assignStableViewIds(n);
      expect(n).toEqual(before);
    }
  });

  test("same content at a different position/state yields the SAME id (scroll survival)", () => {
    // The same row captured before and after a ~250px scroll: bounds moved, the
    // path-derived UUID changed, volatile extras/occlusion churned — but the
    // stable content is identical, so the assigned id must match.
    const before = node(
      {
        "view-id": generatedUuid("a"),
        bounds: { left: 42, top: 983, right: 1038, bottom: 1089 },
        extras: { traversalIndex: 7 },
        occlusionState: "partial",
      },
      [
        node({
          "view-id": generatedUuid("b"),
          text: "Item 42",
          bounds: { left: 60, top: 990, right: 900, bottom: 1080 },
        }),
      ],
    );
    const after = node(
      {
        "view-id": generatedUuid("c"),
        bounds: { left: 42, top: 658, right: 1038, bottom: 764 },
        extras: { traversalIndex: 3 },
      },
      [
        node({
          "view-id": generatedUuid("d"),
          text: "Item 42",
          bounds: { left: 60, top: 665, right: 900, bottom: 755 },
        }),
      ],
    );
    assignStableViewIds(before);
    assignStableViewIds(after);
    expect(before["view-id"]).toEqual(after["view-id"]);
    expect((before.node as Record<string, unknown>)["view-id"]).toEqual(
      (after.node as Record<string, unknown>)["view-id"],
    );
  });

  test("a label-distinguished id-less row keeps its id across a scroll and resolves through ElementFinder (#6728)", () => {
    const capture = (labels: string[]) => {
      const rows = labels.map((label, index) =>
        node(
          {
            "view-id": generatedUuid(`row-${index}`),
            class: "android.widget.LinearLayout",
            bounds: { left: 0, top: index * 50, right: 200, bottom: index * 50 + 40 },
          },
          [
            node({
              "view-id": "com.app:id/title",
              "resource-id": "com.app:id/title",
              class: "android.widget.TextView",
              text: label,
            }),
          ],
        ),
      );
      const root = node({ "view-id": "com.app:id/list", "resource-id": "com.app:id/list" }, rows);
      assignStableViewIds(root);
      return { root, rows };
    };
    const before = capture(["Alice", "Bob", "Carol"]);
    const after = capture(["Bob", "Carol", "Dave"]);
    const observedBobId = before.rows[1]["view-id"] as string;
    const observedCarolId = before.rows[2]["view-id"] as string;
    expect(new Set(before.rows.map((row) => row["view-id"])).size).toBe(3);
    expect(after.rows[0]["view-id"]).toBe(observedBobId);
    expect(after.rows[1]["view-id"]).toBe(observedCarolId);
    expect(observedBobId).toMatch(/^s2-[0-9a-f]{16}~[0-9a-f]{8}$/);
    expect(observedCarolId).toMatch(/^s2-[0-9a-f]{16}~[0-9a-f]{8}$/);

    const finder = new DefaultElementFinder(new DefaultElementParser(), new DefaultTextMatcher());
    const resolved = finder.findElementByResourceId(
      { hierarchy: after.root } as ViewHierarchyResult,
      observedBobId,
    );
    expect(resolved?.bounds).toEqual(after.rows[0].bounds);
  });

  test("only descendant-text collisions retain document-order ordinals", () => {
    const rows = ["Alice", "Bob", "Bob"].map((label, index) =>
      node({ "view-id": generatedUuid(`row-${index}`), class: "android.widget.LinearLayout" }, [
        node({
          "view-id": "com.app:id/title",
          "resource-id": "com.app:id/title",
          class: "android.widget.TextView",
          text: label,
        }),
      ]),
    );
    assignStableViewIds(node({}, rows));
    const ids = rows.map((row) => row["view-id"] as string);
    expect(ids[0]).toMatch(/^s2-[0-9a-f]{16}~[0-9a-f]{8}$/);
    const base = ids[0].split("~")[0];
    expect(ids[1]).toBe(`${base}-2`);
    expect(ids[2]).toBe(`${base}-3`);
  });

  test("stationary duplicate rows distinguished only by ticking timer digits keep ordinal ids", () => {
    const capture = (seconds: number) => {
      const rows = [0, 2].map((offset, index) =>
        node({ "view-id": generatedUuid(`row-${index}`), class: "android.widget.LinearLayout" }, [
          node({
            "view-id": "com.app:id/timer",
            class: "android.widget.TextView",
            text: `00:${String(seconds + offset).padStart(2, "0")}`,
          }),
        ]),
      );
      assignStableViewIds(node({}, rows));
      return rows.map((row) => row["view-id"] as string);
    };
    const before = capture(5);
    const after = capture(6);
    const base = before[0].replace(/-1$/, "");
    expect(before).toEqual([`${base}-1`, `${base}-2`]);
    expect(after).toEqual(before);
  });

  test("rows distinguished only by ASCII and Unicode digits use document-order ordinals", () => {
    const rows = ["Item 1", "Item ٢", "Item ३"].map((label, index) =>
      node({ "view-id": generatedUuid(`row-${index}`), class: "android.widget.LinearLayout" }, [
        node({ "view-id": "com.app:id/title", class: "android.widget.TextView", text: label }),
      ]),
    );
    assignStableViewIds(node({}, rows));
    const ids = rows.map((row) => row["view-id"] as string);
    const base = ids[0].replace(/-1$/, "");
    expect(base).toMatch(/^s2-[0-9a-f]{16}$/);
    expect(ids).toEqual([`${base}-1`, `${base}-2`, `${base}-3`]);
  });

  test("label-distinguished duplicate rows keep their text suffix when only counter digits tick", () => {
    const capture = (minutes: number) => {
      const rows = ["Alice", "Bob"].map((label, index) =>
        node({ "view-id": generatedUuid(`row-${index}`), class: "android.widget.LinearLayout" }, [
          node({ "view-id": "com.app:id/title", class: "android.widget.TextView", text: label }),
          node({
            "view-id": "com.app:id/age",
            class: "android.widget.TextView",
            text: `${minutes} min ago`,
          }),
        ]),
      );
      assignStableViewIds(node({}, rows));
      return rows.map((row) => row["view-id"] as string);
    };
    const before = capture(5);
    const after = capture(6);
    expect(before).toEqual(after);
    expect(before[0]).toMatch(/^s2-[0-9a-f]{16}~[0-9a-f]{8}$/);
    expect(before[1]).toMatch(/^s2-[0-9a-f]{16}~[0-9a-f]{8}$/);
    expect(before[0]).not.toBe(before[1]);
  });

  test("entered text in a descendant EditText never changes its row's text suffix (#7926)", () => {
    const capture = (email: string) => {
      const rows = [
        ["Email", email],
        ["Password", ""],
      ].map(([hint, text], index) =>
        node({ "view-id": generatedUuid(`row-${index}`), class: "android.widget.LinearLayout" }, [
          node({
            "view-id": generatedUuid(`field-${index}`),
            class: "android.widget.EditText",
            "hint-text": hint,
            text,
          }),
        ]),
      );
      assignStableViewIds(node({}, rows));
      return rows.map((row) => row["view-id"] as string);
    };
    const before = capture("");
    const after = capture("jason@example.com");
    expect(before).toEqual(after);
    expect(before[0]).toMatch(/^s2-[0-9a-f]{16}~[0-9a-f]{8}$/);
    expect(before[0]).not.toBe(before[1]);
  });

  test("structurally distinct rows yield DIFFERENT ids (distinct rows never share)", () => {
    // Distinctness is structural: a differing resource-id / class / test-tag
    // anywhere in the subtree keeps the ancestors' ids distinct (#6230), even
    // though the volatile display text no longer participates in the rollup.
    const rowA = node({ "view-id": generatedUuid("a") }, [
      node({
        "view-id": generatedUuid("a1"),
        "resource-id": "com.example:id/first",
        text: "Item 1",
      }),
    ]);
    const rowB = node({ "view-id": generatedUuid("b") }, [
      node({
        "view-id": generatedUuid("b1"),
        "resource-id": "com.example:id/second",
        text: "Item 2",
      }),
    ]);
    assignStableViewIds(rowA);
    assignStableViewIds(rowB);
    expect(rowA["view-id"]).not.toEqual(rowB["view-id"]);
    // The leaf nodes themselves still differ by their own resource-id/text.
    expect((rowA.node as Record<string, unknown>)["view-id"]).not.toEqual(
      (rowB.node as Record<string, unknown>)["view-id"],
    );
  });

  test("a descendant's text/content-desc churn does NOT change an ancestor's id (#6230)", () => {
    // A row wrapping a live timer child whose label ticks between the skeleton
    // capture and the fresh capture a later tapOn resolves against. The row (and
    // any other ancestor) must keep its id so the emitted selector still matches;
    // only the timer leaf's own id may change, because its own content changed.
    const rowWith = (label: string): Record<string, unknown> =>
      node({ "view-id": generatedUuid("row"), "resource-id": "com.example:id/timerRow" }, [
        node({ "view-id": generatedUuid("static"), text: "Elapsed" }),
        node({ "view-id": generatedUuid("timer"), text: label }),
      ]);
    const before = rowWith("1 second");
    const after = rowWith("2 seconds");
    assignStableViewIds(before);
    assignStableViewIds(after);
    // Ancestor row id is stable across the descendant label tick…
    expect(before["view-id"]).toEqual(after["view-id"]);
    // …and the static sibling's own id is likewise stable…
    expect((before.node as Record<string, unknown>[])[0]["view-id"]).toEqual(
      (after.node as Record<string, unknown>[])[0]["view-id"],
    );
    // …while the timer leaf's OWN id changes, because its own text changed.
    expect((before.node as Record<string, unknown>[])[1]["view-id"]).not.toEqual(
      (after.node as Record<string, unknown>[])[1]["view-id"],
    );
  });

  test("canonical class and legacy className participate equivalently in identity", () => {
    const canonical = node({
      "view-id": generatedUuid("canonical"),
      class: "android.widget.ImageView",
    });
    const legacy = node({
      "view-id": generatedUuid("legacy"),
      className: "android.widget.ImageView",
    });
    const different = node({
      "view-id": generatedUuid("different"),
      class: "android.widget.TextView",
    });

    assignStableViewIds(canonical);
    assignStableViewIds(legacy);
    assignStableViewIds(different);

    expect(canonical["view-id"]).toEqual(legacy["view-id"]);
    expect(canonical["view-id"]).not.toEqual(different["view-id"]);
  });

  test("interaction-state flips (checked/focused) do not change identity", () => {
    const off = node({
      "view-id": generatedUuid("t"),
      "content-desc": "Wifi toggle",
      checked: "false",
    });
    const on = node({
      "view-id": generatedUuid("t"),
      "content-desc": "Wifi toggle",
      checked: "true",
      focused: "true",
    });
    assignStableViewIds(off);
    assignStableViewIds(on);
    expect(off["view-id"]).toEqual(on["view-id"]);
  });

  test("content-identical duplicates get document-order ordinal suffixes on EVERY member incl. the first (#6229)", () => {
    const spacer = () => node({ "view-id": generatedUuid("s"), bounds: {} });
    const root = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [
      spacer(),
      spacer(),
      spacer(),
    ]);
    assignStableViewIds(root);
    const children = root.node as Record<string, unknown>[];
    const ids = children.map((c) => c["view-id"] as string);
    expect(new Set(ids).size).toBe(3);
    // No member of a duplicate group takes the bare form: the first is `-1`,
    // reserving the bare `s-<hash>` for genuinely-unique content (issue #6229).
    expect(ids[0]).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-1$`));
    const base = ids[0].replace(/-1$/, "");
    expect(ids[1]).toBe(`${base}-2`);
    expect(ids[2]).toBe(`${base}-3`);
  });

  test("distinct child accessibility labels give Android icon-button containers distinct ids (#7311)", () => {
    // Contacts puts these labels on a child ImageView, not the clickable
    // container. The containers otherwise have the same empty shape.
    const labels = [
      "Add photo",
      "Delete",
      "Add phone",
      "Save",
      "More options",
      "Add email",
      "Add address",
      "Add event",
      "Add note",
      "Add website",
    ];
    const root = node(
      { "view-id": generatedUuid("root") },
      labels.map((label) =>
        node({ "view-id": generatedUuid(`button-${label}`), class: "android.widget.ImageButton" }, [
          node({
            "view-id": generatedUuid(`icon-${label}`),
            class: "android.widget.ImageView",
            "content-desc": label,
          }),
        ]),
      ),
    );

    assignStableViewIds(root);

    const ids = (root.node as Record<string, unknown>[]).map(
      (button) => button["view-id"] as string,
    );
    expect(new Set(ids).size).toBe(labels.length);
    for (const id of ids) {
      expect(id).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}$`));
    }
  });

  test("IME subtree presence does not change app duplicate ordinals (#7311)", () => {
    const appDuplicate = (seed: string) =>
      node({
        "view-id": generatedUuid(seed),
        class: "android.widget.FrameLayout",
        "content-desc": "Unlabeled action",
      });
    const imeSubtree = (childCount: number) =>
      node(
        {
          "view-id": generatedUuid("ime-root"),
          class: "android.inputmethodservice.InputMethodService",
          extras: { "automobile:imePackage": "some.keyboard.package" },
        },
        // These intentionally share the app duplicates' content hash. Their
        // only separation is the inherited IME-window namespace.
        Array.from({ length: childCount }, (_, index) => appDuplicate(`ime-child-${index}`)),
      );
    const capture = (imeChildCount?: number) => {
      const children = [
        appDuplicate("app-one"),
        appDuplicate("app-two"),
        appDuplicate("app-three"),
      ];
      if (imeChildCount !== undefined) {
        children.splice(1, 0, imeSubtree(imeChildCount));
      }
      const root = node({ "view-id": generatedUuid("root") }, children);
      assignStableViewIds(root);
      return (root.node as Record<string, unknown>[])
        .filter((child) => child["content-desc"] === "Unlabeled action")
        .map((child) => child["view-id"] as string);
    };

    const withoutIme = capture();
    expect(withoutIme).toEqual([
      expect.stringMatching(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-1$`)),
      expect.stringMatching(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-2$`)),
      expect.stringMatching(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-3$`)),
    ]);
    expect(capture(1)).toEqual(withoutIme);
    expect(capture(10)).toEqual(withoutIme);
  });

  test("a content hash that occurs exactly once still gets the bare, un-suffixed id (#6229)", () => {
    // The bare form must remain the invariant for unique content — only
    // duplicate groups are ordinal-suffixed.
    const root = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [
      node({ "view-id": generatedUuid("only"), text: "Solo" }),
    ]);
    assignStableViewIds(root);
    const child = root.node as Record<string, unknown>;
    expect(child["view-id"]).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}$`));
  });

  test("uses a new namespace so a legacy bare id cannot select a post-upgrade singleton (#6229)", () => {
    const root = node({ "view-id": generatedUuid("root") }, [
      node({ "view-id": generatedUuid("only"), text: "Solo" }),
    ]);
    assignStableViewIds(root);
    const currentId = (root.node as Record<string, unknown>)["view-id"] as string;
    const legacyId = currentId.replace(STABLE_VIEW_ID_PREFIX, "s-");
    expect(currentId).toStartWith(STABLE_VIEW_ID_PREFIX);
    expect(currentId).not.toBe(legacyId);
  });

  test("removing the original of a duplicate pair does not reassign a bare id it collides with (#6229)", () => {
    // Capture 1: content-identical peers [A, B]. Under the fixed scheme A is
    // `s-H-1` (NOT bare) and B is `s-H-2`.
    const spacer = (seed: string) => node({ "view-id": generatedUuid(seed), bounds: {} });
    const before = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [
      spacer("a"),
      spacer("b"),
    ]);
    assignStableViewIds(before);
    const beforeIds = (before.node as Record<string, unknown>[]).map((c) => c["view-id"] as string);
    const idA = beforeIds[0];
    expect(idA).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-1$`));

    // Capture 2: A removed, B is the sole surviving node with that content. It
    // is reassigned the bare `s-H` (now unique) — which is NOT equal to the
    // `s-H-1` a caller observed for A, so the stale selector can no longer
    // silently land on B.
    const after = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [spacer("b")]);
    assignStableViewIds(after);
    const survivorId = (after.node as Record<string, unknown>)["view-id"] as string;
    expect(survivorId).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}$`));
    expect(survivorId).not.toBe(idA);
    // The survivor's bare id is the same base hash, just without A's `-1`.
    expect(survivorId).toBe(idA.replace(/-1$/, ""));
  });

  test("is idempotent — a second pass changes nothing", () => {
    const root = node({ "view-id": generatedUuid("r") }, [
      node({ "view-id": generatedUuid("x"), text: "A" }),
      node({ "view-id": generatedUuid("y"), text: "A" }), // duplicate content
    ]);
    assignStableViewIds(root);
    const snapshot = JSON.parse(JSON.stringify(root));
    assignStableViewIds(root);
    expect(root).toEqual(snapshot);
  });

  test("rewrites occludedByViewId references when generated occluder ids are stabilized", () => {
    const occluderUuid = generatedUuid("overlay");
    const occluded = node({
      "view-id": generatedUuid("covered"),
      text: "Covered",
      occlusionState: "partial",
      occludedBy: "unlabeled view",
      occludedByViewId: occluderUuid,
    });
    const occluder = node({
      "view-id": occluderUuid,
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    });
    const root = node({ "view-id": generatedUuid("root") }, [occluded, occluder]);

    assignStableViewIds(root);

    const children = root.node as Record<string, unknown>[];
    expect(children[0].occludedByViewId).toBe(children[1]["view-id"]);
    expect(GENERATED_VIEW_ID_PATTERN.test(children[0].occludedByViewId as string)).toBe(false);
  });

  test("handles single-object and array child slots plus non-object input", () => {
    const single = node({ "view-id": generatedUuid("p") }, [
      node({ "view-id": generatedUuid("c"), text: "only" }),
    ]);
    expect(Array.isArray(single.node)).toBe(false); // single child is an object, not an array
    assignStableViewIds(single);
    expect(
      ((single.node as Record<string, unknown>)["view-id"] as string).startsWith(
        STABLE_VIEW_ID_PREFIX,
      ),
    ).toBe(true);
    // Non-objects are ignored without throwing.
    assignStableViewIds(undefined);
    assignStableViewIds(null);
    assignStableViewIds("not a node");
  });

  test("a node's own text participates in identity (a text edit is a new identity, matching nodeKey semantics)", () => {
    const empty = node({ "view-id": generatedUuid("e"), text: "" });
    const typed = node({ "view-id": generatedUuid("e"), text: "SignOff3051" });
    assignStableViewIds(empty);
    assignStableViewIds(typed);
    expect(empty["view-id"]).not.toEqual(typed["view-id"]);
  });

  test("typing in one of two identical editable siblings preserves both observed ids and resolves the second", () => {
    const capture = (emailText: string) => {
      const fields = [
        node({
          "view-id": generatedUuid("email"),
          class: "android.widget.EditText",
          text: emailText,
          bounds: { left: 0, top: 0, right: 200, bottom: 40 },
        }),
        node({
          "view-id": generatedUuid("password"),
          class: "android.widget.EditText",
          text: "",
          bounds: { left: 0, top: 50, right: 200, bottom: 90 },
        }),
      ];
      const root = node({}, fields);
      assignStableViewIds(root);
      return { root, fields };
    };

    const before = capture("");
    const after = capture("jason@example.com");
    const observedEmailId = before.fields[0]["view-id"] as string;
    const observedPasswordId = before.fields[1]["view-id"] as string;
    expect(observedEmailId).toMatch(/^s2-[0-9a-f]{16}-1$/);
    expect(observedPasswordId).toMatch(/^s2-[0-9a-f]{16}-2$/);
    expect(after.fields[0]["view-id"]).toBe(observedEmailId);
    expect(after.fields[1]["view-id"]).toBe(observedPasswordId);

    const finder = new DefaultElementFinder(new DefaultElementParser(), new DefaultTextMatcher());
    const resolved = finder.findElementByResourceId(
      { hierarchy: after.root } as ViewHierarchyResult,
      observedPasswordId,
    );
    expect(resolved?.bounds).toEqual(after.fields[1].bounds);
  });

  test("Compose text fields keep label-distinguished ids when Email is filled (#6728)", () => {
    const capture = (emailText: string) => {
      const fields = [
        node(
          {
            "view-id": generatedUuid("email"),
            class: "android.widget.EditText",
            text: emailText,
            bounds: { left: 0, top: 0, right: 200, bottom: 40 },
          },
          [
            node({ "view-id": generatedUuid("email-box1"), class: "android.view.View", text: "" }),
            node({
              "view-id": generatedUuid("email-label"),
              class: "android.widget.TextView",
              text: "Email",
            }),
            node({ "view-id": generatedUuid("email-box2"), class: "android.view.View", text: "" }),
          ],
        ),
        node(
          {
            "view-id": generatedUuid("password"),
            class: "android.widget.EditText",
            text: "",
            bounds: { left: 0, top: 50, right: 200, bottom: 90 },
          },
          [
            node({
              "view-id": generatedUuid("password-box1"),
              class: "android.view.View",
              text: "",
            }),
            node({
              "view-id": generatedUuid("password-label"),
              class: "android.widget.TextView",
              text: "Password",
            }),
            node({
              "view-id": generatedUuid("password-box2"),
              class: "android.view.View",
              text: "",
            }),
          ],
        ),
      ];
      const root = node({}, fields);
      assignStableViewIds(root);
      return { root, fields };
    };

    const before = capture("");
    const after = capture("mt@example.com");
    const observedEmailId = before.fields[0]["view-id"] as string;
    const observedPasswordId = before.fields[1]["view-id"] as string;
    expect(observedEmailId).toMatch(/^s2-[0-9a-f]{16}$/);
    expect(observedPasswordId).toMatch(/^s2-[0-9a-f]{16}$/);
    expect(observedEmailId).not.toBe(observedPasswordId);
    expect(after.fields[0]["view-id"]).toBe(observedEmailId);
    expect(after.fields[1]["view-id"]).toBe(observedPasswordId);
    expect(after.fields[0]["view-id"]).not.toBe(after.fields[1]["view-id"]);

    const finder = new DefaultElementFinder(new DefaultElementParser(), new DefaultTextMatcher());
    const resolved = finder.findElementByResourceId(
      { hierarchy: after.root } as ViewHierarchyResult,
      observedEmailId,
    );
    expect(resolved?.bounds).toEqual(after.fields[0].bounds);
    expect(resolved?.text).toBe("mt@example.com");
  });

  test("editable label fallback skips interactive text and does not search grandchildren", () => {
    const fieldId = (interactiveText: string, label: string, nested = false): string => {
      const labelNode = node({ class: "android.widget.TextView", text: label });
      const field = node(
        { "view-id": generatedUuid("field"), class: "android.widget.EditText", text: "typed" },
        [
          node({ class: "android.widget.TextView", text: interactiveText, clickable: true }),
          node({ class: "android.widget.EditText", text: interactiveText }),
          nested ? node({ class: "android.view.View" }, [labelNode]) : labelNode,
        ],
      );
      assignStableViewIds(field);
      return field["view-id"] as string;
    };

    expect(fieldId("First", "Email")).toBe(fieldId("Second", "Email"));
    expect(fieldId("First", "Email")).not.toBe(fieldId("First", "Password"));
    expect(fieldId("First", "Email", true)).toBe(fieldId("First", "Password", true));
  });

  test("an editable field uses its stable hint instead of entered text", () => {
    const inputId = (hint: string, text: string): string => {
      const field = node({
        "view-id": generatedUuid("input"),
        class: "android.widget.EditText",
        "hint-text": hint,
        text,
      });
      assignStableViewIds(field);
      return field["view-id"] as string;
    };
    expect(inputId("Email", "")).toBe(inputId("Email", "jason@example.com"));
    expect(inputId("Email", "")).not.toBe(inputId("Password", ""));
  });
});

test("named toggles retain ids across state text changes but remain distinct (#6794)", () => {
  const capture = (text: string, description: string, checkable = true) => {
    const tile = node({
      "view-id": generatedUuid("tile"),
      class: "android.widget.Switch",
      "content-desc": description,
      text,
      checkable,
    });
    assignStableViewIds(tile);
    return tile["view-id"];
  };
  expect(capture("Off", "Do Not Disturb.")).toBe(capture("On", "Do Not Disturb."));
  expect(capture("On", "Bluetooth.")).not.toBe(capture("On", "Do Not Disturb."));
  expect(capture("Off", "")).not.toBe(capture("On", ""));
  expect(capture("Off", "Status", false)).not.toBe(capture("On", "Status", false));
});

test("generated UUID view-id matching is case-insensitive and stateless", () => {
  const lower = "123e4567-e89b-12d3-a456-426614174000";
  const upper = lower.toUpperCase();
  expect(GENERATED_VIEW_ID_PATTERN.global).toBe(false);
  expect(GENERATED_VIEW_ID_PATTERN.sticky).toBe(false);
  expect(GENERATED_VIEW_ID_PATTERN.test(lower)).toBe(true);
  expect(GENERATED_VIEW_ID_PATTERN.test(upper)).toBe(true);
  expect(GENERATED_VIEW_ID_PATTERN.test(lower)).toBe(true);
  expect(GENERATED_VIEW_ID_PATTERN.test(upper)).toBe(true);
});

test("assignStableViewIds rewrites lower- and upper-case generated UUIDs identically", () => {
  const lower = node({ "view-id": "123e4567-e89b-12d3-a456-426614174000", text: "Save" });
  const upper = node({ "view-id": "123E4567-E89B-12D3-A456-426614174000", text: "Save" });

  assignStableViewIds(lower);
  assignStableViewIds(upper);

  expect(lower["view-id"]).toMatch(/^s2-[0-9a-f]{16}$/);
  expect(upper["view-id"]).toBe(lower["view-id"]);
});

test("captured Android control keeps its stable id across an enabled flip", () => {
  const enabled = capturedAndroidControl("enabled");
  const disabled = capturedAndroidControl();
  assignStableViewIds(enabled);
  assignStableViewIds(disabled);
  expect(enabled["view-id"]).toStartWith(STABLE_VIEW_ID_PREFIX);
  expect(disabled["view-id"]).toBe(enabled["view-id"]);
  expect(disabled.enabled).toBe("false");
});
