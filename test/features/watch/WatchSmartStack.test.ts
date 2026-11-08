import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import {
  SMART_STACK_WIDGET_ROLE,
  WATCH_CLOCK_FACE_BUNDLE_ID,
  parseSmartStackWidgetIdentifier,
  parseWatchClockFaceDump,
  type SmartStackWidgetCard,
} from "../../../src/features/watch/WatchSmartStack";
import {
  parseXcuiDebugDescription,
  parseXcuiDebugLine,
} from "../../../src/features/watch/WatchXcuiDebugDescription";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ActionableError } from "../../../src/models/ActionableError";

const FIXTURES = path.join(import.meta.dir, "../../fixtures/watchos-clockface");
const firstDump = readFileSync(path.join(FIXTURES, "fixture-face-dump-smartstack.txt"), "utf8");
const reloadDump = readFileSync(
  path.join(FIXTURES, "fixture-face-smartstack-after-reload.txt"),
  "utf8",
);
const CELL_ID =
  "StackCollectionViewComplicationCell -- 93A18F3B-D642-41DA-B6A4-F312ED9DB584 -- ProbeApp -- " +
  "ProbeWidgetXYZ -- dev.probe.app -- dev.probe.app-dev.probe.app.widget-probe-0";
const PROBE_WIDGET = {
  type: "widget",
  cellId: "93A18F3B-D642-41DA-B6A4-F312ED9DB584",
  appName: "ProbeApp",
  widgetName: "ProbeWidgetXYZ",
  hostBundleId: "dev.probe.app",
  descriptor: "dev.probe.app-dev.probe.app.widget-probe-0",
  index: 0,
  extensionBundleId: "dev.probe.app.widget",
  widgetKind: "probe",
  bounds: { left: 5.5, top: 110, right: 181.5, bottom: 182.5 },
} satisfies Omit<SmartStackWidgetCard, "texts">;

describe("parseWatchClockFaceDump", () => {
  // The captured time labels carry a narrow no-break space (U+202F) before "PM".
  test("reads the header and the widget card before its timeline renders text", () => {
    const { smartStack, hierarchy } = parseWatchClockFaceDump(firstDump, { timestamp: 1 });
    expect(hierarchy).toMatchObject({
      packageName: WATCH_CLOCK_FACE_BUNDLE_ID,
      screenWidth: 187,
      screenHeight: 223,
      updatedAt: 1,
    });
    expect(smartStack.header).toEqual({
      bounds: { left: 5.5, top: 15.5, right: 181.5, bottom: 102.5 },
      labels: ["Saturday, November 7", "9:32\u202fPM and 59 seconds"],
    });
    expect(smartStack.cards).toEqual([{ ...PROBE_WIDGET, texts: [] }]);
  });

  test("reads the widget's own text and keeps the system card generic after a reload", () => {
    const { smartStack } = parseWatchClockFaceDump(reloadDump, { timestamp: 2 });
    expect(smartStack.header?.labels).toEqual([
      "Saturday, November 7",
      "9:33\u202fPM and 47 seconds",
    ]);
    expect(smartStack.cards).toEqual([
      { ...PROBE_WIDGET, texts: ["T28"] },
      {
        type: "system",
        cellKind: "TriPlatterCell",
        bounds: { left: 16.9, top: 137.4, right: 170, bottom: 200.5 },
        texts: ["No unread messages"],
      },
    ]);
  });

  test("maps the widget cell to an observe element with the widget role and its bounds", () => {
    const { hierarchy } = parseWatchClockFaceDump(reloadDump, { timestamp: 2 });
    const elements = new DefaultElementParser()
      .flattenViewHierarchy(hierarchy)
      .map((entry) => entry.element);
    expect(elements.find((element) => element["resource-id"] === CELL_ID)).toMatchObject({
      role: SMART_STACK_WIDGET_ROLE,
      class: "Cell",
      bounds: { left: 5.5, top: 110, right: 181.5, bottom: 182.5 },
    });
    expect(elements.some((element) => element.text === "T28")).toBe(true);
    const systemCard = elements.find(
      (element) => element["resource-id"] === "StackCollectionViewTriPlatterCell",
    );
    expect(systemCard).toBeDefined();
    expect(systemCard).not.toHaveProperty("role");
  });

  test("returns no Smart Stack for a closed face", () => {
    const face = [
      "Element subtree:",
      " →Application, 0x1, pid: 1, label: 'ClockFace'",
      "    Window, 0x2, {{0.0, 0.0}, {187.0, 223.0}}",
      "      Other, 0x3, {{0.0, 0.0}, {187.0, 223.0}}",
    ].join("\n");
    expect(parseWatchClockFaceDump(face, { timestamp: 0 }).smartStack).toEqual({ cards: [] });
  });
});

