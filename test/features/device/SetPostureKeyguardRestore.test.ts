import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { DeviceLockState } from "../../../src/models/DeviceLockState";
import type { WakeAndUnlockResult } from "../../../src/models/WakeAndUnlock";
import { SetPosture } from "../../../src/features/device/SetPosture";
import {
  restoreSwipeKeyguardAfterPostureChange,
  type PostureKeyguardDismisser,
} from "../../../src/features/device/PostureKeyguardRestore";
import { DisplayTransitionTracker } from "../../../src/features/observe/DisplayTransition";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import { setPostureResultSchema } from "../../../src/server/toolOutputSchemas";
import { formatSetPostureMessage } from "../../../src/server/interactionTools";
import { createExecResult } from "../../../src/utils/execResult";
import { logger } from "../../../src/utils/logger";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidHingeAngleConsole } from "../../fakes/FakeAndroidHingeAngleConsole";
import { FakeTimer } from "../../fakes/FakeTimer";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const phoneStates = fixture("phone-states.txt");
const hingeAngleReadBack = fixture("hinge-angle0-get.txt");

const unlocked: DeviceLockState = { locked: false, keyguardShowing: false, secure: false };
const swipeKeyguard: DeviceLockState = { locked: true, keyguardShowing: true, secure: false };
const secureKeyguard: DeviceLockState = { locked: true, keyguardShowing: true, secure: true };

const display = { key: "panel-cover", role: "cover", posture: "closed", generation: 1 } as const;
const lockedObservation = {
  display,
  screenSize: { width: 1080, height: 2364 },
  deviceLock: { locked: true, keyguardShowing: true },
} as ObserveResult;
const unlockedObservation = {
  ...lockedObservation,
  deviceLock: { locked: false, keyguardShowing: false },
} as ObserveResult;

class FakeDismisser implements PostureKeyguardDismisser {
  calls = 0;
  constructor(private readonly outcome: WakeAndUnlockResult | Error) {}
  async execute(): Promise<WakeAndUnlockResult> {
    this.calls += 1;
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    return this.outcome;
  }
}

const dismissed: WakeAndUnlockResult = {
  success: true,
  platform: "android",
  wasAsleep: false,
  wasLocked: true,
  secure: false,
  unlocked: true,
};

function makeDevice(): BootedDevice {
  return {
    name: "Pixel 10 Pro Fold",
    platform: "android",
    deviceId: "emulator-5554",
    displays: { panels: [], postures: ["closed", "opened"] },
  };
}

/** Each observe returns the next queued observation; the last one repeats. */
function harness(options: {
  locks: (DeviceLockState | null)[];
  observations: ObserveResult[];
  dismisser?: PostureKeyguardDismisser;
}) {
  const device = makeDevice();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell cmd device_state print-states", createExecResult(phoneStates, ""));
  adb.setCommandResponse("emu sensor get hinge-angle0", createExecResult(hingeAngleReadBack, ""));
  adb.setDeviceLockSequence(options.locks);
  const tracker = new DisplayTransitionTracker(() => {});
  const queue = [...options.observations];
  let observeCount = 0;
  const observeFactory = () =>
    ({
      execute: async () => {
        observeCount += 1;
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        tracker.notifyTransition(device.deviceId, "fake observed identity change");
        return { ...next, displayRevision: tracker.revision(device.deviceId) };
      },
    }) as ObserveScreen;
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const feature = new SetPosture(device, {
    adbFactory: { create: () => adb },
    androidHingeAngleConsole: new FakeAndroidHingeAngleConsole(),
    observeFactory,
    timer,
    transitionSink: tracker,
    ...(options.dismisser ? { keyguardDismisserFactory: () => options.dismisser! } : {}),
  });
  return { feature, adb, getObserveCount: () => observeCount };
}

