import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ObserveResult } from "../../../../src/models";
import type { SendKeysCommandResult } from "../../../../src/features/action/SendKeys";
import {
  autoA11yFallbackWarning,
  unusableImeKeyboard,
} from "../../../../src/features/action/sendkeys/PasswordRouting";
import { getStructuredPayload } from "../../../../src/utils/toolUtils";
import { android, createSendKeysHarness, focused } from "../SendKeysTestHarness";

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
  return createSendKeysHarness(android, { execute: async () => observation });
}

describe("Auto falls back to a11y when the AutoMobile IME cannot be used (#17801)", () => {
  test("the captured headset observation shows Gboard and no readable focused editor", () => {
    expect(xrObservation.keyboard).toEqual({ visible: true, package: GBOARD });
    expect(unusableImeKeyboard(xrObservation)).toBe(GBOARD);
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
    expect(unusableImeKeyboard(observation)).toBeUndefined();
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
    expect(unusableImeKeyboard(observation)).toBeUndefined();
    const harness = xrHarness(observation);
    const result = await harness.executor.type({ action: "type", text: "wifi" });
    expect(result).toMatchObject({ success: true, resolvedMode: "ime", backend: "autoMobileIme" });
    expect(result.warning).toBeUndefined();
    expect(harness.committed).toEqual(["wifi"]);
    expect(harness.inserted).toEqual([]);
  });
});