describe("parseSmartStackWidgetIdentifier", () => {
  test("resolves a ' -- ' inside the app name from the cell's app label", () => {
    const id =
      "StackCollectionViewComplicationCell -- U -- Probe -- App -- Widget -- dev.a -- dev.a-dev.a.w-k-3";
    expect(parseSmartStackWidgetIdentifier(id, "Probe -- App")).toMatchObject({
      appName: "Probe -- App",
      widgetName: "Widget",
      hostBundleId: "dev.a",
      index: 3,
    });
    expect(parseSmartStackWidgetIdentifier(id)).toMatchObject({
      appName: "Probe",
      widgetName: "App -- Widget",
    });
  });

  test("keeps the raw descriptor when it does not extend the host bundle id", () => {
    const id = "StackCollectionViewComplicationCell -- U -- A -- W -- dev.a -- other-kind-12";
    const parsed = parseSmartStackWidgetIdentifier(id);
    expect(parsed).toMatchObject({ descriptor: "other-kind-12", index: 12 });
    expect(parsed).not.toHaveProperty("extensionBundleId");
  });

  test.each([
    "StackCollectionViewTriPlatterCell",
    "StackCollectionViewComplicationCell -- U -- A -- W -- dev.a",
    "StackCollectionViewComplicationCell -- U -- A -- W -- dev.a -- no-index",
  ])("rejects %s", (id) => {
    expect(parseSmartStackWidgetIdentifier(id)).toBeUndefined();
  });
});

describe("parseXcuiDebugDescription", () => {
  test("reads a quoted label holding an apostrophe and a comma", () => {
    expect(
      parseXcuiDebugLine(
        "    Button, 0x1, {{1.0, 2.0}, {3.0, 4.0}}, label: 'It's 9, ok', Selected",
      ),
    ).toEqual({
      depth: 4,
      type: "Button",
      frame: { left: 1, top: 2, right: 4, bottom: 6 },
      label: "It's 9, ok",
    });
  });

  test("keeps a quoted field name inside a label and stops at the next keyed field", () => {
    expect(
      parseXcuiDebugLine("  StaticText, 0x1, label: 'Reading 'high', value matters', value: '7'"),
    ).toMatchObject({ label: "Reading 'high', value matters", value: "7" });
  });

  test("gives a frameless line its parent's frame", () => {
    const dump = [
      "Element subtree:",
      " →Application, 0x1, pid: 1",
      "    Window, 0x2, {{0.0, 0.0}, {10.0, 20.0}}",
      "      Other, label: 'inner'",
      "Path to element:",
      " →Application, 0x9",
    ].join("\n");
    const tree = parseXcuiDebugDescription(dump, { bundleId: "b", timestamp: 0 });
    expect(tree.root.children?.[0].children).toEqual([
      expect.objectContaining({
        accessibilityLabel: "inner",
        bounds: { left: 0, top: 0, right: 10, bottom: 20 },
        children: [],
      }),
    ]);
  });

  test("rejects a dump with no element subtree", () => {
    expect(() =>
      parseXcuiDebugDescription("Attributes: Application", { bundleId: "b", timestamp: 0 }),
    ).toThrow(ActionableError);
  });
});
