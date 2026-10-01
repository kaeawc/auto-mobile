import { expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../../src/models";
import {
  InstalledImeKeySession,
  tapFrameBoundImeKey,
} from "../../../src/features/action/InstalledImeKeySession";
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
  const deviceId = `native-session-device-${++fixtureNumber}`;
  let subtype: number | null = 7;
  let subtypeRestoreError: string | undefined;
  const session = new InstalledImeKeySession(deviceId, {
    catalog: {
      list: async () => ({
        activeImeId: active,
        installed: [original, selectedIme].map((id) => ({
          id,
          enabled: true,
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
          installed: [original, selectedIme].map((item) => ({
            id: item,
            enabled: true,
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
      execute: async () => {
        openCount++;
        afterSelection?.();
        await keyboardGate;
        return { success: true };
      },
    },
    hierarchy: {
      read: async () => (++readCount === 1 ? initial : readCount === 2 ? window : afterTap),
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
  };
}

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
  await expect(session.tapKey(target, "a")).rejects.toThrow(
    "Selected IME window did not appear within 2000 ms.",
  );
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
  await expect(session.tapKey(target, "a")).rejects.toThrow(
    'Visible key "a" was not found in the selected IME window.',
  );
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
