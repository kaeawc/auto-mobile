import { beforeAll, expect, test } from "bun:test";
import { clearIosFieldWithVerification } from "../../../src/features/action/iosClearVerification";
import { getFocusedTextField } from "../../../src/features/action/ClearText";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import editingCapture from "../../fixtures/ios-safari-url-field/hierarchy-editing.json";
import { buildObserveResult, viewHierarchyFromFixture } from "../../helpers/observeFixture";
import { FakeTimer } from "../../fakes/FakeTimer";

let before: ObserveResult;
let cleared: ObserveResult;
let placeholder: ObserveResult;
let webChanged: ObserveResult;

beforeAll(() => {
  function capture(change: "none" | "cleared" | "placeholder" | "web"): ObserveResult {
    const hierarchy = structuredClone(viewHierarchyFromFixture(editingCapture));
    const nodes = new SearchableHierarchy().project(hierarchy);
    const url = nodes.find((node) => node.nativeId === "URL");
    const keyboard = nodes.find((node) => node.className === "UIKeyboard");
    const web = nodes.find(
      (node) => node.className === "UITextField" && node.element?.text === "Google Search",
    );
    if (!url || !keyboard || !web) {
      throw new Error("Captured Safari fields missing");
    }
    // Round-3: ~/.claude/orchestrate/kaeawc__auto-mobile/verify/int-r3/evidence/
    // ios-r3/A-loop1.txt and batch/sessions/i1/out skeletons.
    url.source.bounds = { left: 20, top: 517, right: 294, bottom: 565 };
    keyboard.source.bounds = { left: 4, top: 597, right: 399, bottom: 813 };
    if (change === "cleared") {
      delete nodeAttributes(url.source).value;
    }
    // Negative/placeholder probes reuse captured values and identities, without adding nodes.
    if (change === "placeholder") {
      nodeAttributes(url.source).value = nodeAttributes(url.source)["hint-text"];
    }
    if (change === "web") {
      nodeAttributes(web.source).value = nodeAttributes(url.source)["hint-text"];
    }
    return buildObserveResult({
      viewHierarchy: hierarchy,
      updatedAt: 0,
      screenSize: { width: 402, height: 874 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  }
  before = capture("none");
  cleared = capture("cleared");
  placeholder = capture("placeholder");
  webChanged = capture("web");
});

function harness(captures: ObserveResult[]) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let reads = 0;
  let clears = 0;
  return {
    timer,
    get clears() {
      return clears;
    },
    run: () =>
      clearIosFieldWithVerification({
        timer,
        clear: async () => {
          clears++;
          return { success: true };
        },
        observer: { execute: async () => captures[Math.min(reads++, captures.length - 1)] },
      }),
  };
}

test("Safari native URL clear succeeds while focused web value stays unchanged", async () => {
  const h = harness([before, cleared]);
  expect(await h.run()).toEqual({ success: true });
  expect(h.clears).toBe(1);
});

test("Safari unchanged native and web values still report removed nothing", async () => {
  const h = harness([before, before]);
  expect(await h.run()).toMatchObject({
    success: false,
    error: expect.stringContaining("removed nothing"),
  });
  expect(h.clears).toBe(2);
});

test("a changed web field does not prove that the native URL cleared", async () => {
  // A transient web-value change is not the native non-empty-to-blank signal.
  const h = harness([before, webChanged, before, before]);
  expect(await h.run()).toMatchObject({
    success: false,
    error: expect.stringContaining("removed nothing"),
  });
  expect(h.clears).toBe(3);
});

test("Safari native clear succeeds on retry when the first capture is stale", async () => {
  const h = harness([before, before, cleared]);
  expect(await h.run()).toEqual({ success: true });
  expect(h.clears).toBe(2);
  expect(h.timer.getSleepHistory()).toEqual([100]);
});

test("Safari native placeholder value is blank for clear and typing reads", async () => {
  const field = getFocusedTextField(placeholder.viewHierarchy!, undefined, {
    includeIosNativeEditableValues: true,
  });
  expect(field?.nativeEditableValues?.URL).toBe("");
  expect(await harness([before, placeholder]).run()).toEqual({ success: true });
});
