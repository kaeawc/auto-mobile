import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { followIosNotificationTap } from "../../../src/features/systemTray/helpers/iosTapFollowThrough";
import { findIosRevealedOpenAction } from "../../../src/features/systemTray/helpers/hierarchy";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";

// Captured on an iPhone 17 Pro simulator (iOS 27.2) right after systemTray tapped a cover-sheet
// notification: the row slid aside and revealed its "Open" swipe action (#19174).
const revealed = (
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../../fixtures/systemTray/ios-27.2/cover-sheet-row-open-revealed-observe.json",
      ),
      "utf8",
    ),
  ) as { viewHierarchy: ViewHierarchyResult }
).viewHierarchy;

const iphone: BootedDevice = { deviceId: "SIM", name: "iPhone 17 Pro", platform: "ios" };
const tappedRow = { left: 14, top: 680, right: 388, bottom: 746 };
const observation = (viewHierarchy: ViewHierarchyResult): ObserveResult =>
  ({ updatedAt: 1, screenSize: { width: 402, height: 874 }, viewHierarchy }) as ObserveResult;

function recordingSteps(after: ObserveResult) {
  const taps: Element[] = [];
  return {
    taps,
    steps: {
      tap: async (element: Element) => {
        taps.push(element);
      },
      observeAfter: async () => ({ observation: after, settled: true }),
    },
  };
}

describe("iOS cover-sheet notification tap follow-through (#19174)", () => {
  it("finds the revealed Open action inside the tapped row", () => {
    expect(findIosRevealedOpenAction(revealed, tappedRow)?.bounds).toEqual({
      left: 14,
      top: 680,
      right: 104,
      bottom: 746,
    });
  });

  it("ignores an Open action outside the tapped row", () => {
    expect(
      findIosRevealedOpenAction(revealed, { left: 14, top: 0, right: 388, bottom: 219 }),
    ).toBeUndefined();
  });

  it("taps the revealed Open action and reports it", async () => {
    const opened = observation({
      ...revealed,
      packageName: "dev.jasonpearson.automobile.Playground",
    });
    const { taps, steps } = recordingSteps(opened);
    const outcome = await followIosNotificationTap(
      iphone,
      { notification: { title: "MTtitle2" }, appMatchTexts: [] },
      { row: tappedRow, observation: observation(revealed), settled: true },
      steps,
    );
    expect(taps.map((tap) => tap.bounds)).toEqual([
      { left: 14, top: 680, right: 104, bottom: 746 },
    ]);
    expect(outcome.openedThroughAction).toBe(true);
    expect(outcome.observation).toBe(opened);
  });

  it("leaves a tap that already opened the app alone", async () => {
    const app = observation({ ...revealed, packageName: "dev.jasonpearson.automobile.Playground" });
    const { taps, steps } = recordingSteps(app);
    const outcome = await followIosNotificationTap(
      iphone,
      { notification: { title: "MTtitle2" }, appMatchTexts: [] },
      { row: tappedRow, observation: app, settled: true },
      steps,
    );
    expect(taps).toEqual([]);
    expect(outcome.openedThroughAction).toBe(false);
  });

  it("does nothing for an explicit action label or on Android", async () => {
    const { taps, steps } = recordingSteps(observation(revealed));
    const start = { row: tappedRow, observation: observation(revealed), settled: true };
    await followIosNotificationTap(
      iphone,
      { notification: { tapActionLabel: "Reply" }, appMatchTexts: [] },
      start,
      steps,
    );
    await followIosNotificationTap(
      { ...iphone, platform: "android" },
      { notification: { title: "MTtitle2" }, appMatchTexts: [] },
      start,
      steps,
    );
    expect(taps).toEqual([]);
  });
});
