import { describe, expect, test } from "bun:test";
import {
  activationTargetMismatchWarning,
  appendNoChangeWarning,
  mismatchWarnings,
  screenReaderNoChangeWarning,
} from "../../../src/features/action/tapActivationTargetWarnings";
import type { Element } from "../../../src/models/Element";
import type { TapEffect } from "../../../src/models/TapOnElementResult";

// Bounds from #17667: the "Send" label, its id-less button, and the composer container.
const label: Element = {
  "content-desc": "Send",
  bounds: { left: 946, top: 1390, right: 1062, bottom: 1506 },
};
const owner: Element = { bounds: { left: 941, top: 1390, right: 1067, bottom: 1506 } };
// Live nodes can lack bounds even though the model requires them (TalkBackTapStrategy guards
// for it), so the warnings must tolerate that shape.
const unbounded = (fields: Omit<Element, "bounds">): Element => fields as Element;
const container: Element = {
  "resource-id": "com.example:id/advanced_message_input_container",
  bounds: { left: 0, top: 1248, right: 1080, bottom: 1517 },
};

describe("activationTargetMismatchWarning", () => {
  test("is silent when the activated element contains the match", () => {
    expect(activationTargetMismatchWarning(label, owner)).toBeUndefined();
    expect(activationTargetMismatchWarning(label, container)).toBeUndefined();
    expect(activationTargetMismatchWarning(label, label)).toBeUndefined();
  });

  test("is silent when either side has no bounds", () => {
    expect(activationTargetMismatchWarning(undefined, owner)).toBeUndefined();
    expect(activationTargetMismatchWarning(unbounded({ text: "Send" }), owner)).toBeUndefined();
    expect(activationTargetMismatchWarning(label, unbounded({ text: "row" }))).toBeUndefined();
  });

  test("names both elements and the tapAt next step when the match lies outside", () => {
    const elsewhere: Element = {
      "resource-id": "com.example:id/attach",
      bounds: { left: 0, top: 1390, right: 120, bottom: 1506 },
    };
    expect(activationTargetMismatchWarning(label, elsewhere)).toBe(
      'The activated element "com.example:id/attach" [0,1390][120,1506] does not contain the matched element "Send" [946,1390][1062,1506], so a different control may have been activated. Observe the screen; if the intended control was not activated, use tapAt {x: 1004, y: 1448} (the matched element\'s center).',
    );
  });
});

describe("screenReaderNoChangeWarning", () => {
  test("names the activated ancestor beside the matched element", () => {
    expect(screenReaderNoChangeWarning(label, container)).toBe(
      'TalkBack activation is unconfirmed: the screen did not change after activating "com.example:id/advanced_message_input_container" [0,1248][1080,1517] for the matched element "Send" [946,1390][1062,1506]. Observe the screen; if the intended control was not activated, use tapAt {x: 1004, y: 1448} (the matched element\'s center).',
    );
  });

  test("names only the element when it was activated itself", () => {
    expect(screenReaderNoChangeWarning(label, label)).toBe(
      'TalkBack activation is unconfirmed: the screen did not change after activating the matched element "Send" [946,1390][1062,1506]. Observe the screen; if the intended control was not activated, use tapAt {x: 1004, y: 1448} (the matched element\'s center).',
    );
  });

  test("falls back to observing when no bounds are known", () => {
    expect(screenReaderNoChangeWarning(undefined, unbounded({ text: "Send" }))).toBe(
      'TalkBack activation is unconfirmed: the screen did not change after activating the matched element "Send". Observe the screen before retrying.',
    );
  });
});

describe("tapOn wiring helpers", () => {
  const elsewhere: Element = { bounds: { left: 0, top: 1390, right: 120, bottom: 1506 } };
  const selection = { element: owner, matchedElement: label };

  test("mismatchWarnings exempts focus and prefers the matched label", () => {
    expect(mismatchWarnings("focus", selection, elsewhere)).toEqual([]);
    expect(mismatchWarnings("tap", selection, owner)).toEqual([]);
    const expected = activationTargetMismatchWarning(label, elsewhere);
    expect(expected).toBeDefined();
    expect(mismatchWarnings("tap", selection, elsewhere)).toEqual(expected ? [expected] : []);
  });

  test("appendNoChangeWarning only fires for a claimed activation with no screen change", () => {
    const unchanged: TapEffect = { screenChanged: false, basis: "viewHierarchy unchanged" };
    const changed: TapEffect = { screenChanged: true, basis: "viewHierarchy changed" };
    const fresh = () => ({ element: owner, effect: unchanged, warnings: ["kept"] });

    const unclaimed = fresh();
    appendNoChangeWarning(unclaimed, undefined);
    expect(unclaimed.warnings).toEqual(["kept"]);

    const moved = { ...fresh(), effect: changed };
    appendNoChangeWarning(moved, { matched: label });
    expect(moved.warnings).toEqual(["kept"]);

    const silent = fresh();
    appendNoChangeWarning(silent, { matched: label });
    expect(silent.warnings).toEqual(["kept", screenReaderNoChangeWarning(label, owner)]);
  });
});
