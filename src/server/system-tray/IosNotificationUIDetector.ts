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
  nodeHasIosNotificationCenterHint,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
  traverseForHint,
} from "./notificationHints";

export interface IosNotificationUIDetectorDeps {
  requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
  ): Promise<{ success: boolean }>;
  requestTapCoordinates(x: number, y: number): Promise<{ success: boolean }>;
  /** Host-side monotonic clock used as the iOS observation timestamp. */
  now(): number;
}

const IOS_OPEN_SWIPE_DURATION_MS = SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS;
const IOS_CLOSE_SWIPE_DURATION_MS = SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS;

/**
 * iOS implementation of {@link NotificationUIDetector}. NotificationCenter
 * is hosted by SpringBoard, so the predicate first gates on the
 * observation's `packageName` containing "springboard" before scanning
 * for any of the known NotificationCenter class / identifier hints.
 *
 * Expand and collapse are vertical swipes anchored at the screen's
 * mid-X. The detector requires the caller to pass the most recent
 * observation so it can read `screenSize` — without dimensions there
 * is no safe gesture path on iOS and the operation aborts.
 */
export class IosNotificationUIDetector implements NotificationUIDetector {
  readonly device: BootedDevice;
  private readonly deps: IosNotificationUIDetectorDeps;

  constructor(device: BootedDevice, deps: IosNotificationUIDetectorDeps) {
    this.device = device;
    this.deps = deps;
  }

  isTrayOpen(viewHierarchy?: ViewHierarchyResult): boolean {
    if (!viewHierarchy) {
      return false;
    }
    const packageName = (viewHierarchy as any).packageName ?? "";
    if (!packageName.includes("springboard")) {
      return false;
    }
    const rootNodes = getHierarchyRoots(viewHierarchy);
    return rootNodes.some((root) => traverseForHint(root, nodeHasIosNotificationCenterHint));
  }

  async expandTray(observation?: ObserveResult): Promise<void> {
    const { width, height } = this.requireScreenSize(observation, "open");
    await this.deps.requestSwipe(
      Math.floor(width * 0.5),
      5,
      Math.floor(width * 0.5),
      Math.floor(height * 0.7),
      IOS_OPEN_SWIPE_DURATION_MS,
    );
  }

  async collapseTray(observation?: ObserveResult): Promise<void> {
    const { width, height } = this.requireScreenSize(observation, "close");
    await this.deps.requestSwipe(
      Math.floor(width * 0.5),
      Math.floor(height * 0.65),
      Math.floor(width * 0.5),
      Math.floor(height * 0.08),
      IOS_CLOSE_SWIPE_DURATION_MS,
    );
  }

  async getObservationTimestamp(): Promise<number> {
    return this.deps.now();
  }

  async tapElement(element: Element): Promise<void> {
    const geometry = new DefaultElementGeometry();
    const center = geometry.getElementCenter(element);
    await this.deps.requestTapCoordinates(center.x, center.y);
  }

  async swipeElement(element: Element): Promise<void> {
    const geometry = new DefaultElementGeometry();
    const { startX, startY, endX, endY } = geometry.getSwipeWithinBounds("left", element.bounds);
    await this.deps.requestSwipe(
      Math.floor(startX),
      Math.floor(startY),
      Math.floor(endX),
      Math.floor(endY),
      SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
    );
  }

  private requireScreenSize(
    observation: ObserveResult | undefined,
    action: "open" | "close",
  ): { width: number; height: number } {
    const width = observation?.screenSize?.width;
    const height = observation?.screenSize?.height;
    if (!width || !height) {
      throw new ActionableError(
        action === "open"
          ? "Screen dimensions required to open iOS Notification Center"
          : "Screen dimensions required to close iOS Notification Center",
      );
    }
    return { width, height };
  }
}
