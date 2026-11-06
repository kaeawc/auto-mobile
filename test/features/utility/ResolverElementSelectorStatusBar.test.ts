import { describe, expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../../src/models";
import { linkWindowRoots } from "../../../src/features/observe/linkWindowRoots";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { readCapturedHierarchy } from "../../fixtures/capturedFixtures";

const captured = readCapturedHierarchy(
  "android-settings/add-network-security-spinner.viewHierarchy.json",
);

/**
 * Issue #17198: `tapOn { text: "Battery" }` on a Settings screen without a Battery row tapped the
 * status-bar battery icon, whose content-desc (`Battery charging, 77 percent.`) only contains the
 * text, and reported success. The fixture is a real Settings capture: the SystemUI window holds
 * `com.android.systemui:id/battery` with an unlabelled child carrying `Battery charging, 100
 * percent.`, and no Settings node mentions Battery.
 */

const BATTERY_ID = "com.android.systemui:id/battery";
const BATTERY_LABEL = "Battery charging, 100 percent.";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forEachNode(value: unknown, visit: (node: Json) => void): void {
  if (Array.isArray(value)) {
    value.forEach((child) => forEachNode(child, visit));
  } else if (isRecord(value)) {
    visit(value);
    Object.values(value).forEach((child) => forEachNode(child, visit));
  }
}

function firstNode(capture: ViewHierarchyResult, match: (node: Json) => boolean): Json {
  let found: Json | undefined;
  forEachNode(capture.hierarchy, (node) => {
    found ??= match(node) ? node : undefined;
  });
  if (!found) {
    throw new Error("fixture node not found");
  }
  return found;
}

/** Tap lookup's text policy: substring, ignoring case, inspect intent (see TapElementFinder). */
function selectText(capture: ViewHierarchyResult, text: string, match?: "contains" | "exact") {
  return new ResolverElementSelector().select(capture, match ? { text, match } : { text }, {
    partialMatch: true,
    caseSensitive: false,
    intentAction: "inspect",
    selectionIntent: "tap",
    allowHintFallback: true,
  });
}

/** Whether the selection landed on the status-bar battery icon (its label sits on a child). */
function hitStatusBarBattery(result: ReturnType<typeof selectText>): boolean {
  return [result.element, result.matchedElement].some(
    (element) => element?.["content-desc"] === BATTERY_LABEL,
  );
}

/** The capture as the device client delivers it: window roots are nodes inside `hierarchy`. */
function capture(): ViewHierarchyResult {
  const result = structuredClone(captured);
  result.windows = linkWindowRoots(result.hierarchy, result.windows);
  return result;
}

describe("text selectors skip SystemUI status-bar chrome on a substring match (#17198)", () => {
  test("the fixture carries the status-bar battery and no Settings Battery row", () => {
    const battery = firstNode(capture(), (node) => node["resource-id"] === BATTERY_ID);
    expect(JSON.stringify(battery)).toContain(BATTERY_LABEL);
    const settingsMentions: string[] = [];
    forEachNode(capture().hierarchy, (node) => {
      const label = `${String(node.text ?? "")} ${String(node["content-desc"] ?? "")}`;
      if (/battery/i.test(label) && !JSON.stringify(battery).includes(label.trim())) {
        settingsMentions.push(label);
      }
    });
    expect(settingsMentions).toEqual([]);
  });

  test("`Battery` with only the status-bar icon containing it is not found", () => {
    const result = selectText(capture(), "Battery");
    expect(result.element).toBeNull();
    expect(result.totalMatches).toBe(0);
    expect(hitStatusBarBattery(result)).toBe(false);
  });

  test("an app row containing the text wins over the status-bar icon", () => {
    const hierarchy = capture();
    const row = firstNode(hierarchy, (node) => node.text === "Security");
    row.text = "Battery saver";
    const result = selectText(hierarchy, "Battery");
    expect(result.totalMatches).toBe(1);
    expect(hitStatusBarBattery(result)).toBe(false);
    expect(JSON.stringify(result.matchedElement ?? result.element)).toContain("Battery saver");
  });

  test("an exact app label is still found", () => {
    const hierarchy = capture();
    const row = firstNode(hierarchy, (node) => node.text === "Security");
    row.text = "Battery";
    const result = selectText(hierarchy, "Battery");
    expect(result.totalMatches).toBe(1);
    expect(hitStatusBarBattery(result)).toBe(false);
  });

  test("the full status-bar label still resolves the icon exactly", () => {
    const result = selectText(capture(), BATTERY_LABEL);
    expect(result.totalMatches).toBe(1);
    expect(hitStatusBarBattery(result)).toBe(true);
  });

  test("an explicit `contains` still reaches status-bar chrome", () => {
    const result = selectText(capture(), "Battery", "contains");
    expect(result.totalMatches).toBe(1);
    expect(hitStatusBarBattery(result)).toBe(true);
  });

  test("substring matches outside the status bar are unchanged", () => {
    const result = selectText(capture(), "Secur");
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.element).not.toBeNull();
  });
});
