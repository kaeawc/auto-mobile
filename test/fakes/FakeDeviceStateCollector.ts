import type { DeviceStateCollector } from "../../src/features/observe/collectors/DeviceStateCollector";
import type { ObserveResult } from "../../src/models";

type ObservedState = Pick<
  DeviceStateCollector,
  | "collectBackStack"
  | "collectWakefulness"
  | "collectDeviceLock"
  | "collectActiveWindow"
  | "collectForegroundIdentity"
>;

/** Keeps the older observe fixture's array-shaped back stack unchanged. */
export class FakeDeviceStateCollector implements ObservedState {
  backStackCalls = 0;
  activeWindowCalls = 0;
  deviceLockCalls = 0;

  constructor(private readonly populateState = true) {}

  async collectForegroundIdentity(): Promise<string | undefined> {
    return undefined;
  }

  async collectBackStack(result: ObserveResult): Promise<void> {
    this.backStackCalls++;
    if (this.populateState) {
      Object.assign(result, {
        backStack: [{ activity: "com.example/.MainActivity", taskId: 1 }],
      });
    }
  }

  async collectWakefulness(result: ObserveResult): Promise<void> {
    result.wakefulness = "Awake";
  }

  async collectDeviceLock(result: ObserveResult): Promise<void> {
    this.deviceLockCalls++;
    if (this.populateState) {
      result.deviceLock = { locked: false, keyguardShowing: false, secure: false };
    }
  }

  async collectActiveWindow(result: ObserveResult): Promise<void> {
    this.activeWindowCalls++;
    if (this.populateState) {
      result.activeWindow = {
        appId: "com.example",
        activityName: ".MainActivity",
        layoutSeqSum: 0,
      };
    }
  }
}
