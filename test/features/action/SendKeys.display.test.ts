import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult, ViewHierarchyWindowInfo } from "../../../src/models";
import {
  SendKeys,
  type SendKeysCommand,
  type SendKeysObserver,
} from "../../../src/features/action/SendKeys";
import { runWithSelectedDisplayPin } from "../../../src/features/observe/SessionDisplayContext";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import { buildDisconnectedPanelMessage } from "../../../src/models/DisplayPanel";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, focused } from "./SendKeysTestHarness";

const multiDisplay: BootedDevice = {
  ...android,
  deviceId: "sendkeys-focus-panels",
  displays: {
    panels: [
      { key: "inside", role: "inner", sizePx: { width: 100, height: 100 } },
      { key: "outside", role: "cover", sizePx: { width: 100, height: 100 } },
    ],
    postures: [],
  },
};
const commands: SendKeysCommand[] = [
  { action: "type", text: "hello", mode: "a11y" },
  { action: "clear", mode: "a11y" },
  { action: "key", key: "done" },
];

function harness(device: BootedDevice, key: string, windows?: ViewHierarchyWindowInfo[]) {
  const h = createSendKeysHarness(device);
  h.adb.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:inside" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:outside" type EXTERNAL, real 100 x 100}',
    stderr: "",
  });
  const transitions = new FakeDisplayTransitionReader();
  const observation: ObserveResult = {
    ...focused,
    display: { key, role: "unknown", posture: "unknown", generation: transitions.generation },
    displayRevision: transitions.fullRevision,
    viewHierarchy: { ...focused.viewHierarchy!, displayId: key === "outside" ? 2 : 0, windows },
  };
  const observer = new FakeObserveScreen();
  observer.setObserveResult(observation);
  const focusedSelectors: unknown[] = [];
  const action = new SendKeys(device, new FakeAdbClientFactory(h.adb), {
    timer: new FakeTimer(),
    executor: h.executor,
    observer,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    timestampProvider: { now: async () => 1 },
    focuser: {
      focus: async (selector) => {
        focusedSelectors.push(selector);
        return { success: true };
      },
    },
  });
  return { ...h, device, action, observer, transitions, focusedSelectors };
}

