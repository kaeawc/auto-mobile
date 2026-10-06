import { expect, spyOn, test } from "bun:test";
import type { ViewHierarchyResult } from "../../../src/models";
import * as imeSession from "../../../src/features/action/InstalledImeKeySession";
import {
  InstalledImeKeySession,
  tapFrameBoundImeKey,
} from "../../../src/features/action/InstalledImeKeySession";
import { KeyboardOpenIndeterminateError } from "../../../src/features/action/Keyboard";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import {
  AndroidImeCatalog,
  AUTO_MOBILE_IME_ID,
  imeCapabilities,
} from "../../../src/features/action/AndroidImeCatalog";

const original = "com.example.original/.Ime";
const target = "com.example.keyboard/.Ime";
const focused: ViewHierarchyResult = {
  hierarchy: {
    node: {
      $: {
        focused: "true",
        class: "android.widget.EditText",
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      },
    },
  },
};
const keyWindow: ViewHierarchyResult = {
  hierarchy: {
    node: {
      $: {},
      node: [
        {
          $: {
            text: "a",
            "resource-id": "com.example.keyboard:id/key_a",
            bounds: { left: 100, top: 400, right: 140, bottom: 440 },
          },
        },
      ],
    },
  },
  frameContext: "frame-one",
  windows: [
    {
      type: 2,
      packageName: "com.example.keyboard",
      bounds: { left: 0, top: 300, right: 400, bottom: 600 },
    },
  ],
};

let fixtureNumber = 0;
function fixture(
  window: ViewHierarchyResult = keyWindow,
  initial: ViewHierarchyResult = focused,
  afterTap: ViewHierarchyResult = window,
  selectedIme: string = target,
  waitReads?: Array<ViewHierarchyResult | null>,
) {
  const events: string[] = [];
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let active = original;
  let readCount = 0;
  let tapError: string | undefined;
  let restoreError: string | undefined;
  let afterSelection: (() => void) | undefined;
  let selectionSettled: (() => void) | undefined;
  let openCount = 0;
  let afterTapDispatch: (() => void) | undefined;
  let keyboardGate: Promise<void> | undefined;
  let keyboardOutcome:
    | ((signal: AbortSignal | undefined) => Promise<{ success: boolean; error?: string }>)
    | undefined;
  const keyboardSignals: Array<AbortSignal | undefined> = [];
  const deviceId = `native-session-device-${++fixtureNumber}`;
  let subtype: number | null = 7;
  let subtypeRestoreError: string | undefined;
  const enabledIds = new Set([original, selectedIme]);
  const installedIds = new Set(enabledIds);
  const session = new InstalledImeKeySession(deviceId, {
    catalog: {
      list: async () => ({
        activeImeId: active,
        installed: [...installedIds].map((id) => ({
          id,
          enabled: enabledIds.has(id),
          active: id === active,
          capabilities: imeCapabilities(id),
        })),
      }),
      selectWithinLock: async (id, signal) => {
        events.push(`select:${id}:${signal ? "signaled" : "cleanup"}`);
        if (id === original && restoreError) {
          throw new Error(restoreError);
        }
        active = id;
        if (id === selectedIme) {
          selectionSettled?.();
        }
        return {
          activeImeId: active,
          installed: [...installedIds].map((item) => ({
            id: item,
            enabled: enabledIds.has(item),
            active: item === active,
            capabilities: imeCapabilities(item),
          })),
        };
      },
      readSubtype: async (id) => {
        void id;
        return { id: subtype, ...(subtype === null ? {} : { locale: "en_US" }) };
      },
      restoreSubtypeWithinLock: async (id, snapshot) => {
        events.push(`restoreSubtype:${id}:${snapshot.id ?? "unset"}`);
        if (subtypeRestoreError) {
          throw new Error(subtypeRestoreError);
        }
        subtype = snapshot.id;
      },
      identity: async (id, snapshot) => ({
        component: id,
        package: id.split("/")[0],
        ...(snapshot?.locale ? { subtype: snapshot.locale } : {}),
      }),
    },
    keyboard: {
      execute: async (_action, signal) => {
        openCount++;
        keyboardSignals.push(signal);
        afterSelection?.();
        await keyboardGate;
        return keyboardOutcome ? keyboardOutcome(signal) : { success: true };
      },
    },
    hierarchy: {
      read: async () => {
        readCount++;
        if (readCount === 1) {
          return initial;
        }
        if (waitReads?.length) {
          return waitReads[Math.min(readCount - 2, waitReads.length - 1)];
        }
        return readCount === 2 ? window : afterTap;
      },
    },
    tap: {
      execute: async ({ x, y, frameContext }) => {
        events.push(`tap:${x},${y}:${frameContext}`);
        afterTapDispatch?.();
        return tapError ? { success: false, error: tapError } : { success: true };
      },
    },
    timer,
  });
  return {
    session,
    timer,
    deviceId,
    events,
    setKeyboardGate: (gate: Promise<void>) => {
      keyboardGate = gate;
    },
    keyboardSignals,
    getReadCount: () => readCount,
    setKeyboardOutcome: (outcome: NonNullable<typeof keyboardOutcome>) => {
      keyboardOutcome = outcome;
    },
    setTapError: (error: string) => {
      tapError = error;
    },
    setRestoreError: (error: string) => {
      restoreError = error;
    },
    setSubtypeRestoreError: (error: string) => {
      subtypeRestoreError = error;
    },
    setSubtype: (id: number | null) => {
      subtype = id;
    },
    setAfterSelection: (action: () => void) => {
      afterSelection = action;
    },
    setSelectionSettled: (action: () => void) => {
      selectionSettled = action;
    },
    getOpenCount: () => openCount,
    setAfterTapDispatch: (action: () => void) => {
      afterTapDispatch = action;
    },
    getActive: () => active,
    getSubtype: () => subtype,
    getEnabledIds: () => [...enabledIds].sort(),
    setEnabled: (id: string, enabled: boolean) => {
      // External drift hook: the session dependencies deliberately cannot enable/disable.
      installedIds.add(id);
      if (enabled) {
        enabledIds.add(id);
      } else {
        enabledIds.delete(id);
      }
    },
  };
}

