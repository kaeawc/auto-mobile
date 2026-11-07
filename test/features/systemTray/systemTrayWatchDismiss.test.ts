import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { SystemTray } from "../../../src/features/systemTray/SystemTray";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/systemTrayHelpers";
import {
  watchNodes,
  watchStreamRoot,
} from "../../../src/features/systemTray/helpers/watchHierarchy";
import { capturedLauncherHierarchy } from "../../helpers/capturedLauncherHierarchy";
import { buildObserveResult } from "../../helpers/observeFixture";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const watch: BootedDevice = {
  deviceId: "fake-watch",
  name: "watch",
  platform: "android",
  formFactor: "watch",
};
const SWIPE = "shell input swipe 192 176 364 176 300";
// Centre of the captured X button, [19,92][128,260].
const TAP_X = "shell input tap 73 176";
const closed = buildObserveResult({
  updatedAt: 0,
  screenSize: { width: 384, height: 384 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: { hierarchy: { node: { $: { bounds: "[0,0][384,384]" } } } },
});
let single: ObserveResult;
let revealed: ObserveResult;
let emptied: ObserveResult;

beforeAll(async () => {
  single = {
    ...closed,
    viewHierarchy: await capturedLauncherHierarchy(
      "wear/systemtray/notification-stream-single-card.xml",
    ),
  };
  const revealedHierarchy = await capturedLauncherHierarchy(
    "wear/systemtray/notification-stream-dismiss-revealed.xml",
  );
  revealed = { ...closed, viewHierarchy: revealedHierarchy };
  // Models removal by pruning the captured container; not a second device capture.
  const prunedHierarchy = structuredClone(revealedHierarchy);
  const root = watchStreamRoot(prunedHierarchy);
  for (const node of root ? watchNodes(root) : []) {
    if (node.$?.["resource-id"] === "com.google.android.clockwork.sysui:id/trayview_container") {
      node.node = [];
    }
  }
  emptied = { ...closed, viewHierarchy: prunedHierarchy };
});
afterEach(resetSystemTrayDependencies);

function setup(read: (commands: string[]) => ObserveResult) {
  const adb = new FakeAdbExecutor();
  const observer = new FakeObserveScreen();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  observer.setObserveResult(() => read(adb.getExecutedCommands()));
  setSystemTrayDependencies({ adbFactory: () => adb, observeScreenFactory: () => observer, timer });
  return { adb, tray: new SystemTray(watch) };
}

describe("Wear OS 7 dismiss reveals the X button", () => {
  test("taps the revealed X after the swipe and confirms the removal", async () => {
    const { adb, tray } = setup((commands) =>
      commands.includes(TAP_X) ? emptied : commands.includes(SWIPE) ? revealed : single,
    );
    const result = await tray.execute({
      action: "dismiss",
      notification: { title: "Zebra" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf(TAP_X)).toBeGreaterThan(commands.indexOf(SWIPE));
  });

  test("does not claim dismissal when the X tap leaves the card in place", async () => {
    const { tray } = setup((commands) => (commands.includes(SWIPE) ? revealed : single));
    const result = await tray.execute({
      action: "dismiss",
      notification: { title: "Zebra" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
  });
});
