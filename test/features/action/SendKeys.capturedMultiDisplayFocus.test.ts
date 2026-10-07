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
  { action: "clear" },
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
      // reachable. That branch still has only hand-built coverage (see README).
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
