import type { Socket } from "node:net";
import { logger } from "../../utils/logger";
import type { DeviceSessionResolver } from "../deviceSessionResolver";
import type { SubscriptionResponse, Subscriber } from "../socketServer/index";
import type {
  DeviceDataFilter,
  OnScreenshotCadenceChangedCallback,
  OnHierarchyCadenceChangedCallback,
} from "./streamContracts";

export interface StreamCadenceHost {
  getSubscribers(): Iterable<Subscriber<DeviceDataFilter>>;
  findFilter(socket: Socket, subscriptionId: string): DeviceDataFilter | undefined;
  getDeviceSessionResolver(): DeviceSessionResolver;
  isSocketIdentityStale(socket: Socket): boolean;
  hasSubscriberForDevice(deviceId: string): boolean;
  sendJson(socket: Socket, message: SubscriptionResponse): void;
}

const DEFAULT_SCREENSHOT_INTERVAL_MS = 3000;

export const DEFAULT_HIERARCHY_INTERVAL_MS = 1000;

const MIN_SCREENSHOT_INTERVAL_MS = 250;

const MIN_HIERARCHY_INTERVAL_MS = 250;

const MAX_SCREENSHOT_INTERVAL_MS = 2_147_483_647;

const MAX_HIERARCHY_INTERVAL_MS = 2_147_483_647;

// With no live-view subscriber, the host must NOT instruct the runner to poll
// the (expensive) accessibility hierarchy at the fast default cadence. Send this
// effectively-paused interval instead and rely on the on-demand
// `request_hierarchy_if_stale` path for observes; a subscriber appearing
// restores fast cadence via the same cadence-refresh call. This mirrors the
// screenshot stream, which is already `hasSubscriberForDevice`-gated (#5472).
const PAUSED_HIERARCHY_INTERVAL_MS = MAX_HIERARCHY_INTERVAL_MS;

export type { DeviceDataFilter } from "./streamContracts";

/** Owns cadence validation, active-subscriber polling queries, and cadence notifications. */
export class StreamCadence {
  constructor(private readonly host: StreamCadenceHost) {}

  private onScreenshotCadenceChanged: OnScreenshotCadenceChangedCallback | null = null;
  private onHierarchyCadenceChanged: OnHierarchyCadenceChangedCallback | null = null;

  /**
   * Set a callback to be invoked when subscription cadence may have changed.
   */
  setOnScreenshotCadenceChanged(callback: OnScreenshotCadenceChangedCallback): void {
    this.onScreenshotCadenceChanged = callback;
  }

  /**
   * Set a callback to be invoked when active hierarchy polling cadence may have changed.
   */
  setOnHierarchyCadenceChanged(callback: OnHierarchyCadenceChangedCallback): void {
    this.onHierarchyCadenceChanged = callback;
  }