describe("setPosture swipe keyguard restore", () => {
  test("dismisses the swipe keyguard a fold raised on an unlocked device", async () => {
    const dismisser = new FakeDismisser(dismissed);
    const { feature, getObserveCount } = harness({
      locks: [unlocked, swipeKeyguard],
      observations: [lockedObservation, lockedObservation, unlockedObservation],
      dismisser,
    });
    const result = await feature.execute("closed");
    expect(dismisser.calls).toBe(1);
    expect(getObserveCount()).toBe(3);
    expect(result).toEqual({
      posture: "closed",
      display: { ...display, generation: 3 },
      locked: false,
      keyguardDismissed: true,
    });
    expect(setPostureResultSchema.safeParse({ message: "m", ...result }).success).toBe(true);
    expect(formatSetPostureMessage(result)).toBe(
      "Set device posture to closed; dismissed the swipe keyguard the change raised (the device was unlocked and has no lock credential)",
    );
  });

  test("the default dismisser clears the swipe keyguard through wm dismiss-keyguard", async () => {
    const { feature, adb } = harness({
      locks: [unlocked, swipeKeyguard, swipeKeyguard, unlocked],
      observations: [lockedObservation, lockedObservation, unlockedObservation],
    });
    const result = await feature.execute("closed");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "emu fold",
      "shell wm dismiss-keyguard",
    ]);
    expect(result).toMatchObject({ locked: false, keyguardDismissed: true });
  });

  test("restores the keyguard state after a hinge-angle change too", async () => {
    const dismisser = new FakeDismisser(dismissed);
    const { feature } = harness({
      locks: [unlocked, swipeKeyguard],
      observations: [lockedObservation, unlockedObservation],
      dismisser,
    });
    const result = await feature.executeHingeAngle(0);
    expect(dismisser.calls).toBe(1);
    expect(result).toMatchObject({ hingeAngle: 0, locked: false, keyguardDismissed: true });
  });

  test.each([
    ["the device was already locked", [swipeKeyguard, swipeKeyguard]],
    ["the pre-change lock state is unknown", [null, swipeKeyguard]],
    ["the raised keyguard is secure", [unlocked, secureKeyguard]],
    [
      "the raised keyguard's security is unknown",
      [unlocked, { locked: true, keyguardShowing: true }],
    ],
  ] as const)("leaves the keyguard up when %s", async (_name, locks) => {
    const dismisser = new FakeDismisser(dismissed);
    const { feature, getObserveCount } = harness({
      locks: [...locks],
      observations: [lockedObservation],
      dismisser,
    });
    const result = await feature.execute("closed");
    expect(dismisser.calls).toBe(0);
    expect(getObserveCount()).toBe(2);
    expect(result).toEqual({
      posture: "closed",
      display: { ...display, generation: 2 },
      locked: true,
    });
  });

  test("does not read the lock again when the change left the device unlocked", async () => {
    const dismisser = new FakeDismisser(dismissed);
    const { feature } = harness({
      locks: [unlocked, swipeKeyguard],
      observations: [
        {
          ...unlockedObservation,
          display: { key: "panel-inner", role: "inner", posture: "opened", generation: 1 },
        } as ObserveResult,
      ],
      dismisser,
    });
    expect(await feature.execute("opened")).toMatchObject({ locked: false });
    expect(dismisser.calls).toBe(0);
  });

  test.each([
    [
      "an unsuccessful dismissal",
      { ...dismissed, success: false, unlocked: false, error: "Swipe keyguard did not dismiss" },
      "Swipe keyguard did not dismiss",
    ],
    ["a thrown dismissal", new Error("adb went away"), "adb went away"],
  ] as const)("warns and reports locked after %s", async (_name, outcome, reason) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { feature } = harness({
        locks: [unlocked, swipeKeyguard],
        observations: [lockedObservation],
        dismisser: new FakeDismisser(outcome),
      });
      const result = await feature.execute("closed");
      expect(result).toMatchObject({ locked: true });
      expect("keyguardDismissed" in result).toBe(false);
      expect(result.warnings).toEqual([
        `The posture change raised the swipe keyguard and dismissing it failed (${reason}). Call wakeAndUnlock before acting.`,
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("an aborted dismissal propagates instead of warning", async () => {
    const controller = new AbortController();
    const adb = new FakeAdbExecutor();
    adb.setDeviceLock(swipeKeyguard);
    const dismisser: PostureKeyguardDismisser = {
      execute: async () => {
        await Promise.resolve();
        controller.abort();
        throw new Error("aborted mid-dismiss");
      },
    };
    await expect(
      restoreSwipeKeyguardAfterPostureChange({
        before: unlocked,
        lockedAfter: true,
        adb,
        dismisser,
        signal: controller.signal,
      }),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
  });
});
