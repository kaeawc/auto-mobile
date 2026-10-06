import { expect, spyOn, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { OpenURL, waitForIosForegroundChange } from "../../../src/features/action/OpenURL";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const observation = (appId: string, isFresh = true): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 200, height: 200 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  activeWindow: { appId, activityName: "Main", layoutSeqSum: 0 },
  freshness: { isFresh, verified: isFresh },
});

const safari = "com.apple.mobilesafari";
const playground = "com.example.Playground";
const simulator = {
  name: "iPhone",
  platform: "ios" as const,
  deviceId: "ABCDEF01-1234-1234-1234-1234567890AB",
};

const openWithForeground = async (url: string, before: string, after: string[]) => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const simctl = new FakeSimCtlClient();
  const observe = new FakeObserveScreen();
  observe.setObserveSequence(after.map((appId) => observation(appId)));
  const interactionSpy = spyOn(
    BaseVisualChange.prototype,
    "observedInteraction",
  ).mockImplementation(async (block) => block(observation(before)));
  const action = new OpenURL(
    simulator,
    new FakeAdbExecutor(),
    simctl as unknown as SimCtlClient,
    null,
    timer,
  );
  action.observeScreen = observe;
  try {
    const result = await action.execute(url);
    return { result, timer, observe, simctl };
  } finally {
    interactionSpy.mockRestore();
  }
};

test("in-app custom deep link returns without confirmation or sleep", async () => {
  const { result, timer, observe } = await openWithForeground("myapp://settings", playground, [
    playground,
  ]);
  expect(result).toEqual({ success: true, url: "myapp://settings" });
  expect(timer.getSleepCallCount()).toBe(0);
  expect(observe.getExecuteCallCount()).toBe(0);
});

test("https from Playground confirms Safari", async () => {
  const { result, timer, observe } = await openWithForeground("https://example.com", playground, [
    safari,
  ]);
  expect(result).toEqual({ success: true, url: "https://example.com" });
  expect(observe.getExecuteCallCount()).toBe(1);
  expect(timer.getSleepCallCount()).toBe(0);
});

test("https universal link confirms as soon as another app is foreground", async () => {
  const { result, timer, observe } = await openWithForeground(
    "https://example.com/item/5",
    "com.apple.springboard",
    [playground],
  );
  expect(result).toEqual({ success: true, url: "https://example.com/item/5" });
  expect(observe.getExecuteCallCount()).toBe(1);
  expect(timer.getSleepCallCount()).toBe(0);
  expect(timer.now()).toBe(0);
});

test("https universal link waits past the unchanged foreground until another app appears", async () => {
  const { result, observe, timer } = await openWithForeground("https://example.com", playground, [
    playground,
    "com.apple.MobileSMS",
  ]);
  expect(result).toEqual({ success: true, url: "https://example.com" });
  expect(observe.getExecuteCallCount()).toBe(2);
  expect(timer.getSleepHistory()).toEqual([100]);
});

test("https already in Safari returns without confirmation or sleep", async () => {
  const { result, timer, observe } = await openWithForeground("https://example.com", safari, [
    safari,
  ]);
  expect(result).toEqual({ success: true, url: "https://example.com" });
  expect(timer.getSleepCallCount()).toBe(0);
  expect(observe.getExecuteCallCount()).toBe(0);
});

test("known handler timeout keeps success and adds the confirmation warning", async () => {
  const { result, timer } = await openWithForeground("https://example.com", playground, [
    playground,
  ]);
  expect(result.success).toBe(true);
  expect(result.warnings).toEqual([
    expect.stringContaining("foreground app change was not confirmed"),
  ]);
  expect(timer.now()).toBe(5_000);
});

test("system scheme still waits for its mapped handler, not any app change", async () => {
  const { result, timer, observe } = await openWithForeground("sms:+15551234567", playground, [
    safari,
    "com.apple.MobileSMS",
  ]);
  expect(result).toEqual({ success: true, url: "sms:+15551234567" });
  expect(observe.getExecuteCallCount()).toBe(2);
  expect(timer.getSleepHistory()).toEqual([100]);
});

test("waits past a stale foreground snapshot until the expected app is foreground", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const snapshots = [observation("old"), observation(safari, false), observation(safari)];
  let reads = 0;
  const confirmed = await waitForIosForegroundChange(
    safari,
    { read: async () => snapshots[reads++]! },
    timer,
  );
  expect(confirmed).toBe(true);
  expect(reads).toBe(3);
  expect(timer.now()).toBe(300);
});

test("reports unconfirmed foreground after a bounded five-second wait", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const confirmed = await waitForIosForegroundChange(
    safari,
    { read: async () => observation("old") },
    timer,
  );
  expect(confirmed).toBe(false);
  expect(timer.now()).toBe(5_000);
});

test("any other verified app confirms when a previous app is given", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const confirmed = await waitForIosForegroundChange(
    safari,
    { read: async () => observation(playground) },
    timer,
    undefined,
    "com.apple.springboard",
  );
  expect(confirmed).toBe(true);
  expect(timer.now()).toBe(0);
});

test("an unchanged previous app is not a confirmation", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const confirmed = await waitForIosForegroundChange(
    safari,
    { read: async () => observation(playground) },
    timer,
    undefined,
    playground,
  );
  expect(confirmed).toBe(false);
  expect(timer.now()).toBe(5_000);
});

test("a stale other-app snapshot does not confirm even with a previous app", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const snapshots = [observation(playground, false), observation(playground)];
  let reads = 0;
  const confirmed = await waitForIosForegroundChange(
    safari,
    { read: async () => snapshots[reads++]! },
    timer,
    undefined,
    "com.apple.springboard",
  );
  expect(confirmed).toBe(true);
  expect(reads).toBe(2);
});