  /**
   * Return true when at least one active subscriber would receive updates for this device.
   */
  hasSubscriberForDevice(deviceId: string): boolean {
    for (const subscriber of this.host.getSubscribers()) {
      if (
        subscriber.backfilling ||
        subscriber.socket.destroyed ||
        this.host.isSocketIdentityStale(subscriber.socket)
      ) {
        continue;
      }

      if (this.subscriberWantsDevice(subscriber.filter, deviceId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether a subscription's serial-scoped cadence applies to this device. This is
   * the POLLING question (which serial to poll, how fast), kept separate from frame
   * routing (`matchesFilter`, on `deviceSessionUuid`): the cadence machinery is
   * inherently serial-addressed, and `filter.deviceId` is the serial resolved for
   * exactly this purpose. Only a `null` `deviceSessionUuid` means all devices;
   * a non-null UUID with a null `deviceId` schedules none.
   */
  private subscriberWantsDevice(filter: DeviceDataFilter, deviceId: string): boolean {
    return (
      filter.deviceSessionUuid === null ||
      (filter.deviceId === deviceId &&
        this.host.getDeviceSessionResolver().resolveUuid(deviceId) === filter.deviceSessionUuid)
    );
  }

  /**
   * Return the fastest active screenshot cadence requested for this device,
   * or the default low-cost keepalive cadence when none is requested.
   */
  getScreenshotIntervalMsForDevice(deviceId: string): number {
    return this.getFastestIntervalMsForDevice(
      deviceId,
      DEFAULT_SCREENSHOT_INTERVAL_MS,
      (filter) => filter.screenshotIntervalMs,
      true,
    );
  }

  /**
   * Return the fastest active hierarchy cadence requested for this device,
   * or the default iOS hierarchy polling cadence when none is requested.
   */
  getHierarchyIntervalMsForDevice(
    deviceId: string,
    defaultIntervalMs: number = DEFAULT_HIERARCHY_INTERVAL_MS,
  ): number {
    // Subscriber-gate the hierarchy cadence: with no active subscriber, pause
    // runner polling entirely (observes still refresh on demand via
    // request_hierarchy_if_stale) rather than falling back to the 1Hz default.
    if (!this.host.hasSubscriberForDevice(deviceId)) {
      return PAUSED_HIERARCHY_INTERVAL_MS;
    }
    return this.getFastestIntervalMsForDevice(
      deviceId,
      defaultIntervalMs,
      (filter) => filter.hierarchyIntervalMs,
      false,
    );
  }

  private getFastestIntervalMsForDevice(
    deviceId: string,
    defaultIntervalMs: number,
    getRequestedIntervalMs: (filter: DeviceDataFilter) => number | null,
    useDefaultWhenRequestMissing: boolean,
  ): number {
    let fastestIntervalMs: number | null = null;

    for (const subscriber of this.host.getSubscribers()) {
      if (subscriber.backfilling || subscriber.socket.destroyed) {
        continue;
      }

      if (!this.subscriberWantsDevice(subscriber.filter, deviceId)) {
        continue;
      }

      const requestedIntervalMs = getRequestedIntervalMs(subscriber.filter);
      if (requestedIntervalMs === null && !useDefaultWhenRequestMissing) {
        continue;
      }
      const intervalMs = requestedIntervalMs ?? defaultIntervalMs;

      fastestIntervalMs =
        fastestIntervalMs === null ? intervalMs : Math.min(fastestIntervalMs, intervalMs);
    }

    return fastestIntervalMs ?? defaultIntervalMs;
  }

  handleCadenceUpdate(
    socket: Socket,
    request: {
      id?: string;
      subscriptionId?: string;
      screenshotIntervalMs?: unknown;
      hierarchyIntervalMs?: unknown;
    },
  ): void {
    const filter = request.subscriptionId
      ? this.host.findFilter(socket, request.subscriptionId)
      : undefined;
    if (!filter) {
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: request.subscriptionId
          ? `subscriptionId '${request.subscriptionId}' is not active; resubscribe before updating cadence`
          : "subscriptionId is required; resubscribe before updating cadence",
      };
      this.host.sendJson(socket, errorResponse);
      return;
    }

    filter.screenshotIntervalMs = this.parseScreenshotIntervalMs(request.screenshotIntervalMs);
    filter.hierarchyIntervalMs = this.parseHierarchyIntervalMs(request.hierarchyIntervalMs);
    const response: SubscriptionResponse = {
      id: request.id,
      type: "subscription_response",
      success: true,
    };
    this.host.sendJson(socket, response);
    this.notifyCadenceChangedForFilter(filter);
  }

  parseScreenshotIntervalMs(value: unknown): number | null {
    return this.parseClampedIntervalMs(
      value,
      MIN_SCREENSHOT_INTERVAL_MS,
      MAX_SCREENSHOT_INTERVAL_MS,
    );
  }

  parseHierarchyIntervalMs(value: unknown): number | null {
    return this.parseClampedIntervalMs(value, MIN_HIERARCHY_INTERVAL_MS, MAX_HIERARCHY_INTERVAL_MS);
  }

  private parseClampedIntervalMs(
    value: unknown,
    minIntervalMs: number,
    maxIntervalMs: number,
  ): number | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return null;
    }

    return Math.min(Math.max(Math.round(value), minIntervalMs), maxIntervalMs);
  }

  notifyScreenshotCadenceChanged(deviceId: string | null): void {
    this.notifyCadenceChanged(
      this.onScreenshotCadenceChanged,
      "onScreenshotCadenceChanged",
      deviceId,
    );
  }

  notifyHierarchyCadenceChanged(deviceId: string | null): void {
    this.notifyCadenceChanged(
      this.onHierarchyCadenceChanged,
      "onHierarchyCadenceChanged",
      deviceId,
    );
  }

  notifyCadenceChangedForFilter(filter: DeviceDataFilter): void {
    if (filter.deviceSessionUuid !== null && filter.deviceId === null) {
      return;
    }
    this.notifyScreenshotCadenceChanged(filter.deviceId);
    this.notifyHierarchyCadenceChanged(filter.deviceId);
  }

  private notifyCadenceChanged(
    callback: ((deviceId: string | null) => void) | null,
    callbackName: string,
    deviceId: string | null,
  ): void {
    if (!callback) {
      return;
    }

    try {
      callback(deviceId);
    } catch (error) {
      logger.warn(`[DeviceDataStream] Error in ${callbackName} callback: ${error}`);
    }
  }
}