describe("sendKeys selector-less display focus", () => {
  // Session pins are passed to SendKeys as the resolved display argument.
  for (const route of ["pin", "explicit"] as const) {
    const run = (h: ReturnType<typeof harness>, display: string) => {
      const execute = () => h.action.execute(commands, undefined, undefined, undefined, display);
      return route === "pin"
        ? runWithSelectedDisplayPin({ pin: display, inventory: h.device.displays }, execute)
        : execute();
    };

    test(`single-display ${route} dispatches text, clear and IME without a selector`, async () => {
      const h = harness(android, "0");
      expect((await run(h, "0")).success).toBe(true);
      expect(h.inserted).toEqual(["hello"]);
      expect(h.clientCalls).toEqual(["insert:hello", "clear", "ime"]);
      expect(h.focusedSelectors).toEqual([]);
    });

    test(`multi-display ${route} on the focused panel dispatches text, clear and IME`, async () => {
      const h = harness(multiDisplay, "outside", [
        { isFocused: false, panelUniqueId: "local:inside", displayId: 0 },
        { isFocused: true, panelUniqueId: "local:outside", displayId: 2 },
      ]);
      expect((await run(h, "outside")).success).toBe(true);
      expect(h.inserted).toEqual(["hello"]);
      expect(h.clientCalls).toEqual(["insert:hello", "clear", "ime"]);
    });

    test(`multi-display ${route} on an unfocused panel refuses with both panels and fixes`, async () => {
      const h = harness(multiDisplay, "outside", [
        { isFocused: true, panelUniqueId: "local:inside", displayId: 0 },
      ]);
      const result = await run(h, "outside");
      expect(result.success).toBe(false);
      expect(result.error).toContain('display "outside"');
      expect(result.error).toContain('focused panel is "inside"');
      expect(result.error).toContain("tapOn");
      expect(result.error).toContain("setActiveDevice {display: null}");
      expect(h.clientCalls).toEqual([]);
    });
  }

  test("single physical panel and explicit active allow selector-less input", async () => {
    const device = {
      ...multiDisplay,
      displays: { panels: [multiDisplay.displays!.panels[0]], postures: [] },
    };
    for (const display of ["inside", "inner", "active"]) {
      const h = harness(device, "inside");
      expect(
        (await h.action.execute(commands, undefined, undefined, undefined, display)).success,
      ).toBe(true);
      expect(h.clientCalls).toEqual(["insert:hello", "clear", "ime"]);
    }
  });

  test("focused logical display maps to its physical panel for a role selector", async () => {
    const h = harness(multiDisplay, "outside", [{ isFocused: true, displayId: 2 }]);
    expect(
      (await h.action.execute(commands, undefined, undefined, undefined, "cover")).success,
    ).toBe(true);
    expect(h.inserted).toEqual(["hello"]);
  });

  test("multi-display unknown focus refuses even when the captured field reports focused", async () => {
    const h = harness(multiDisplay, "outside");
    const result = await h.action.execute(commands, undefined, undefined, undefined, "outside");
    expect(result.success).toBe(false);
    expect(result.error).toContain('display "outside"');
    expect(result.error).toContain("focused panel is unknown");
    expect(result.error).toContain("tapOn");
    expect(result.error).toContain("setActiveDevice {display: null}");
    expect(h.clientCalls).toEqual([]);
  });

  test("a focused window without panel identity does not inherit the requested panel", async () => {
    const h = harness(multiDisplay, "outside", [{ isFocused: true }]);
    const result = await h.action.execute(commands, undefined, undefined, undefined, "outside");
    expect(result.success).toBe(false);
    expect(result.error).toContain("focused panel is unknown");
    expect(h.clientCalls).toEqual([]);
  });

  test("a transition during focus mapping still fences command dispatch", async () => {
    const h = harness(multiDisplay, "outside", [{ isFocused: true, displayId: 2 }]);
    const execute = h.adb.executeCommand.bind(h.adb);
    let reads = 0;
    h.adb.executeCommand = async (...args) => {
      if (args[0].includes("get-displays") && ++reads === 2) {
        h.transitions.transition();
      }
      return execute(...args);
    };
    const result = await h.action.execute(commands, undefined, undefined, undefined, "outside");
    expect(result.success).toBe(false);
    expect(result.staleDisplay?.retry).toBe("observe");
    expect(h.clientCalls).toEqual([]);
  });

  test("no pin or explicit display preserves focused-field dispatch without display probes", async () => {
    const h = harness(multiDisplay, "outside");
    expect((await h.action.execute(commands)).success).toBe(true);
    expect(h.clientCalls).toEqual(["insert:hello", "clear", "ime"]);
    expect(h.adb.getExecutedCommands().some((command) => command.includes("get-displays"))).toBe(
      false,
    );
    expect(h.observer.getExecuteOptions().every((options) => options?.display === undefined)).toBe(
      true,
    );
  });

  test("a selector still focuses the selected field when panel focus is unknown", async () => {
    const h = harness(multiDisplay, "outside");
    const selector = { text: "Field" };
    expect(
      (await h.action.execute(commands, selector, undefined, undefined, "outside")).success,
    ).toBe(true);
    expect(h.focusedSelectors).toEqual([selector]);
    expect(h.inserted).toEqual(["hello"]);
  });
});

