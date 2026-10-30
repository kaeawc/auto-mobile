import type { TapCoordinatesRequest } from "../observe/shared/SharedGestureDelegate";
import type { SwipeRequest } from "../../utils/interfaces/SwipeRequest";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import type { NotificationUIDetector } from "../../utils/interfaces/NotificationUIDetector";
import {
  getHierarchyRoots,
  hasIosCoverSheetNotificationCenter,
  nodeHasIosNotificationCenterHint,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
  traverseForHint,
} from "./notificationHints";

/**
 * A CtrlProxy gesture result. `dispatched`/`acknowledged` are the host-side markers from
 * `sendIOSPressCommand`: a runner reply (including a refusal) is acknowledged, a timeout or
 * socket close after the write is not.
 */
export interface IosGestureResult {
  success: boolean;
  error?: string;
  dispatched?: boolean;
  acknowledged?: boolean;
}

export interface IosNotificationUIDetectorDeps {
  pressHome?(): Promise<IosGestureResult>;
  requestSwipe(
    request: Pick<SwipeRequest, "x1" | "y1" | "x2" | "y2" | "duration">,
  ): Promise<IosGestureResult>;
  requestTapCoordinates(request: TapCoordinatesRequest): Promise<IosGestureResult>;
  /** Host-side monotonic clock used as the iOS observation timestamp. */
  now(): number;
}

const IOS_OPEN_SWIPE_DURATION_MS = SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS;
const IOS_CLOSE_SWIPE_DURATION_MS = SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS;

/**
 * iOS implementation of {@link NotificationUIDetector}. NotificationCenter
 * is hosted by SpringBoard, so the predicate first gates on the
 * observation's `packageName` containing "springboard" before scanning
 * for legacy NotificationCenter hints or the captured cover-sheet list structure.
 *
 * Expand and legacy collapse use vertical swipes anchored at the screen's
 * mid-X and require `screenSize` from the most recent observation. The iOS 27
 * cover sheet collapses via HOME instead and does not require dimensions.
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
    const packageName = viewHierarchy.packageName ?? "";
    if (!packageName.includes("springboard")) {
      return false;
    }
    const rootNodes = getHierarchyRoots(viewHierarchy);
    return rootNodes.some((root) => traverseForHint(root, nodeHasIosNotificationCenterHint));
  }

  async expandTray(observation?: ObserveResult): Promise<void> {
    const { width, height } = this.requireScreenSize(observation, "open");
    const result = await this.deps.requestSwipe({
      x1: Math.floor(width * 0.5),
      y1: 5,
      x2: Math.floor(width * 0.5),
      y2: Math.floor(height * 0.7),
      duration: IOS_OPEN_SWIPE_DURATION_MS,
    });
    this.requireGestureSuccess(result, "open Notification Center");
  }

  async collapseTray(observation?: ObserveResult): Promise<void> {
    if (
      observation?.viewHierarchy &&
      hasIosCoverSheetNotificationCenter(observation.viewHierarchy)
    ) {
      if (!this.deps.pressHome) {
        throw new ActionableError("Failed to close Notification Center: home press unavailable");
      }
      const result = await this.deps.pressHome();
      this.requireGestureSuccess(result, "close Notification Center");
      return;
    }
    const { width, height } = this.requireScreenSize(observation, "close");
    const result = await this.deps.requestSwipe({
      x1: Math.floor(width * 0.5),
      y1: Math.floor(height * 0.65),
      x2: Math.floor(width * 0.5),
      y2: Math.floor(height * 0.08),
      duration: IOS_CLOSE_SWIPE_DURATION_MS,
    });
    this.requireGestureSuccess(result, "close Notification Center");
  }

  async getObservationTimestamp(): Promise<number> {
    return this.deps.now();
  }

  async tapElement(element: Element): Promise<void> {
    const geometry = new DefaultElementGeometry();
    const center = geometry.getElementCenter(element);
    const result = await this.deps.requestTapCoordinates({ x: center.x, y: center.y });
    this.requireGestureSuccess(result, "tap notification");
  }

  async swipeElement(element: Element): Promise<void> {
    const geometry = new DefaultElementGeometry();
    const { startX, startY, endX, endY } = geometry.getSwipeWithinBounds("left", element.bounds);
    const result = await this.deps.requestSwipe({
      x1: Math.floor(startX),
      y1: Math.floor(startY),
      x2: Math.floor(endX),
      y2: Math.floor(endY),
      duration: SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
    });
    this.requireGestureSuccess(result, "dismiss notification");
  }

  /**
   * A gesture written to the runner whose reply never arrived may already have run (a swipe may
   * have dismissed the notification), so it is indeterminate rather than a plain failure. A runner
   * refusal is acknowledged and a gesture that was never sent is not dispatched; both stay failures.
   */
  private requireGestureSuccess(result: IosGestureResult, gesture: string): void {
    if (!result.success && result.dispatched === true && result.acknowledged !== true) {
      throw new ActionableError(
        `Outcome of ${gesture} is indeterminate: the request was dispatched but no result was confirmed (${result.error || "unknown error"}). Do not retry automatically. Observe before retrying.`,
      );
    }
    if (!result.success) {
      throw new ActionableError(
        `Failed to ${gesture}: ${result.error || "CtrlProxy rejected the gesture"}`,
      );
    }
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
