import { describe, expect, test } from "bun:test";
import {
  MAX_WORKSPACE_PAGES,
  refreshLauncherForShortcut,
  type LauncherRefreshDriver,
} from "../../../src/features/prototype/launcherRefresh";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeLauncherRefreshGate } from "../../fakes/FakeLauncherRefreshGate";
import { capturedLauncherHierarchy } from "../../helpers/capturedLauncherHierarchy";

const LABEL = "VQ Pin One";
const PIXEL = "com.google.android.apps.nexuslauncher";
const api34 = await capturedLauncherHierarchy("android-launcher-home/api34-page2-uiautomator.xml");
const api37 = await capturedLauncherHierarchy("android-launcher-home/api37-page2-uiautomator.xml");

function driver(
  options: {
    pages?: ViewHierarchyResult[];
    afterRestart?: ViewHierarchyResult[];
    launcher?: string | null;
    failRestart?: boolean;
    gate?: FakeLauncherRefreshGate;
    deviceKey?: string;
    restarting?: () => Promise<void>;
  } = {},
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const restarts: string[] = [];
  let page = 0;
  let swipes = 0;
  let pages = options.pages ?? [api34];
  const gate = options.gate ?? new FakeLauncherRefreshGate();
  const capture = new FakeHierarchyCapture(() => pages[page], "android", timer);
  const value: LauncherRefreshDriver = {
    capture,
    timer,
    gate,
    deviceKey: options.deviceKey ?? "android:test",
    swipeWorkspaceToNextPage: async () => {
      swipes++;
      page = Math.min(page + 1, pages.length - 1);
    },
    resolveLauncher: async () => (options.launcher === undefined ? PIXEL : options.launcher),
    restartLauncher: async (pkg) => {
      if (options.failRestart) {
        throw new Error("force-stop refused");
      }
      restarts.push(pkg);
      await options.restarting?.();
      pages = options.afterRestart ?? pages;
      page = 0;
    },
  };
  return { value, restarts, timer, gate, capture, swipes: () => swipes };
}

describe("refreshLauncherForShortcut", () => {
  test("does nothing when the shortcut is already visible", async () => {
    const d = driver();
    expect(await refreshLauncherForShortcut(d.value, { label: LABEL })).toEqual({
      launcherRestarted: false,
      shortcutVisible: true,
    });
    expect(d.swipes()).toBe(0);
    expect(d.restarts).toEqual([]);
  });

  for (const [api, capture] of [
    [34, api34],
    [37, api37],
  ] as const) {
    test(`finds API ${api} page 2 without restarting`, async () => {
      // Reuse captured nodes for the preceding workspace; omit only the pin on its first read.
      const d = driver({ pages: [api === 34 ? api37 : api34, capture] });
      // The posted captures both contain the pin, so model its absence in memory.
      const original = d.value.capture;
      let first = true;
      d.value.capture = {
        capture: async (request) => {
          const snapshot = await original.capture(request);
          if (!first) {
            return snapshot;
          }
          first = false;
          return {
            ...snapshot,
            nodes: snapshot.nodes.filter(
              (node) => node.properties.text !== LABEL && node.properties["content-desc"] !== LABEL,
            ),
          };
        },
      };
      expect(await refreshLauncherForShortcut(d.value, { label: LABEL })).toEqual({
        launcherRestarted: false,
        shortcutVisible: true,
      });
      expect(d.swipes()).toBe(1);
      expect(d.restarts).toEqual([]);
      expect(d.timer.getSleepHistory()).toEqual([250, 250]);
    });
  }

  test("scans again from page 1 after one restart", async () => {
    const d = driver({ pages: [api34], afterRestart: [api34, api37] });
    expect(await refreshLauncherForShortcut(d.value, { label: "Settings" })).toEqual({
      launcherRestarted: true,
      shortcutVisible: true,
    });
    expect(d.restarts).toEqual([PIXEL]);
    expect(d.swipes()).toBe(2);
  });

  test("missing label restarts once and reports the all-pages scan", async () => {
    const d = driver({ pages: [api34, api37] });
    const outcome = await refreshLauncherForShortcut(d.value, { label: "Missing" });
    expect(outcome).toMatchObject({ launcherRestarted: true, shortcutVisible: false });
    expect(outcome.message).toContain("all home screen pages");
    expect(d.restarts).toEqual([PIXEL]);
    expect(d.swipes()).toBe(4);
  });

  test("a repeated page stops the scan", async () => {
    const d = driver({ launcher: null });
    await refreshLauncherForShortcut(d.value, { label: "Missing" });
    expect(d.swipes()).toBe(1);
    expect(d.capture.requests).toHaveLength(3);
  });

  test("scan is bounded at ten pages even when every settled page differs", async () => {
    const d = driver({ launcher: null });
    const capture = d.value.capture;
    let reads = 0;
    d.value.capture = {
      capture: async (request) => {
        const snapshot = await capture.capture(request);
        const page = Math.ceil(reads++ / 2);
        return { ...snapshot, nodes: snapshot.nodes.slice(0, snapshot.nodes.length - page) };
      },
    };
    await refreshLauncherForShortcut(d.value, { label: "Missing" });
    expect(MAX_WORKSPACE_PAGES).toBe(10);
    expect(d.swipes()).toBe(MAX_WORKSPACE_PAGES - 1);
    expect(reads).toBe(2 * MAX_WORKSPACE_PAGES - 1);
  });

  test("reports failed restart and releases ownership", async () => {
    const d = driver({ failRestart: true });
    const outcome = await refreshLauncherForShortcut(d.value, { label: "Missing" });
    expect(outcome).toMatchObject({ launcherRestarted: false, shortcutVisible: false });
    expect(outcome.message).toContain("force-stop refused");
    expect(d.gate.releases).toEqual(["android:test"]);
  });

  for (const launcher of ["com.vendor.mystery", null]) {
    test(`leaves ${launcher ?? "unresolved"} launcher alone`, async () => {
      const d = driver({ launcher });
      const outcome = await refreshLauncherForShortcut(d.value, { label: "Missing" });
      expect(outcome.launcherRestarted).toBe(false);
      expect(outcome.message).toContain(launcher ?? "unresolved");
      expect(d.restarts).toEqual([]);
    });
  }

  test("concurrent refresh scans but refuses restart, then ownership is released", async () => {
    const gate = new FakeLauncherRefreshGate();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const first = driver({
      gate,
      restarting: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    const running = refreshLauncherForShortcut(first.value, { label: "Missing" });
    await entered.promise;
    const second = driver({ gate });
    const outcome = await refreshLauncherForShortcut(second.value, { label: "Missing" });
    expect(outcome).toMatchObject({ launcherRestarted: false, shortcutVisible: false });
    expect(outcome.message).toContain("another prototype save");
    expect(second.swipes()).toBe(1);
    expect(second.restarts).toEqual([]);
    const other = driver({ gate, deviceKey: "android:other" });
    expect(
      (await refreshLauncherForShortcut(other.value, { label: "Missing" })).launcherRestarted,
    ).toBe(true);
    finish.resolve();
    await running;
    expect(
      (await refreshLauncherForShortcut(second.value, { label: "Missing" })).launcherRestarted,
    ).toBe(true);
  });

  test("capture failure releases ownership", async () => {
    const d = driver();
    d.value.capture = new FakeHierarchyCapture(() => {
      throw new Error("capture failed");
    });
    await expect(refreshLauncherForShortcut(d.value, { label: "Missing" })).rejects.toThrow(
      "capture failed",
    );
    expect(d.gate.releases).toEqual(["android:test"]);
  });
});
