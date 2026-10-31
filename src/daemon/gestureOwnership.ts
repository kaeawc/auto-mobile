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
  /**
   * The session that held the device when the start was admitted; undefined for a start on a
   * device no session held. The stroke is that holder's use of the device: it is lifted when the
   * holder is released, or when the device has changed hands by a later frame (#11448).
   */
  holderSessionId?: string;
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
 * A stroke also never outlives the device holder it was admitted under (#11448):
 * {@link cancelAllHeldBy} lifts a released session's strokes, {@link cancelIfDeviceChangedHands}
 * lifts one whose device has a different holder by the time a later frame is refused, a start
 * whose holder left the device before the ack is cancelled instead of recorded, and
 * {@link cancelAllUnheldOn} lifts the strokes no session held when a session acquires their
 * device (#11541).
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
   * is already gone, cancels the gesture immediately instead and records nothing. The same holds
   * when `admissionStillHolds` is false: the holder the start was admitted under left the device
   * while the ack was awaited, so its release-time lift found nothing to lift (#11541). The caller
   * evaluates it synchronously with this call, so no release can land between the two.
   *
   * @param socketSessionId - The socket that started the gesture
   * @param targetDevice - The device the gesture runs on
   * @param gestureId - The acked gesture
   * @param options.holderSessionId - The device holder the start was admitted under
   * @param options.admissionStillHolds - False when that holder left while the ack was awaited
   */
  async onStartAcked(
    socketSessionId: string,
    targetDevice: BootedDevice,
    gestureId: string,
    {
      holderSessionId,
      admissionStillHolds = true,
    }: { holderSessionId?: string; admissionStillHolds?: boolean } = {},
  ): Promise<"owned" | "cancelled"> {
    if (!admissionStillHolds || !this.deps.isSocketLive(socketSessionId)) {
      await this.cancelOne(targetDevice, gestureId, socketSessionId);
      return "cancelled";
    }
    const forSocket = this.bySocket.get(socketSessionId) ?? new Map<string, OwnedGesture>();
    forSocket.set(GestureOwnershipRegistry.key(targetDevice.deviceId, gestureId), {
      targetDevice,
      gestureId,
      ...(holderSessionId !== undefined ? { holderSessionId } : {}),
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

  /**
   * Cancel every open gesture admitted under `holderSessionId`, whichever socket owns it: the
   * session was released, so its device is free for the next owner and must not be handed over
   * with the pointer down. Ownership is dropped before the first cancel is awaited, so a later
   * socket close or refused frame issues no second cancel. Best-effort; never throws.
   */
  async cancelAllHeldBy(holderSessionId: string): Promise<void> {
    await this.cancelAllMatching((gesture) => gesture.holderSessionId === holderSessionId);
  }

  /** Lift only the strokes admitted under a holder on the device it just left (#11667). */
  async cancelAllHeldByOn(holderSessionId: string, deviceId: string): Promise<void> {
    await this.cancelAllMatching(
      (gesture) =>
        gesture.holderSessionId === holderSessionId && gesture.targetDevice.deviceId === deviceId,
    );
  }

  /**
   * Cancel every open gesture on `deviceId` that was admitted while no session held the device: a
   * session has just acquired it, and sessionless work must not keep driving a device for its new
   * holder (#10829, #11541). Strokes admitted under a session are left to that session's release.
   * Ownership is dropped before the first cancel is awaited. Best-effort; never throws.
   */
  async cancelAllUnheldOn(deviceId: string): Promise<void> {
    await this.cancelAllMatching(
      (gesture) =>
        gesture.holderSessionId === undefined && gesture.targetDevice.deviceId === deviceId,
    );
  }

  private async cancelAllMatching(matches: (gesture: OwnedGesture) => boolean): Promise<void> {
    const lifted: Array<OwnedGesture & { socketSessionId: string }> = [];
    for (const [socketSessionId, forSocket] of this.bySocket) {
      for (const [key, gesture] of forSocket) {
        if (matches(gesture)) {
          forSocket.delete(key);
          lifted.push({ ...gesture, socketSessionId });
        }
      }
      if (forSocket.size === 0) {
        this.bySocket.delete(socketSessionId);
      }
    }
    // Every cancel is handed to the device queue before the first is awaited, so each is ahead
    // of whatever the next holder sends, however long an earlier device takes to answer.
    await Promise.all(
      lifted.map(({ targetDevice, gestureId, socketSessionId }) =>
        this.cancelOne(targetDevice, gestureId, socketSessionId),
      ),
    );
  }

  /**
   * A later frame of a gesture this socket owns was refused. When the device's holder is no longer
   * the one the start was admitted under (the holder was released; another session may have
   * acquired the device), the stroke cannot continue: cancel it and drop ownership. Resolves with
   * whether a cancel was issued. A gesture the socket does not own is never cancelled, so a
   * refused frame cannot lift another socket's stroke. Best-effort; never throws.
   */
  async cancelIfDeviceChangedHands(
    socketSessionId: string,
    deviceId: string,
    gestureId: string,
    currentHolderSessionId: string | undefined,
  ): Promise<boolean> {
    const owned = this.bySocket
      .get(socketSessionId)
      ?.get(GestureOwnershipRegistry.key(deviceId, gestureId));
    if (!owned || owned.holderSessionId === currentHolderSessionId) {
      return false;
    }
    this.onEndAcked(socketSessionId, deviceId, gestureId);
    await this.cancelOne(owned.targetDevice, gestureId, socketSessionId);
    return true;
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
        `Failed to cancel orphaned gesture ${gestureId} on ${targetDevice.deviceId} owned by socket ${socketSessionId}: ${errorMessage(error)}`,
      );
    }
  }
}
