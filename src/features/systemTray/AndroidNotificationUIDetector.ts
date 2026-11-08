import {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
  toActionableError,
  ActionableError,
} from "../../models";
import { watchStreamRoot } from "./helpers/watchHierarchy";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
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
    if (this.device.formFactor === "watch") {
      return !!watchStreamRoot(viewHierarchy);
    }
    if (!viewHierarchy) {
      return false;
    }
    const rootNodes = getHierarchyRoots(viewHierarchy);
    return rootNodes.some((root) => traverseForHint(root, nodeHasSystemTrayHint));
  }

  async expandTray(_observation?: ObserveResult): Promise<void> {
    try {
      if (this.device.formFactor === "watch") {
        const width = _observation?.screenSize.width ?? this.device.screenWidth;
        const height = _observation?.screenSize.height ?? this.device.screenHeight;
        if (!width || !height) {
          throw new ActionableError(
            "Watch screen dimensions are unavailable; observe the watch before opening notifications.",
          );
        }
        await this.deps.executeAdbCommand(
          `shell input swipe ${Math.floor(width / 2)} ${Math.floor(height * 0.965)} ${Math.floor(width / 2)} ${Math.floor(height * 0.31)} 900`,
        );
        return;
      }
      await this.deps.executeAdbCommand("shell cmd statusbar expand-notifications");
    } catch (error) {
      throw toActionableError(error, `Failed to expand system tray`);
    }
  }

  async collapseTray(_observation?: ObserveResult): Promise<void> {
    try {
      if (this.device.formFactor === "watch") {
        await this.deps.executeAdbCommand("shell input keyevent 4");
        return;
      }
      await this.deps.executeAdbCommand("shell cmd statusbar collapse");
    } catch (error) {
      throw toActionableError(error, `Failed to collapse system tray`);
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
