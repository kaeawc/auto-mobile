import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import { DefaultElementGeometry } from "../../features/utility/ElementGeometry";
import type { NotificationUIDetector } from "../../utils/interfaces/NotificationUIDetector";
import {
  getHierarchyRoots,
  nodeHasSystemTrayHint,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
  traverseForHint,
} from "./notificationHints";

export interface AndroidNotificationUIDetectorDeps {
  executeAdbCommand(command: string): Promise<{ stdout: string; stderr: string }>;
  getDeviceTimestampMs(): Promise<number>;
}

/**
 * Android implementation of {@link NotificationUIDetector}. Matches
 * `com.android.systemui` resource-ids / class hints to detect the
 * shade and uses `shell cmd statusbar` for expand / collapse so the
 * gesture is identical regardless of OEM swipe-handle styling.
 *
 * The detector takes a small dependency object rather than the full
 * `SystemTrayDependencies` interface so it can be unit-tested with a
 * minimal fake (see `FakeNotificationUIDetector` for the recording
 * fake used by feature tests).
 */
export class AndroidNotificationUIDetector implements NotificationUIDetector {
  readonly device: BootedDevice;
  private readonly deps: AndroidNotificationUIDetectorDeps;

  constructor(device: BootedDevice, deps: AndroidNotificationUIDetectorDeps) {
    this.device = device;
    this.deps = deps;
  }

  isTrayOpen(viewHierarchy?: ViewHierarchyResult): boolean {
    if (!viewHierarchy) {
      return false;
    }
    const rootNodes = getHierarchyRoots(viewHierarchy);
    return rootNodes.some((root) => traverseForHint(root, nodeHasSystemTrayHint));
  }

  async expandTray(_observation?: ObserveResult): Promise<void> {
    try {
      await this.deps.executeAdbCommand("shell cmd statusbar expand-notifications");
    } catch (error) {
      throw new ActionableError(`Failed to expand system tray: ${error}`);
    }
  }

  async collapseTray(_observation?: ObserveResult): Promise<void> {
    try {
      await this.deps.executeAdbCommand("shell cmd statusbar collapse");
    } catch (error) {
      throw new ActionableError(`Failed to collapse system tray: ${error}`);
    }
  }

  async getObservationTimestamp(): Promise<number> {
    return this.deps.getDeviceTimestampMs();
  }

  async tapElement(element: Element): Promise<void> {
    const geometry = new DefaultElementGeometry();
    const center = geometry.getElementCenter(element);
    await this.deps.executeAdbCommand(`shell input tap ${center.x} ${center.y}`);
  }

  async swipeElement(element: Element): Promise<void> {
    const geometry = new DefaultElementGeometry();
    const { startX, startY, endX, endY } = geometry.getSwipeWithinBounds("left", element.bounds);
    await this.deps.executeAdbCommand(
      `shell input swipe ${Math.floor(startX)} ${Math.floor(startY)} ${Math.floor(endX)} ${Math.floor(endY)} ${SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS}`,
    );
  }
}
