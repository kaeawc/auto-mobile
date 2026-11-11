import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ObserveResult } from "../../../../src/models";
import type { SendKeysCommandResult } from "../../../../src/features/action/SendKeys";
import {
  autoA11yFallbackWarning,
  unusableImeKeyboard,
} from "../../../../src/features/action/sendkeys/PasswordRouting";
import {
  CachedAndroidXrDetector,
  XR_SPATIAL_FEATURE,
} from "../../../../src/utils/android-cmdline-tools/androidXrDevice";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAndroidXrDetector } from "../../../fakes/FakeAndroidXrDetector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { getStructuredPayload } from "../../../../src/utils/toolUtils";
import { setCapturedKeyboard } from "../../../../src/features/observe/output/elementProvenance";
import { android, createSendKeysHarness, focused } from "../SendKeysTestHarness";
import { buildObserveResult } from "../../../helpers/observeFixture";

interface CapturedSendKeys {
  commands: SendKeysCommandResult[];
  observation: ObserveResult;
}

/** A captured `sendKeys` tool run: the echoed command line, then the MCP response JSON (#17801). */
function readCapture(name: string): CapturedSendKeys {
  const raw = readFileSync(resolve("test/fixtures/android-xr-sendkeys", name), "utf8");
  const lines = raw.split("\n");
  const start = lines.indexOf("{");
  const end = lines.indexOf("}", start);
  const payload = getStructuredPayload<CapturedSendKeys>(
    JSON.parse(lines.slice(start, end + 1).join("\n")),
  );
  if (!payload) {
    throw new Error(`${name} has no structured sendKeys payload`);
  }
  return payload;
}

const autoCapture = readCapture("auto-mode-gboard-fails.txt");
const a11yCapture = readCapture("a11y-mode-works.txt");
/** The headset observation sendKeys read before failing: Gboard shown, no readable editor. */
const xrObservation = autoCapture.observation;
const GBOARD = "com.google.android.inputmethod.latin";

function xrHarness(observation: ObserveResult = xrObservation) {
  return createSendKeysHarness(android, { execute: async () => observation }, undefined, {
    xrDetector: new FakeAndroidXrDetector(true),
  });
}

const XR_FEATURE_PROBE = `pm has-feature ${XR_SPATIAL_FEATURE}`;

/** A harness whose XR verdict comes from the real shared detector reading `pm has-feature`. */
function featureProbedHarness(observation: ObserveResult, declaresXr: boolean) {
  const harness = createSendKeysHarness(android, { execute: async () => observation }, undefined, {
    xrDetector: new CachedAndroidXrDetector(new FakeTimer()),
  });
  harness.adb.setCommandResponse(XR_FEATURE_PROBE, createExecResult(`${declaresXr}\n`, ""));
  const probes = () =>
    harness.adb.getExecutedCommands().filter((command) => command.includes(XR_FEATURE_PROBE))
      .length;
  return { ...harness, probes };
}

describe("Auto falls back to a11y when the AutoMobile IME cannot be used (#17801)", () => {
  test("the captured headset observation shows Gboard and no readable focused editor", () => {
    expect(xrObservation.keyboard).toEqual({ visible: true, package: GBOARD });
    expect(unusableImeKeyboard(xrObservation, true)).toBe(GBOARD);
    expect(autoCapture.commands[0]).toMatchObject({
      requestedMode: "auto",
      resolvedMode: "ime",
      errorCode: "NO_FOCUSED_EDITABLE",
    });
  });

  test("auto insert on the headset types through accessibility and says so", async () => {
    const harness = xrHarness();
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    // The runner assigns `index`; every other field matches the explicit a11y run.
    const a11yWorked = a11yCapture.commands[0]!;
    expect(result).toMatchObject({
      ...a11yWorked,
      index: result.index,
      requestedMode: "auto",
      warning: autoA11yFallbackWarning(GBOARD),
    });
    expect(result.warning).toContain(GBOARD);
    expect(result.errorCode).toBeUndefined();
    expect(result.backend).toBeUndefined();
    expect(harness.inserted).toEqual(["wifi"]);
    expect(harness.committed).toEqual([]);
    // No IME was selected, so there is nothing to restore at session release.
    expect(harness.adb.getExecutedCommands().filter((c) => c.includes("ime set"))).toEqual([]);
  });

  test("the raw observer shape, with the keyboard only on elements, also falls back", async () => {
    // The live observer leaves the top-level `keyboard` unset; the response sanitizer adds it.
    const elements: NonNullable<ObserveResult["elements"]> = {
      clickable: [],
      scrollable: [],
      text: [],
      media: [],
    };
    setCapturedKeyboard(elements, xrObservation.keyboard);
    const raw: ObserveResult = { ...xrObservation, keyboard: undefined, elements };
    expect(unusableImeKeyboard(raw, true)).toBe(GBOARD);
    const harness = xrHarness(raw);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({
      success: true,
      resolvedMode: "a11y",
      warning: autoA11yFallbackWarning(GBOARD),
    });
    expect(harness.inserted).toEqual(["wifi"]);
  });

  test("auto replace on the headset sets the text through accessibility", async () => {
    const harness = xrHarness();
    const result = await harness.executor.type({
      action: "type",
      text: "wifi",
      operation: "replace",
    });
    expect(result).toMatchObject({
      success: true,
      resolvedMode: "a11y",
      warning: autoA11yFallbackWarning(GBOARD),
    });
    expect(harness.replaced).toEqual(["wifi"]);
    expect(harness.committed).toEqual([]);
  });

  test("an accessibility failure after the fallback is reported, not hidden", async () => {
    const harness = xrHarness();
    harness.client.insert = async () => ({
      success: false,
      error: "No focused editable node found",
    });
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({
      success: false,
      resolvedMode: "a11y",
      error: "No focused editable node found",
      warning: autoA11yFallbackWarning(GBOARD),
    });
  });

  test("an explicit mode is never rerouted", async () => {
    const harness = xrHarness();
    const result = await harness.executor.type({ action: "type", text: "wifi", mode: "ime" });
    expect(result.resolvedMode).toBe("ime");
    expect(result.warning ?? "").not.toContain("Auto mode typed through accessibility");
  });

  test("the AutoMobile IME on screen keeps the focus refusal", async () => {
    const observation: ObserveResult = {
      ...xrObservation,
      keyboard: { visible: true, package: "dev.jasonpearson.automobile.ctrlproxy" },
    };
    expect(unusableImeKeyboard(observation, true)).toBeUndefined();
    const harness = xrHarness(observation);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({
      success: false,
      resolvedMode: "ime",
      errorCode: "NO_FOCUSED_EDITABLE",
    });
    expect(harness.inserted).toEqual([]);
  });

  test("no keyboard on screen keeps the focus refusal", async () => {
    const observation: ObserveResult = { ...xrObservation, keyboard: undefined };
    const harness = xrHarness(observation);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({ success: false, errorCode: "NO_FOCUSED_EDITABLE" });
    expect(harness.inserted).toEqual([]);
  });

  test("a phone with a readable focused field keeps the AutoMobile IME under Gboard", async () => {
    const observation: ObserveResult = {
      ...focused,
      keyboard: { visible: true, package: GBOARD },
    };
    expect(unusableImeKeyboard(observation, true)).toBeUndefined();
    const harness = xrHarness(observation);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({ success: true, resolvedMode: "ime", backend: "autoMobileIme" });
    expect(result.warning).toBeUndefined();
    expect(harness.committed).toEqual(["wifi"]);
    expect(harness.inserted).toEqual([]);
  });
});

