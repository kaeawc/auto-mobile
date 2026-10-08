import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice, ObserveResult, ViewHierarchyWindowInfo } from "../../../src/models";
import { SendKeys, type SendKeysCommand } from "../../../src/features/action/SendKeys";
import { parseAndroidDisplayInfos } from "../../../src/utils/android-cmdline-tools/AndroidDisplayParsers";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { runWithSelectedDisplayPin } from "../../../src/features/observe/SessionDisplayContext";
import { android, createSendKeysHarness, focused } from "./SendKeysTestHarness";

// Captured on a Pixel 10 Pro Fold emulator (API 36), see
// test/fixtures/android-focus-multidisplay/README.md (#9208). Nothing here is hand-built:
// the window list is CtrlProxy's `windows[]`, the display list is `cmd display get-displays`.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-focus-multidisplay", name), "utf8");

interface Capture {
  posture: "open" | "closed";
  role: "inner" | "cover";
  panelKey: string;
  displays: string;
  displayId: number;
  windows: ViewHierarchyWindowInfo[];
}

function loadCapture(posture: "open" | "closed", role: "inner" | "cover"): Capture {
  const displays = fixture(`fold-${posture}-get-displays.txt`);
  const wire = JSON.parse(fixture(`fold-${posture}-ctrlproxy-windows.json`)) as {
    data: { displayId: number; windows: ViewHierarchyWindowInfo[] };
  };
  const uniqueId = parseAndroidDisplayInfos(displays)[0].uniqueId ?? "";
  return {
    posture,
    role,
    panelKey: uniqueId.split(":").slice(1).join(":"),
    displays,
    displayId: wire.data.displayId,
    windows: wire.data.windows,
  };
}

const open = loadCapture("open", "inner");
const closed = loadCapture("closed", "cover");
// Only one panel is connected per posture, so the two-panel inventory is the union of both captures.
const panels = [open, closed].map((capture) => ({
  key: capture.panelKey,
  role: capture.role,
  sizePx: parseAndroidDisplayInfos(capture.displays)[0].sizePx!,
}));
const commands: SendKeysCommand[] = [
  { action: "type", text: "hello", mode: "a11y" },
  { action: "clear", mode: "a11y" },
  { action: "key", key: "done" },
];

function harness(capture: Capture, pinnedKey: string) {
  const device: BootedDevice = {
    ...android,
    deviceId: `captured-fold-${capture.posture}-${pinnedKey}`,
    displays: { panels, postures: [] },
  };
  const h = createSendKeysHarness(device);
  h.adb.setCommandResponse("cmd display get-displays", { stdout: capture.displays, stderr: "" });
  const transitions = new FakeDisplayTransitionReader();
  const pinned = panels.find((panel) => panel.key === pinnedKey)!;
  const observation: ObserveResult = {
    ...focused,
    display: {
      key: pinned.key,
      role: pinned.role,
      posture: "unknown",
      generation: transitions.generation,
    },
    displayRevision: transitions.fullRevision,
    viewHierarchy: {
      ...focused.viewHierarchy!,
      displayId: capture.displayId,
      windows: capture.windows,
    },
  };
  const observer = new FakeObserveScreen();
  observer.setObserveResult(observation);
  const action = new SendKeys(device, new FakeAdbClientFactory(h.adb), {
    timer: new FakeTimer(),
    executor: h.executor,
    observer,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    timestampProvider: { now: async () => 1 },
    focuser: { focus: async () => ({ success: true }) },
  });
  return { ...h, action };
}

