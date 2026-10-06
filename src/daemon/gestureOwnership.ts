import type { BootedDevice } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/**
 * A streamed gesture the runner has accepted (a `gestureStart` that acked) but not yet ended,
 * retained so its owning socket can issue a cancelling `gestureEnd` if it tears down mid-drag.
 * [targetDevice] is captured at start so the cancel can be forwarded without re-resolving the
 * device on a socket whose session state is already gone.
 */
export interface OwnedGesture {
  targetDevice: BootedDevice;
  gestureId: string;
}

export interface GestureOwnershipDeps {
  /** True while the socket session is still in the daemon's live client-socket set. */
  isSocketLive: (socketSessionId: string) => boolean;
  /** Best-effort cancelling `gestureEnd` for one gesture, forwarded through the per-device queue. */
  cancelGesture: (targetDevice: BootedDevice, gestureId: string) => Promise<unknown>;
}

/**
 * Streamed gestures currently open on a device, keyed by the SOCKET session that started them,
 * then by `${deviceId}::${gestureId}`. The runner deliberately parks a continued stroke with no
 * duration ceiling, so a socket that goes away before sending its end would leave the on-device
 * touch live indefinitely; the registry therefore guarantees that no gesture is ever recorded
 * under a socket that is not live (issue #10005): a start acked after its socket closed is
 * cancelled on the spot, the same cancellation {@link cancelAllFor} performs at socket close.
 */
export class GestureOwnershipRegistry {
  private readonly bySocket = new Map<string, Map<string, OwnedGesture>>();

  constructor(private readonly deps: GestureOwnershipDeps) {}

  private static key(deviceId: string, gestureId: string): string {
    return `${deviceId}::${gestureId}`;
  }

  /** Number of sockets that currently own at least one gesture (test/diagnostic aid). */
  get ownerCount(): number {
    return this.bySocket.size;
  }

  /**
   * The runner acked a `gestureStart`. Records ownership while the socket is live; when the socket
   * is already gone, cancels the gesture immediately instead and records nothing.
   */
  async onStartAcked(
    socketSessionId: string,
    targetDevice: BootedDevice,
    gestureId: string,
  ): Promise<"owned" | "cancelled"> {
    if (!this.deps.isSocketLive(socketSessionId)) {
      await this.cancelOne(targetDevice, gestureId, socketSessionId);
      return "cancelled";
    }
    const forSocket = this.bySocket.get(socketSessionId) ?? new Map<string, OwnedGesture>();
    forSocket.set(GestureOwnershipRegistry.key(targetDevice.deviceId, gestureId), {
      targetDevice,
      gestureId,
    });
    this.bySocket.set(socketSessionId, forSocket);
    return "owned";
  }

  /** The runner acked a `gestureEnd` (release OR cancel): the gesture is no longer open. */
  onEndAcked(socketSessionId: string, deviceId: string, gestureId: string): void {
    const forSocket = this.bySocket.get(socketSessionId);
    if (!forSocket) {
      return;
    }
    forSocket.delete(GestureOwnershipRegistry.key(deviceId, gestureId));
    if (forSocket.size === 0) {
      this.bySocket.delete(socketSessionId);
    }
  }

  /** Cancel every gesture a closing/erroring socket still owns. Best-effort; never throws. */
  async cancelAllFor(socketSessionId: string): Promise<void> {
    const forSocket = this.bySocket.get(socketSessionId);
    this.bySocket.delete(socketSessionId);
    if (!forSocket) {
      return;
    }
    for (const { targetDevice, gestureId } of forSocket.values()) {
      await this.cancelOne(targetDevice, gestureId, socketSessionId);
    }
  }

  private async cancelOne(
    targetDevice: BootedDevice,
    gestureId: string,
    socketSessionId: string,
  ): Promise<void> {
    try {
      await this.deps.cancelGesture(targetDevice, gestureId);
    } catch (error) {
      logger.warn(
        `Failed to cancel orphaned gesture ${gestureId} on ${targetDevice.deviceId} for closed socket ${socketSessionId}: ${errorMessage(error)}`,
      );
    }
  }
}
