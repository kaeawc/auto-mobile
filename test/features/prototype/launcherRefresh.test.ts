import { describe, expect, test } from "bun:test";
import {
  refreshLauncherForShortcut,
  type LauncherRefreshDriver,
} from "../../../src/features/prototype/launcherRefresh";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { pinDialogTree } from "../../helpers/pinDialogTree";

const LABEL = "My proto";
const PIXEL = "com.google.android.apps.nexuslauncher";
const home = (...labels: string[]): ViewHierarchyResult => pinDialogTree(labels);

function driver(options: {
  trees: ViewHierarchyResult[];
  launcher?: string | null;
  failRestart?: boolean;
}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const restarts: string[] = [];
  let reads = 0;
  const value: LauncherRefreshDriver = {
    capture: new FakeHierarchyCapture(
      () => options.trees[Math.min(reads++, options.trees.length - 1)],
      "android",
      timer,
    ),
    timer,
    resolveLauncher: async () => (options.launcher === undefined ? PIXEL : options.launcher),
    restartLauncher: async (pkg) => {
      if (options.failRestart) {
        throw new Error("force-stop refused");
      }
      restarts.push(pkg);
    },
  };
  return { value, restarts };
}

describe("refreshLauncherForShortcut", () => {
  test("does nothing when the shortcut is already visible", async () => {
    const d = driver({ trees: [home("Phone", LABEL)] });
    expect(await refreshLauncherForShortcut(d.value, { label: LABEL })).toEqual({
      launcherRestarted: false,
      shortcutVisible: true,
    });
    expect(d.restarts).toEqual([]);
  });

  test("restarts the resolved launcher once when missing, then confirms it is visible", async () => {
    const d = driver({
      trees: [home("Phone"), home("Phone"), home("Phone", LABEL), home("Phone", LABEL)],
    });
    expect(await refreshLauncherForShortcut(d.value, { label: LABEL })).toEqual({
      launcherRestarted: true,
      shortcutVisible: true,
    });
    expect(d.restarts).toEqual([PIXEL]);
  });

  test("reports a restart that did not surface the shortcut", async () => {
    const d = driver({ trees: [home("Phone")] });
    const outcome = await refreshLauncherForShortcut(d.value, { label: LABEL });
    expect(outcome).toMatchObject({ launcherRestarted: true, shortcutVisible: false });
    expect(outcome.message).toContain("still not visible");
    expect(d.restarts).toEqual([PIXEL]);
  });

  test("reports a failed restart without claiming one happened", async () => {
    const d = driver({ trees: [home("Phone")], failRestart: true });
    const outcome = await refreshLauncherForShortcut(d.value, { label: LABEL });
    expect(outcome).toMatchObject({ launcherRestarted: false, shortcutVisible: false });
    expect(outcome.message).toContain("force-stop refused");
  });

  test("leaves an unknown launcher alone with a clear message", async () => {
    const d = driver({ trees: [home("Phone")], launcher: "com.vendor.mystery" });
    const outcome = await refreshLauncherForShortcut(d.value, { label: LABEL });
    expect(outcome).toMatchObject({ launcherRestarted: false, shortcutVisible: false });
    expect(outcome.message).toContain("com.vendor.mystery");
    expect(d.restarts).toEqual([]);
  });

  test("leaves an unresolved launcher alone", async () => {
    const d = driver({ trees: [home("Phone")], launcher: null });
    const outcome = await refreshLauncherForShortcut(d.value, { label: LABEL });
    expect(outcome.launcherRestarted).toBe(false);
    expect(outcome.message).toContain("unresolved");
  });
});