describe("sendKeys pinned-panel focus check over captured fold windows (#9208)", () => {
  test("captures are two distinct panels and each posture has exactly one focused window", () => {
    expect(open.panelKey).not.toBe(closed.panelKey);
    for (const capture of [open, closed]) {
      expect(capture.windows.filter((window) => window.isFocused)).toHaveLength(1);
      // CtrlProxy does not emit panelUniqueId on windows yet, so the check must map displayId.
      expect(capture.windows.every((window) => window.panelUniqueId === undefined)).toBe(true);
    }
  });

  for (const [focusedCapture, otherCapture] of [
    [open, closed],
    [closed, open],
  ] as const) {
    describe(`${focusedCapture.role} panel holds focus (${focusedCapture.posture})`, () => {
      test("pin on the focused panel dispatches text, clear and IME", async () => {
        const h = harness(focusedCapture, focusedCapture.panelKey);
        const result = await h.action.execute(
          commands,
          undefined,
          undefined,
          undefined,
          focusedCapture.panelKey,
        );
        expect(result.success).toBe(true);
        expect(h.clientCalls).toEqual(["insert:hello", "clear", "ime"]);
      });

      // The fold emulator connects one panel per posture, so the other panel is refused as
      // disconnected before the pinned-panel-holds-focus branch ("focused panel is ...") is
      // reachable. The concurrent-display captures below cover that branch.
      test("pin on the other (disconnected) panel is refused before the focus check", async () => {
        const h = harness(focusedCapture, otherCapture.panelKey);
        const result = await h.action.execute(
          commands,
          undefined,
          undefined,
          undefined,
          otherCapture.panelKey,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain(`Display "${otherCapture.panelKey}"`);
        expect(result.error).toContain("is not connected in the current posture");
        expect(result.error).toContain(`Connected panels: ${focusedCapture.panelKey}`);
        expect(result.error).not.toContain("focused panel is");
        expect(h.clientCalls).toEqual([]);
      });
    });
  }
});

// Two concurrently connected displays: the fold's inner panel (logical 0) plus an overlay display
// (logical 7, `settings put global overlay_display_devices 1080x1920/320`), captured with focus on
// each in turn (see README). CtrlProxy answers a display-scoped request with only that display's
// windows, so the pinned panel either holds the focused window or has no focused window at all.
type ConcurrentFocus = "inner" | "overlay";

function loadConcurrent(focus: ConcurrentFocus) {
  const displays = fixture(`fold-overlay-focus-${focus}-get-displays.txt`);
  const windowsOn = (logicalId: 0 | 7) =>
    (
      JSON.parse(
        fixture(`fold-overlay-focus-${focus}-display${logicalId}-ctrlproxy-windows.json`),
      ) as { data: { displayId: number; windows: ViewHierarchyWindowInfo[] } }
    ).data;
  return { displays, byLogicalId: { 0: windowsOn(0), 7: windowsOn(7) } };
}

const concurrent = { inner: loadConcurrent("inner"), overlay: loadConcurrent("overlay") };
const concurrentInfos = parseAndroidDisplayInfos(concurrent.inner.displays);
const panelKeyOf = (logicalId: string) =>
  (concurrentInfos.find((info) => info.logicalId === logicalId)?.uniqueId ?? "")
    .split(":")
    .slice(1)
    .join(":");
const innerPanel = { key: panelKeyOf("0"), role: "inner" as const, logicalId: 0 as const };
const overlayPanel = { key: panelKeyOf("7"), role: "external" as const, logicalId: 7 as const };
const concurrentPanels = [innerPanel, overlayPanel].map((panel) => ({
  key: panel.key,
  role: panel.role,
  sizePx: concurrentInfos.find((info) => info.logicalId === String(panel.logicalId))!.sizePx!,
}));

function concurrentHarness(
  focus: ConcurrentFocus,
  pinned: typeof innerPanel | typeof overlayPanel,
) {
  const device: BootedDevice = {
    ...android,
    deviceId: `captured-fold-overlay-${focus}-${pinned.key}`,
    displays: { panels: concurrentPanels, postures: [] },
  };
  const h = createSendKeysHarness(device);
  h.adb.setCommandResponse("cmd display get-displays", {
    stdout: concurrent[focus].displays,
    stderr: "",
  });
  const transitions = new FakeDisplayTransitionReader();
  const capture = concurrent[focus].byLogicalId[pinned.logicalId];
  const observation: ObserveResult = {
    ...focused,
    display: {
      key: pinned.key,
      role: pinned.role,
      posture: "unknown",
      generation: transitions.generation,
    },
    displayRevision: transitions.fullRevision,
    viewHierarchy: {
      ...focused.viewHierarchy!,
      displayId: capture.displayId,
      windows: capture.windows,
    },
  };
  const observer = new FakeObserveScreen();
  observer.setObserveResult(observation);
  const action = new SendKeys(device, new FakeAdbClientFactory(h.adb), {
    timer: new FakeTimer(),
    executor: h.executor,
    observer,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    timestampProvider: { now: async () => 1 },
    focuser: { focus: async () => ({ success: true }) },
  });
  return { ...h, device, action };
}

describe("sendKeys pinned-panel focus check over captured concurrent displays (#9208)", () => {
  test("both displays are connected in both captures and focus is on one display at a time", () => {
    expect(concurrentPanels.map((panel) => panel.key)).toEqual(["4619827259835644672", "1"]);
    expect(parseAndroidDisplayInfos(concurrent.overlay.displays)).toEqual(concurrentInfos);
    for (const [focus, focusedId] of [
      ["inner", 0],
      ["overlay", 7],
    ] as const) {
      const focusedWindows = [0, 7].flatMap((logicalId) =>
        concurrent[focus].byLogicalId[logicalId as 0 | 7].windows.filter(
          (window) => window.isFocused,
        ),
      );
      expect(focusedWindows.map((window) => window.displayId)).toEqual([focusedId]);
      expect(fixture(`fold-overlay-focus-${focus}-window-focus.txt`)).toContain(
        `mTopFocusedDisplayId=${focusedId}`,
      );
    }
  });

  for (const route of ["pin", "explicit"] as const) {
    const run = (h: ReturnType<typeof concurrentHarness>, display: string) => {
      const execute = () => h.action.execute(commands, undefined, undefined, undefined, display);
      return route === "pin"
        ? runWithSelectedDisplayPin({ pin: display, inventory: h.device.displays }, execute)
        : execute();
    };

    for (const [focus, pinned] of [
      ["inner", innerPanel],
      ["overlay", overlayPanel],
    ] as const) {
      test(`${route} on the focused ${focus} display dispatches text, clear and IME`, async () => {
        const h = concurrentHarness(focus, pinned);
        const result = await run(h, pinned.key);
        expect(result.success).toBe(true);
        expect(h.inserted).toEqual(["hello"]);
        expect(h.clientCalls).toEqual(["insert:hello", "clear", "ime"]);
      });
    }

    for (const [focus, pinned] of [
      ["inner", overlayPanel],
      ["overlay", innerPanel],
    ] as const) {
      // The pinned display's window list has no focused window, so the other display's focus is
      // reported as unknown rather than by name; the refusal is what protects the input.
      test(`${route} on the connected but unfocused panel while ${focus} holds focus refuses`, async () => {
        const h = concurrentHarness(focus, pinned);
        const result = await run(h, pinned.key);
        expect(result.success).toBe(false);
        expect(result.error).toContain(`display "${pinned.key}"`);
        expect(result.error).toContain("focused panel is unknown");
        expect(result.error).toContain("tapOn");
        expect(result.error).toContain("setActiveDevice {display: null}");
        expect(h.clientCalls).toEqual([]);
      });
    }
  }
});