describe("sendKeys Android focus read routing", () => {
  const cases: Array<{ name: string; command: SendKeysCommand; verifiesClear?: boolean }> = [
    { name: "semantic key", command: { action: "key", key: "done" } },
    { name: "clear fallback", command: { action: "clear", mode: "a11y" }, verifiesClear: true },
    { name: "eventLast", command: { action: "type", text: "abc", mode: "eventLast" } },
    { name: "eventAll", command: { action: "type", text: "abc", mode: "eventAll" } },
    { name: "eventOnly", command: { action: "type", text: "abc", mode: "eventOnly" } },
    {
      name: "eventOnly replace",
      command: { action: "type", text: "abc", mode: "eventOnly", operation: "replace" },
      verifiesClear: true,
    },
  ];

  function recordingHarness(expectedDisplay?: string) {
    const transitions = new FakeDisplayTransitionReader();
    const observation: ObserveResult = {
      ...focused,
      display: {
        key: "outside",
        role: "cover",
        posture: "unknown",
        generation: transitions.generation,
      },
      displayRevision: transitions.fullRevision,
      viewHierarchy: {
        ...focused.viewHierarchy!,
        displayId: 2,
        hierarchy: {
          node: { $: { focused: "true", class: "android.widget.EditText", text: "old" } },
        },
        windows: [{ isFocused: true, displayId: 2, panelUniqueId: "local:outside" }],
      },
    };
    const reads: Array<Parameters<SendKeysObserver["execute"]>[0]> = [];
    const observer: SendKeysObserver = {
      execute: async (options) => {
        reads.push(options);
        if (options?.display !== expectedDisplay) {
          return { ...observation, viewHierarchy: undefined };
        }
        return options?.minTimestamp === 0
          ? {
              ...observation,
              viewHierarchy: {
                ...observation.viewHierarchy!,
                hierarchy: {
                  node: { $: { focused: "true", class: "android.widget.EditText", text: "" } },
                },
              },
            }
          : observation;
      },
    };
    const h = createSendKeysHarness(multiDisplay, observer);
    h.adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:inside" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:outside" type EXTERNAL, real 100 x 100}',
      stderr: "",
    });
    h.client.clear = async () => {
      h.clientCalls.push("clear");
      return { success: false, error: "Accessibility clear unavailable" };
    };
    const action = new SendKeys(multiDisplay, new FakeAdbClientFactory(h.adb), {
      executor: h.executor,
      observer,
      timer: new FakeTimer(),
      displayTransitions: transitions,
      lastRenderedObservation: () => observation,
      timestampProvider: { now: async () => 1 },
      focuser: { focus: async () => ({ success: true }) },
    });
    return { ...h, action, observer, reads, transitions };
  }

  for (const route of ["explicit", "explicit selector", "pin", "ambient"] as const) {
    for (const { name, command, verifiesClear } of cases) {
      test(`${route}: ${name} reads only the target display`, async () => {
        const explicit = route === "explicit" || route === "explicit selector";
        const display = explicit ? "cover" : route === "pin" ? "outside" : undefined;
        const h = recordingHarness(display);
        const execute = () =>
          h.action.execute(
            [command],
            route === "explicit selector" ? { text: "Search" } : undefined,
            undefined,
            undefined,
            display,
          );
        const result = await runWithSelectedDisplayPin(
          route === "pin" ? { pin: "cover", inventory: multiDisplay.displays } : undefined,
          execute,
        );
        expect(result.success).toBe(true);
        expect(h.reads.length).toBeGreaterThanOrEqual(verifiesClear ? 3 : 2);
        expect(h.reads.every((options) => options?.display === display)).toBe(true);
        if (route === "ambient") {
          expect(h.reads.every((options) => !Object.hasOwn(options ?? {}, "display"))).toBe(true);
          expect(
            h.adb.getExecutedCommands().some((command) => command.includes("get-displays")),
          ).toBe(false);
        }
        if (verifiesClear) {
          expect(h.reads.some((options) => options?.minTimestamp === 0)).toBe(true);
        }
        if (command.action === "key") {
          expect(h.clientCalls).toContain("ime");
        } else if (command.action === "type") {
          expect(
            h.adb
              .getExecutedCommands()
              .some((command) => /^shell input (keyevent|text) /.test(command)),
          ).toBe(true);
        }
      });
    }
  }

  test("focus, clear verification and final reads skip screenshots on the requested display", async () => {
    const h = recordingHarness("cover");
    h.observer.captureScreenshot = async () => {};
    const result = await h.action.execute(
      [{ action: "type", text: "abc", mode: "eventOnly", operation: "replace" }],
      undefined,
      undefined,
      undefined,
      "cover",
    );
    expect(result.success).toBe(true);
    expect(h.reads.length).toBe(5);
    expect(h.reads[0]).toMatchObject({ display: "cover", skipScreenshot: true });
    expect(h.reads[1]).toMatchObject({ display: "cover", skipScreenshot: true });
    expect(h.reads[2]).toMatchObject({ display: "cover", skipScreenshot: true, minTimestamp: 0 });
    // The eventOnly letter-case read-back (#10404) stays on the requested display.
    expect(h.reads[3]).toMatchObject({ display: "cover", skipScreenshot: true });
    expect(h.reads[4]).toMatchObject({
      display: "cover",
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      minTimestamp: 1,
    });
  });

  test("an explicit display overrides the inherited session pin", async () => {
    const h = recordingHarness("cover");
    const result = await runWithSelectedDisplayPin(
      { pin: "inner", inventory: multiDisplay.displays },
      () =>
        h.action.execute(
          [{ action: "key", key: "done" }],
          undefined,
          undefined,
          undefined,
          "cover",
        ),
    );
    expect(result.success).toBe(true);
    expect(h.reads.every((options) => options?.display === "cover")).toBe(true);
    expect(h.clientCalls).toEqual(["ime"]);
  });

  for (const route of ["explicit", "pin"] as const) {
    test(`${route}: observation disconnection preserves the original message before dispatch`, async () => {
      const h = recordingHarness("cover");
      const error = new DisplaySelectionError(
        buildDisconnectedPanelMessage(
          "outside",
          "cover",
          [{ key: "inside", role: "inner" }],
          true,
          false,
        ),
        {
          disconnectedPanel: {
            panel: multiDisplay.displays!.panels[1],
            connectedPanels: [{ key: "inside", role: "inner" }],
            hasPostures: true,
          },
        },
      );
      h.observer.execute = async () => {
        throw error;
      };
      const result = await runWithSelectedDisplayPin(
        route === "pin" ? { pin: "cover", inventory: multiDisplay.displays } : undefined,
        () => h.action.execute(commands, undefined, undefined, undefined, "cover"),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        route === "pin"
          ? 'Display "outside" (cover) is not connected in the current posture. Connected panels: inside (inner). Target a connected panel, omit display, or use display: "active"; to make this panel available, change the device posture with setPosture {posture: "closed"}. Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), or select another display explicitly.'
          : 'Display "outside" (cover) is not connected in the current posture. Connected panels: inside (inner). Target a connected panel, omit display, or use display: "active"; to make this panel available, change the device posture with setPosture {posture: "closed"}.',
      );
      expect(Object.hasOwn(result, "staleDisplay")).toBe(false);
      if (route === "pin") {
        expect(result.pinnedDisplay).toEqual({
          pin: "cover",
          availablePanels: [{ key: "inside", role: "inner" }],
        });
      } else {
        expect(Object.hasOwn(result, "pinnedDisplay")).toBe(false);
      }
      expect(h.deliveries).toEqual([]);
      expect(h.clientCalls).toEqual([]);
      expect(h.adb.getExecutedCommands().some((command) => command.includes("input "))).toBe(false);
    });

    test(`${route}: a disconnected requested display refuses before any dispatch`, async () => {
      const h = recordingHarness("cover");
      h.adb.setCommandResponse("cmd display get-displays", {
        stdout: 'Display id 0: DisplayInfo{uniqueId "local:inside" type INTERNAL, real 100 x 100}',
        stderr: "",
      });
      const result = await runWithSelectedDisplayPin(
        route === "pin" ? { pin: "cover", inventory: multiDisplay.displays } : undefined,
        () => h.action.execute(commands, undefined, undefined, undefined, "cover"),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Display "outside" (cover) is not connected');
      expect(Object.hasOwn(result, "staleDisplay")).toBe(false);
      expect(h.deliveries).toEqual([]);
      expect(h.clientCalls).toEqual([]);
      expect(h.adb.getExecutedCommands().some((command) => command.includes("input "))).toBe(false);
    });
  }
});