const focusedWithoutKey: ViewHierarchyResult = {
  ...focused,
  hierarchy: {
    node: {
      $: {
        ...focused.hierarchy?.node?.$,
        text: "private-editor-text",
      },
    },
  },
  windows: keyWindow.windows,
};
const noFocusOrWindow: ViewHierarchyResult = { hierarchy: { node: { $: {} } } };
const restoreMessage = `Could not restore the original keyboard ${original}; run "keyboard setIme ${original}" or restart the daemon.`;

test.each([
  [
    "editorFocusLost",
    noFocusOrWindow,
    "Focused text input lost focus while waiting for a visible IME key.",
  ],
  [
    "imeWindowDisappeared",
    focused,
    "Selected IME window disappeared while waiting for a visible key.",
  ],
] as const)("restores without tapping after %s mid-wait", async (reason, next, message) => {
  const { session, events, getActive, getSubtype, setAfterSelection, setSubtype } = fixture(
    keyWindow,
    focused,
    keyWindow,
    target,
    [focusedWithoutKey, next],
  );
  setAfterSelection(() => setSubtype(42));
  const error: unknown = await session.tapKey(target, "a").catch((error: unknown) => error);
  expect(error).toMatchObject({ reason, message });
  expect(error).toBeInstanceOf(imeSession.ImeSessionFocusLostError);
  expect(error).not.toBeInstanceOf(AggregateError);
  expect(events).toEqual([
    `select:${target}:cleanup`,
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  expect(getActive()).toBe(original);
  expect(getSubtype()).toBe(7);
});

test("preserves focus loss inside a restore AggregateError and quarantines the device", async () => {
  const { session, events, setRestoreError } = fixture(keyWindow, focused, keyWindow, target, [
    focusedWithoutKey,
    noFocusOrWindow,
  ]);
  setRestoreError("restore rejected");
  const error: unknown = await session.tapKey(target, "a").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) {
    throw new Error("Expected restoration to fail.");
  }
  expect(error.message).toBe(restoreMessage);
  expect(error.errors).toHaveLength(2);
  expect(error.errors[0]).toMatchObject({ reason: "editorFocusLost" });
  expect(error.errors[0]).toBeInstanceOf(imeSession.ImeSessionFocusLostError);
  expect(error.errors[1]).toEqual(new Error("restore rejected"));
  expect(events).toEqual([
    `select:${target}:cleanup`,
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  await expect(session.tapKey(target, "a")).rejects.toThrow("IME state is unknown");
});

test.each([
  ["added", "com.example.third/.Ime", true, "+com.example.third/.Ime"],
  ["removed", target, false, `-${target}`],
] as const)(
  "reports externally %s enabled IME without overwriting drift",
  async (_change, id, enabled, diagnostic) => {
    const {
      session,
      events,
      setAfterSelection,
      setEnabled,
      setSubtype,
      getActive,
      getSubtype,
      getEnabledIds,
    } = fixture();
    setAfterSelection(() => {
      setEnabled(id, enabled);
      setSubtype(42);
    });
    const error: unknown = await session.tapKey(target, "a").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected enabled-set verification to fail.");
    }
    expect(error.message).toBe(restoreMessage);
    expect(error.errors).toEqual([
      new Error(
        `IME state did not return to its original active and enabled state (enabled set drift: ${diagnostic}).`,
      ),
    ]);
    expect(getActive()).toBe(original);
    expect(getSubtype()).toBe(7);
    expect(getEnabledIds().includes(id)).toBe(enabled);
    expect(events).toEqual([
      `select:${target}:cleanup`,
      "tap:120,420:frame-one",
      `select:${original}:cleanup`,
      `restoreSubtype:${original}:7`,
    ]);
    await expect(session.tapKey(target, "a")).rejects.toThrow("IME state is unknown");
  },
);

test("enabled-set diff is empty when enabled components are unchanged", () => {
  const state = {
    activeImeId: original,
    installed: [original, target].map((id) => ({
      id,
      active: id === original,
      enabled: true,
      capabilities: imeCapabilities(id),
    })),
  };
  expect(
    imeSession.diffEnabledSet(state, { ...state, installed: [...state.installed].reverse() }),
  ).toEqual({
    added: [],
    removed: [],
  });
});

test("enabled-set drift diagnostics are bounded even for a long component ID", async () => {
  const { session, setAfterSelection, setEnabled } = fixture();
  const id = `com.example.${"a".repeat(1_000)}/.Ime`;
  setAfterSelection(() => setEnabled(id, true));
  const error: unknown = await session.tapKey(target, "a").catch((error: unknown) => error);
  if (!(error instanceof AggregateError) || !(error.errors[0] instanceof Error)) {
    throw new Error("Expected enabled-set verification to fail.");
  }
  expect(error.errors[0].message).toContain("enabled set drift: +com.example.");
  expect(error.errors[0].message).toEndWith("...).");
  expect(error.errors[0].message.length).toBeLessThanOrEqual(640);
});

test("a successful session has no enabled-set mutations in its dependency contract", async () => {
  const { session, events } = fixture();
  await session.tapKey(target, "a");
  expect(events).toEqual([
    `select:${target}:cleanup`,
    "tap:120,420:frame-one",
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
});

test("null reads preserve wait evidence and a matched key wins over focus loss", async () => {
  const { session, events, timer } = fixture(keyWindow, focused, keyWindow, target, [
    focusedWithoutKey,
    null,
    keyWindow,
  ]);
  await session.tapKey(target, "a");
  expect(events).toContain("tap:120,420:frame-one");
  expect(timer.now()).toBe(200);
});

test("enabled-set diff sorts additions/removals and ignores disabled components", () => {
  const state = (enabledIds: string[]) => ({
    activeImeId: original,
    installed: ["z/.Z", "a/.A", "b/.B", "y/.Y", "disabled/.Ime"].map((id) => ({
      id,
      active: false,
      enabled: enabledIds.includes(id),
      capabilities: imeCapabilities(id),
    })),
  });
  expect(imeSession.diffEnabledSet(state(["y/.Y", "b/.B"]), state(["z/.Z", "a/.A"]))).toEqual({
    added: ["a/.A", "z/.Z"],
    removed: ["b/.B", "y/.Y"],
  });
});

test("taps one observed key in the selected IME window and restores the prior IME", async () => {
  const { session, events, getActive } = fixture();
  expect(await session.tapKey(target, "a")).toEqual({
    imeId: target,
    key: "a",
    x: 120,
    y: 420,
    editorVerification: {
      status: "unavailable",
      reason: "Focused editor identity or text was unavailable before the tap.",
    },
    backend: "installedIme",
    capability: "visibleKeyTap",
    keyboard: { component: target, package: "com.example.keyboard", subtype: "en_US" },
  });
  expect(events).toEqual([
    `select:${target}:cleanup`,
    "tap:120,420:frame-one",
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  expect(getActive()).toBe(original);
});

test("restores after a failed tap", async () => {
  const { session, events, setTapError, getActive } = fixture();
  setTapError("tap rejected");
  await expect(session.tapKey(target, "a")).rejects.toThrow("tap rejected");
  expect(events.at(-1)).toBe(`restoreSubtype:${original}:7`);
  expect(getActive()).toBe(original);
});

test("does not tap an app control when no real IME window contains the key", async () => {
  const fakeWindow: ViewHierarchyResult = {
    hierarchy: { node: { $: { text: "a" } } },
    windows: [{ type: 1, bounds: { left: 0, top: 0, right: 400, bottom: 600 } }],
  };
  const { session, events, timer } = fixture(fakeWindow);
  await expect(session.tapKey(target, "a")).rejects.toMatchObject({
    message: "Selected IME window did not appear within 2000 ms.",
  });
  expect(events.some((event) => event.startsWith("tap:"))).toBe(false);
  expect(events.at(-1)).toBe(`restoreSubtype:${original}:7`);
  expect(timer.now()).toBe(2_000);
  expect(timer.getSleepCallCount()).toBe(20);
});

test("does not tap a key from another IME package", async () => {
  const wrongPackage: ViewHierarchyResult = {
    ...keyWindow,
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              text: "a",
              "resource-id": "com.other.keyboard:id/key_a",
              bounds: { left: 100, top: 400, right: 140, bottom: 440 },
            },
          },
        ],
      },
    },
  };
  const { session, events } = fixture(wrongPackage);
  await expect(session.tapKey(target, "a")).rejects.toMatchObject({
    message: 'Visible key "a" was not found in the selected IME window.',
  });
  expect(events.some((event) => event.startsWith("tap:"))).toBe(false);
});

test("matches a live-shaped Gboard key in the root hierarchy using IME window bounds", async () => {
  const gboard =
    "com.google.android.inputmethod.latin/com.google.android.apps.inputmethod.latin.LatinIME";
  const liveShape: ViewHierarchyResult = {
    frameContext: "gboard-frame",
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "content-desc": "a",
              "resource-id": "com.google.android.inputmethod.latin:id/key_pos_1_0",
              bounds: { left: 5, top: 1808, right: 165, bottom: 1963 },
            },
          },
          {
            $: {
              "content-desc": "a",
              "resource-id": "com.example.app:id/a",
              bounds: { left: 5, top: 5, right: 165, bottom: 105 },
            },
          },
        ],
      },
    },
    windows: [{ type: 2, bounds: { left: 0, top: 1517, right: 1080, bottom: 2400 } }],
  };
  const { session, events } = fixture(liveShape, focused, liveShape, gboard);
  const result = await session.tapKey(gboard, "a");
  expect(result).toMatchObject({ imeId: gboard, key: "a", x: 85, y: 1886 });
  expect(events).toContain("tap:85,1886:gboard-frame");
});

