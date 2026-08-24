import type { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../src/models";
import type { NotificationUIDetector } from "../../src/utils/interfaces/NotificationUIDetector";

/**
 * Minimal recording fake for {@link NotificationUIDetector}. Mirrors the
 * `executedOperations` / `wasMethodCalled` / `getCallCount` /
 * `clearHistory` pattern used by `FakeTapStrategy` and
 * `FakeSystemConfigurationAdapter`.
 *
 * Configurable result fields let tests stub specific responses
 * (`isTrayOpenResult`, `observationTimestampResult`). The fake records
 * every invocation as a colon-delimited string so tests can assert on
 * substrings via `.includes()`.
 */
export class FakeNotificationUIDetector implements NotificationUIDetector {
  readonly device: BootedDevice;

  isTrayOpenResult: boolean = false;
  observationTimestampResult: number = 0;

  private readonly executedOperations: string[] = [];

  constructor(device?: BootedDevice) {
    this.device =
      device ??
      ({
        deviceId: "fake-device",
        name: "Fake",
        platform: "android",
      } as BootedDevice);
  }

  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  wasMethodCalled(operationName: string): boolean {
    return this.executedOperations.some((op) => op.includes(operationName));
  }

  getCallCount(operationName: string): number {
    return this.executedOperations.filter((op) => op.includes(operationName)).length;
  }

  clearHistory(): void {
    this.executedOperations.length = 0;
  }

  isTrayOpen(viewHierarchy?: ViewHierarchyResult): boolean {
    this.executedOperations.push(`isTrayOpen:${viewHierarchy ? "present" : "absent"}`);
    return this.isTrayOpenResult;
  }

  async expandTray(observation?: ObserveResult): Promise<void> {
    this.executedOperations.push(`expandTray:${observation ? "present" : "absent"}`);
  }

  async collapseTray(observation?: ObserveResult): Promise<void> {
    this.executedOperations.push(`collapseTray:${observation ? "present" : "absent"}`);
  }

  async getObservationTimestamp(): Promise<number> {
    this.executedOperations.push("getObservationTimestamp");
    return this.observationTimestampResult;
  }

  async tapElement(element: Element): Promise<void> {
    this.executedOperations.push(
      `tapElement:${element.bounds?.left ?? "?"},${element.bounds?.top ?? "?"}`,
    );
  }

  async swipeElement(element: Element): Promise<void> {
    this.executedOperations.push(
      `swipeElement:${element.bounds?.left ?? "?"},${element.bounds?.top ?? "?"}`,
    );
  }
}
