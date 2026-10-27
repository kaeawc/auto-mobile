import { beforeAll, expect, test } from "bun:test";
import { clearIosFieldWithVerification } from "../../../src/features/action/iosClearVerification";
import { getFocusedTextField } from "../../../src/features/action/ClearText";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import clearedCapture from "../../fixtures/ios-safari-url-field/runner-cleared-keyboard-up.json";
import typedCapture from "../../fixtures/ios-safari-url-field/runner-typed-keyboard-up.json";
import { observationFromRunnerCapture } from "../../helpers/iosSafariRunnerCapture";
import { FakeTimer } from "../../fakes/FakeTimer";

// Real iOS runner captures (iPhone 18 Pro, iOS 27.0, round 4 of #15175, taken 2026-10-23 around a
// failing `setUIState` clear of Safari's address field): the URL field holds "fixture typed text"
// with the keyboard up, then reads blank after the clear. The page's own "example" search box
// keeps the web focus in both. Probes below reuse the captured nodes and ids, adding no new fields.
let typed: ObserveResult;
let cleared: ObserveResult;
let placeholder: ObserveResult;
let webChanged: ObserveResult;
let urlMissing: ObserveResult;
let secondBlankEditable: ObserveResult;

beforeAll(() => {
  typed = observationFromRunnerCapture(typedCapture);
  cleared = observationFromRunnerCapture(clearedCapture);

  function probe(change: (nodes: ReturnType<SearchableHierarchy["project"]>) => void) {
    const observation = observationFromRunnerCapture(typedCapture);
    const hierarchy = structuredClone(observation.viewHierarchy!);
    const nodes = new SearchableHierarchy().project(hierarchy);
    change(nodes);
    return { ...observation, viewHierarchy: hierarchy };
  }
  function urlNode(nodes: ReturnType<SearchableHierarchy["project"]>) {
    const url = nodes.find((node) => node.nativeId === "URL");
    if (!url) {
      throw new Error("Captured Safari URL field missing");
    }
    return url;
  }

  placeholder = probe((nodes) => {
    const attributes = nodeAttributes(urlNode(nodes).source);
    attributes.value = attributes["hint-text"];
  });
  webChanged = probe((nodes) => {
    const web = nodes.find(
      (node) => node.className === "UITextField" && node.element?.text === "Google Search",
    );
    if (!web) {
      throw new Error("Captured web search field missing");
    }
    nodeAttributes(web.source).value = nodeAttributes(urlNode(nodes).source)["hint-text"];
  });
  urlMissing = probe((nodes) => {
    const url = urlNode(nodes);
    const parent = nodes[url.parentIndex!].source;
    parent.node = parent.node?.filter((node) => node !== url.source);
  });
  secondBlankEditable = probe((nodes) => {
    const url = urlNode(nodes);
    const sibling = structuredClone(url.source);
    const attributes = nodeAttributes(sibling);
    attributes["view-id"] = "SecondField";
    attributes["resource-id"] = "SecondField";
    delete attributes.value;
    nodes[url.parentIndex!].source.node?.push(sibling);
  });
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

test("captured typed and cleared Safari reads keep the page field as the focused value", () => {
  const options = { includeIosNativeEditableValues: true, iosPlaceholderAsBlank: true };
  expect(getFocusedTextField(typed.viewHierarchy!, undefined, options)).toEqual({
    value: "example",
    secure: false,
    nativeEditableValues: { URL: "fixture typed text" },
    keyboardNativeEditableValue: "fixture typed text",
  });
  expect(getFocusedTextField(cleared.viewHierarchy!, undefined, options)).toEqual({
    value: "example",
    secure: false,
    nativeEditableValues: { URL: "" },
    keyboardNativeEditableValue: "",
  });
});

test("Safari native URL clear succeeds while focused web value stays unchanged", async () => {
  const h = harness([typed, cleared]);
  expect(await h.run()).toEqual({ success: true });
  expect(h.clears).toBe(1);
});

test("Safari native URL clear succeeds when the pre-clear read did not see the URL field", async () => {
  const h = harness([urlMissing, cleared]);
  expect(await h.run()).toEqual({ success: true });
  expect(h.clears).toBe(1);
});

test("Safari URL field that is already blank needs no further clear", async () => {
  const h = harness([cleared, cleared]);
  expect(await h.run()).toEqual({ success: true });
  expect(h.clears).toBe(1);
});

test("Safari unchanged native and web values still report removed nothing", async () => {
  const h = harness([typed, typed]);
  expect(await h.run()).toMatchObject({
    success: false,
    error: expect.stringContaining("removed nothing"),
  });
  expect(h.clears).toBe(2);
});

test("a changed web field does not prove that the native URL cleared", async () => {
  // A transient web-value change is not the native non-empty-to-blank signal.
  const h = harness([typed, webChanged, typed, typed]);
  expect(await h.run()).toMatchObject({
    success: false,
    error: expect.stringContaining("removed nothing"),
  });
  expect(h.clears).toBe(3);
});

test("a blank sibling editable above the keyboard does not prove the URL field cleared", async () => {
  const h = harness([typed, secondBlankEditable, secondBlankEditable]);
  expect(await h.run()).toMatchObject({
    success: false,
    error: expect.stringContaining("removed nothing"),
  });
  expect(h.clears).toBe(2);
});

test("Safari native clear succeeds on retry when the first capture is stale", async () => {
  const h = harness([typed, typed, cleared]);
  expect(await h.run()).toEqual({ success: true });
  expect(h.clears).toBe(2);
  expect(h.timer.getSleepHistory()).toEqual([100]);
});

test("Safari native placeholder value is blank for clear and typing reads", async () => {
  const field = getFocusedTextField(placeholder.viewHierarchy!, undefined, {
    includeIosNativeEditableValues: true,
  });
  expect(field?.nativeEditableValues?.URL).toBe("");
  expect(await harness([typed, placeholder]).run()).toEqual({ success: true });
});
