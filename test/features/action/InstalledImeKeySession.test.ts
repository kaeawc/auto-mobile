import { expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../../src/models";
import {
  InstalledImeKeySession,
  tapFrameBoundImeKey,
} from "../../../src/features/action/InstalledImeKeySession";
import { FakeTimer } from "../../fakes/FakeTimer";

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
  const session = new InstalledImeKeySession(`native-session-device-${++fixtureNumber}`, {
    catalog: {
      list: async () => ({
        activeImeId: active,
        installed: [original, selectedIme].map((id) => ({
          id,
          enabled: true,
          active: id === active,
        })),
      }),
      selectWithinLock: async (id, signal) => {
        events.push(`select:${id}:${signal ? "signaled" : "cleanup"}`);
        if (id === original && restoreError) {
          throw new Error(restoreError);
        }
        active = id;
        return {
          activeImeId: active,
          installed: [original, selectedIme].map((item) => ({
            id: item,
            enabled: true,
            active: item === active,
          })),
        };
      },
    },
    keyboard: {
      execute: async () => {
        afterSelection?.();
        return { success: true };
      },
    },
    hierarchy: {
      read: async () => (++readCount === 1 ? initial : readCount === 2 ? window : afterTap),
    },
    tap: {
      execute: async ({ x, y, frameContext }) => {
        events.push(`tap:${x},${y}:${frameContext}`);
        return tapError ? { success: false, error: tapError } : { success: true };
      },
    },
    timer,
  });
  return {
    session,
    events,
    setTapError: (error: string) => {
      tapError = error;
    },
    setRestoreError: (error: string) => {
      restoreError = error;
    },
    setAfterSelection: (action: () => void) => {
      afterSelection = action;
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
  });
  expect(events).toEqual([
    `select:${target}:cleanup`,
    "tap:120,420:frame-one",
    `select:${original}:cleanup`,
  ]);
  expect(getActive()).toBe(original);
});

test("restores after a failed tap", async () => {
  const { session, events, setTapError, getActive } = fixture();
  setTapError("tap rejected");
  await expect(session.tapKey(target, "a")).rejects.toThrow("tap rejected");
  expect(events.at(-1)).toBe(`select:${original}:cleanup`);
  expect(getActive()).toBe(original);
});

test("does not tap an app control when no real IME window contains the key", async () => {
  const fakeWindow: ViewHierarchyResult = {
    hierarchy: { node: { $: { text: "a" } } },
    windows: [{ type: 1, bounds: { left: 0, top: 0, right: 400, bottom: 600 } }],
  };
  const { session, events } = fixture(fakeWindow);
  await expect(session.tapKey(target, "a")).rejects.toThrow("Visible key");
  expect(events.some((event) => event.startsWith("tap:"))).toBe(false);
  expect(events.at(-1)).toBe(`select:${original}:cleanup`);
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
  await expect(session.tapKey(target, "a")).rejects.toThrow("Visible key");
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
  expect(events).toEqual([`select:${target}:signaled`, `select:${original}:cleanup`]);
  expect(getActive()).toBe(original);
});

test("reports unverifiable restoration and quarantines the device", async () => {
  const { session, setRestoreError } = fixture();
  setRestoreError("restore rejected");
  await expect(session.tapKey(target, "a")).rejects.toThrow("could not verify restoration");
  await expect(session.tapKey(target, "a")).rejects.toThrow("IME state is unknown");
});
