import { expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../../src/models";
import { InstalledImeKeySession } from "../../../src/features/action/InstalledImeKeySession";
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
  hierarchy: { node: { $: {} } },
  windows: [
    {
      type: 2,
      packageName: "com.example.keyboard",
      bounds: { left: 0, top: 300, right: 400, bottom: 600 },
      hierarchy: {
        $: {},
        node: [{ $: { text: "a", bounds: { left: 100, top: 400, right: 140, bottom: 440 } } }],
      },
    },
  ],
};

let fixtureNumber = 0;
function fixture(window: ViewHierarchyResult = keyWindow, initial: ViewHierarchyResult = focused) {
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
        installed: [original, target].map((id) => ({ id, enabled: true, active: id === active })),
      }),
      selectWithinLock: async (id, signal) => {
        events.push(`select:${id}:${signal ? "signaled" : "cleanup"}`);
        if (id === original && restoreError) {
          throw new Error(restoreError);
        }
        active = id;
        return {
          activeImeId: active,
          installed: [original, target].map((item) => ({
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
    hierarchy: { read: async () => (++readCount === 1 ? initial : window) },
    tap: {
      execute: async ({ x, y }) => {
        events.push(`tap:${x},${y}`);
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
  expect(await session.tapKey(target, "a")).toEqual({ imeId: target, key: "a", x: 120, y: 420 });
  expect(events).toEqual([`select:${target}:cleanup`, "tap:120,420", `select:${original}:cleanup`]);
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
    windows: keyWindow.windows?.map((window) => ({ ...window, packageName: "com.other.keyboard" })),
  };
  const { session, events } = fixture(wrongPackage);
  await expect(session.tapKey(target, "a")).rejects.toThrow("Visible key");
  expect(events.some((event) => event.startsWith("tap:"))).toBe(false);
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