/** A phone WebView page with Gboard up and no readable focused editable node. */
const phoneWebView: ObserveResult = buildObserveResult({
  screenSize: { width: 1080, height: 2400 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  updatedAt: 1,
  viewHierarchy: {
    hierarchy: { node: { $: { class: "android.webkit.WebView", focused: "false" } } },
  },
  keyboard: { visible: true, package: GBOARD },
});

describe("phones keep the AutoMobile IME under Gboard (#16428)", () => {
  test("a phone WebView with Gboard visible is not an XR device and keeps the IME", () => {
    expect(unusableImeKeyboard(phoneWebView, false)).toBeUndefined();
  });

  test("a phone with Gboard is not XR for sendKeys: the shared detector keeps the IME", async () => {
    const harness = featureProbedHarness(phoneWebView, false);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({ resolvedMode: "ime", errorCode: "NO_FOCUSED_EDITABLE" });
    expect(result.warning ?? "").not.toContain("Auto mode typed through accessibility");
    expect(harness.inserted).toEqual([]);
    expect(harness.probes()).toBe(1);
  });

  test("auto type into an unfocused WebView field stays on the AutoMobile IME", async () => {
    const harness = createSendKeysHarness(
      { ...android, formFactor: "phone" },
      { execute: async () => phoneWebView },
    );
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({ resolvedMode: "ime", errorCode: "NO_FOCUSED_EDITABLE" });
    expect(result.warning ?? "").not.toContain("Auto mode typed through accessibility");
    expect(harness.inserted).toEqual([]);
  });

  test("auto replace into an unfocused WebView field dispatches through the AutoMobile IME", async () => {
    const harness = createSendKeysHarness(android, { execute: async () => phoneWebView });
    const result = await harness.executor.type({
      action: "type",
      text: "wifi",
      operation: "replace",
    });
    expect(result).toMatchObject({ resolvedMode: "ime", backend: "autoMobileIme" });
    expect(result.warning ?? "").not.toContain("Auto mode typed through accessibility");
    expect(harness.committed).toEqual(["wifi"]);
    expect(harness.replaced).toEqual([]);
    expect(harness.inserted).toEqual([]);
  });
});

describe("sendKeys asks the shared Android XR detector (#17811)", () => {
  /** The headset capture with no announced form factor and no XR System UI in the back stack. */
  const bareHeadset: ObserveResult = { ...xrObservation, backStack: undefined };

  test("a headset declaring the XR feature, with no form factor or XR System UI, falls back", async () => {
    expect(android.formFactor).toBeUndefined();
    const harness = featureProbedHarness(bareHeadset, true);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({
      success: true,
      resolvedMode: "a11y",
      warning: autoA11yFallbackWarning(GBOARD),
    });
    expect(harness.inserted).toEqual(["wifi"]);
    expect(harness.probes()).toBe(1);
  });

  test("XR System UI windows alone no longer make a device XR", async () => {
    const harness = featureProbedHarness(xrObservation, false);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({ resolvedMode: "ime", errorCode: "NO_FOCUSED_EDITABLE" });
    expect(harness.inserted).toEqual([]);
  });

  test("a readable focused field never asks the detector", async () => {
    const harness = featureProbedHarness(
      { ...focused, keyboard: { visible: true, package: GBOARD } },
      true,
    );
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({ success: true, resolvedMode: "ime" });
    expect(harness.probes()).toBe(0);
  });
});