test("collapses a Gboard clickable key and its labeled descendant to the ancestor", async () => {
  const nested: ViewHierarchyResult = {
    ...keyWindow,
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              "content-desc": "a",
              clickable: "true",
              "resource-id": "com.example.keyboard:id/C01",
              bounds: { left: 100, top: 400, right: 140, bottom: 440 },
            },
            node: [
              {
                $: { "resource-id": "com.example.keyboard:id/host" },
                node: [
                  {
                    $: {
                      "content-desc": "a",
                      "resource-id": "com.example.keyboard:id/label",
                      bounds: { left: 110, top: 400, right: 135, bottom: 430 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  const { session, events } = fixture(nested);
  expect(await session.tapKey(target, "a")).toMatchObject({ x: 120, y: 420 });
  expect(events).toContain("tap:120,420:frame-one");
});

test("rejects separate same-label IME keys as ambiguous", async () => {
  const separate: ViewHierarchyResult = {
    ...keyWindow,
    hierarchy: {
      node: {
        $: {},
        node: [
          {
            $: {
              text: "1",
              "resource-id": "com.example.keyboard:id/one",
              bounds: { left: 100, top: 400, right: 140, bottom: 440 },
            },
          },
          {
            $: {
              text: "1",
              "resource-id": "com.example.keyboard:id/other_one",
              bounds: { left: 200, top: 400, right: 240, bottom: 440 },
            },
          },
        ],
      },
    },
  };
  const { session, events } = fixture(separate);
  await expect(session.tapKey(target, "1")).rejects.toThrow("Visible key");
  expect(events.some((event) => event.startsWith("tap:"))).toBe(false);
});

test("matches a resource-id-less key below a marked IME root", async () => {
  const marked: ViewHierarchyResult = {
    ...keyWindow,
    hierarchy: {
      node: {
        $: { extras: { "automobile:imePackage": "com.example.keyboard" } },
        node: [
          { $: { "content-desc": "a", bounds: { left: 100, top: 400, right: 140, bottom: 440 } } },
        ],
      },
    },
  };
  const { session, events } = fixture(marked);
  expect(await session.tapKey(target, "a")).toMatchObject({ x: 120, y: 420 });
  expect(events).toContain("tap:120,420:frame-one");
});

test("refuses a visible key when its hierarchy has no frame context", async () => {
  const { session, events } = fixture({ ...keyWindow, frameContext: undefined });
  await expect(session.tapKey(target, "a")).rejects.toThrow("no frame context");
  expect(events.some((event) => event.startsWith("tap:"))).toBe(false);
});

test("a stale layout rejects the bound tap without fallback and still restores", async () => {
  const { session, events, setTapError } = fixture();
  setTapError("stale frame context");
  await expect(session.tapKey(target, "a")).rejects.toThrow("stale frame context");
  expect(events).toEqual([
    `select:${target}:cleanup`,
    "tap:120,420:frame-one",
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
});

test("default tap sends the captured frame context once and fails closed", async () => {
  const calls: unknown[][] = [];
  const client = {
    requestTapCoordinates: async (...args: unknown[]) => {
      calls.push(args);
      return { success: false, error: "stale frame context" };
    },
  };
  expect(await tapFrameBoundImeKey(client, { x: 120, y: 420, frameContext: "frame-one" })).toEqual({
    success: false,
    error: "stale frame context",
  });
  expect(calls).toEqual([[120, 420, 10, undefined, undefined, "frame-one"]]);
  expect(await tapFrameBoundImeKey(client, { x: 120, y: 420, frameContext: "" })).toEqual({
    success: false,
    error: "The IME key observation has no frame context.",
  });
  expect(calls).toHaveLength(1);
});

test("reports a changed editor without returning its text", async () => {
  const editorBefore: ViewHierarchyResult = {
    hierarchy: {
      node: {
        $: {
          focused: "true",
          class: "android.widget.EditText",
          "resource-id": "com.example:id/input",
          text: "private-before",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        },
      },
    },
  };
  const editorAfter: ViewHierarchyResult = {
    hierarchy: {
      node: {
        $: {
          focused: "true",
          class: "android.widget.EditText",
          "resource-id": "com.example:id/input",
          text: "private-after",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        },
      },
    },
  };
  const { session } = fixture(keyWindow, editorBefore, editorAfter);
  const result = await session.tapKey(target, "a");
  expect(result.editorVerification).toEqual({ status: "changed" });
  expect(JSON.stringify(result)).not.toContain("private-");
});

test("does not claim a key produced text when the focused editor is unchanged", async () => {
  const editor: ViewHierarchyResult = {
    hierarchy: {
      node: {
        $: {
          focused: "true",
          class: "android.widget.EditText",
          "resource-id": "com.example:id/input",
          text: "same value",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        },
      },
    },
  };
  const { session } = fixture(keyWindow, editor, editor);
  expect((await session.tapKey(target, "a")).editorVerification).toEqual({ status: "unchanged" });
});

test("rejects missing focused input before changing the IME", async () => {
  const { session, events } = fixture(keyWindow, { hierarchy: { node: { $: {} } } });
  await expect(session.tapKey(target, "a")).rejects.toThrow("Focus a text input");
  expect(events).toEqual([]);
});

test("restores the original IME after cancellation", async () => {
  const { session, events, setAfterSelection, getActive } = fixture();
  const controller = new AbortController();
  setAfterSelection(() => controller.abort());
  await expect(session.tapKey(target, "a", controller.signal)).rejects.toThrow();
  expect(events).toEqual([
    `select:${target}:signaled`,
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  expect(getActive()).toBe(original);
});

test("does not open the keyboard when selection completes with cancellation", async () => {
  const { session, events, setSelectionSettled, getOpenCount, getActive } = fixture();
  const controller = new AbortController();
  setSelectionSettled(() => controller.abort());

  await expect(session.tapKey(target, "a", controller.signal)).rejects.toThrow();
  expect(getOpenCount()).toBe(0);
  expect(events).toEqual([
    `select:${target}:signaled`,
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  expect(getActive()).toBe(original);
});

test("hands its abort signal to the keyboard open", async () => {
  const { session, keyboardSignals } = fixture();
  const controller = new AbortController();

  await session.tapKey(target, "a", controller.signal);

  expect(keyboardSignals).toEqual([controller.signal]);
});

test("a cancel during the keyboard open stops before reading or tapping and restores the IME", async () => {
  const { session, events, keyboardSignals, setKeyboardOutcome, getReadCount, getActive } =
    fixture();
  const controller = new AbortController();
  setKeyboardOutcome(async (signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
    // A cancelled open reports a failure result; it must not surface as "did not open".
    return { success: false, error: "Keyboard did not open" };
  });

  await expect(session.tapKey(target, "a", controller.signal)).rejects.toThrow(
    "The operation was aborted",
  );
  expect(keyboardSignals.length).toBe(1);
  // Only the starting-state read happened: no visible-key poll once aborted.
  expect(getReadCount()).toBe(1);
  expect(events).toEqual([
    `select:${target}:signaled`,
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  expect(getActive()).toBe(original);
});

test("a cancel that rejects the keyboard open is rethrown unchanged", async () => {
  const { session, setKeyboardOutcome, getReadCount } = fixture();
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  setKeyboardOutcome(async () => {
    controller.abort(reason);
    throw reason;
  });

  await expect(session.tapKey(target, "a", controller.signal)).rejects.toBe(reason);
  expect(getReadCount()).toBe(1);
});

test("lets an unacknowledged click settle before restoring the IME after an abort", async () => {
  const { session, events, timer, setKeyboardOutcome, getActive } = fixture();
  const controller = new AbortController();
  const failure = new KeyboardOpenIndeterminateError("node click", "request cancelled");
  setKeyboardOutcome(async () => {
    controller.abort();
    throw failure;
  });
  const eventsAtSleep: string[][] = [];
  const sleep = spyOn(timer, "sleep").mockImplementation(async () => {
    eventsAtSleep.push([...events]);
  });

  await expect(session.tapKey(target, "a", controller.signal)).rejects.toBe(failure);

  expect(sleep.mock.calls).toEqual([[500]]);
  // Only the selection had run when the settle wait happened; restoration came after.
  expect(eventsAtSleep).toEqual([[`select:${target}:signaled`]]);
  expect(events).toEqual([
    `select:${target}:signaled`,
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  expect(getActive()).toBe(original);
});

test("does not wait to settle after a plain abort with nothing dispatched", async () => {
  const { session, timer, setKeyboardOutcome } = fixture();
  const controller = new AbortController();
  setKeyboardOutcome(async () => {
    controller.abort();
    throw controller.signal.reason;
  });
  const sleep = spyOn(timer, "sleep");

  await expect(session.tapKey(target, "a", controller.signal)).rejects.toThrow();

  expect(sleep).not.toHaveBeenCalled();
});

test("a keyboard open that fails without a cancel still reports the open failure", async () => {
  const { session, setKeyboardOutcome } = fixture();
  setKeyboardOutcome(async () => ({ success: false, error: "No focused text input" }));

  await expect(session.tapKey(target, "a", new AbortController().signal)).rejects.toThrow(
    "No focused text input",
  );
});

test("reports an applied key when cancellation arrives after physical dispatch", async () => {
  const { session, events, setAfterTapDispatch, getActive } = fixture();
  const controller = new AbortController();
  setAfterTapDispatch(() => controller.abort());

  expect((await session.tapKey(target, "a", controller.signal)).editorVerification).toEqual({
    status: "unavailable",
    reason: "Focused editor identity or text was unavailable before the tap.",
  });
  expect(events).toEqual([
    `select:${target}:signaled`,
    "tap:120,420:frame-one",
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:7`,
  ]);
  expect(getActive()).toBe(original);
});

test("reports unverifiable restoration and quarantines the device", async () => {
  const { session, setRestoreError } = fixture();
  setRestoreError("restore rejected");
  await expect(session.tapKey(target, "a")).rejects.toThrow(
    `Could not restore the original keyboard ${original}`,
  );
  await expect(session.tapKey(target, "a")).rejects.toThrow("IME state is unknown");
});

test("restores an unset subtype after restoring the component", async () => {
  const { session, events, setSubtype } = fixture();
  setSubtype(null);
  const result = await session.tapKey(target, "a");
  expect(result.keyboard).toEqual({ component: target, package: "com.example.keyboard" });
  expect(events.slice(-2)).toEqual([
    `select:${original}:cleanup`,
    `restoreSubtype:${original}:unset`,
  ]);
});

test("subtype restore failure quarantines the device and names the original IME", async () => {
  const { session, events, setSubtypeRestoreError } = fixture();
  setSubtypeRestoreError("subtype no longer advertised");
  await expect(session.tapKey(target, "a")).rejects.toThrow(
    `Could not restore the original keyboard ${original}; run "keyboard setIme ${original}"`,
  );
  expect(events.at(-1)).toBe(`restoreSubtype:${original}:7`);
  await expect(session.tapKey(target, "a")).rejects.toThrow("IME state is unknown");
});

test("AutoMobile IME rejects visible key taps explicitly", async () => {
  const { session, events } = fixture(keyWindow, focused, keyWindow, AUTO_MOBILE_IME_ID);
  await expect(session.tapKey(AUTO_MOBILE_IME_ID, "a")).rejects.toThrow(
    "AutoMobile IME does not support visibleKeyTap",
  );
  expect(events).toEqual([]);
});

test("persistent selection waits for the session's subtype restore under the same device lock", async () => {
  const { session, deviceId, events, setKeyboardGate, setAfterSelection } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let selected!: () => void;
  const selectionReached = new Promise<void>((resolve) => {
    selected = resolve;
  });
  setKeyboardGate(gate);
  setAfterSelection(selected);
  const tap = session.tapKey(target, "a");
  await selectionReached;

  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell ime list -a -s", { stdout: `${original}\n`, stderr: "" });
  adb.setCommandResponse("shell ime list -s", { stdout: `${original}\n`, stderr: "" });
  adb.setCommandResponse("shell settings get secure default_input_method", {
    stdout: original,
    stderr: "",
  });
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args) => {
        events.push(`persistent:${args.join(" ")}`);
        return adb.execute(args);
      },
    },
    deviceId,
  );
  const selection = catalog.select(original);
  await Promise.resolve();
  expect(events.some((event) => event.startsWith("persistent:"))).toBe(false);
  release();
  await tap;
  await selection;
  expect(events.indexOf(`restoreSubtype:${original}:7`)).toBeLessThan(
    events.findIndex((event) => event.startsWith("persistent:")),
  );
});
