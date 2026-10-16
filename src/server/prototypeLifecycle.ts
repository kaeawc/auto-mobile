import type { PrototypeAdbReverseManager } from "../features/prototype/PrototypeAdbReverseManager";
import type { PrototypeEventCoordinator } from "../features/prototype/PrototypeEventCoordinator";

export interface PrototypeEventLifecycle {
  /** `releasedDeviceId` is the device named by the release snapshot, when one exists. */
  subscribeSessionRelease(
    listener: (sessionUuid: string, releasedDeviceId?: string) => void,
  ): () => void;
  subscribeDeviceRemoval(listener: (deviceId: string) => void): () => void;
  /**
   * Returns `undefined` while unbinding cannot be observed yet (the daemon state is not
   * initialised); the host retries on its next registration or call until it subscribes.
   */
  subscribeDeviceUnbound(listener: (deviceId: string) => void): (() => void) | undefined;
  /**
   * What an unbound subscription is bound to (the daemon's current session manager), or
   * `undefined` while unbinding cannot be observed. When it changes (DaemonState reset and
   * re-initialised), the host drops its subscription to the old source and subscribes again.
   * Omitted: the source never changes.
   */
  deviceUnboundSource?(): object | undefined;
}

/**
 * The single lifecycle mechanism: a released session (and the device its snapshot names),
 * a removed device and an unbound device all clear host status and event buffers.
 *
 * The unbound hook may not be available when the host is created (the daemon host is built
 * before DaemonState initialises), so `ensureSubscribed` retries it until it takes, keeping
 * exactly one active unbound subscription. It also follows the hook's source: once DaemonState is
 * re-initialised with a new session manager, the subscription to the old one is dropped and
 * replaced (#10715).
 */
export function subscribePrototypeCleanup(
  lifecycle: PrototypeEventLifecycle,
  events: Pick<PrototypeEventCoordinator, "releaseDevice" | "releaseSession">,
  reverses: PrototypeAdbReverseManager,
): { ensureSubscribed: () => void; unsubscribe: () => void } {
  // The reverses this host created end with the device's prototypes (#12530).
  const releaseDevice = (deviceId: string) => {
    events.releaseDevice(deviceId);
    void reverses.releaseAll(deviceId);
  };
  const cleanups = [
    lifecycle.subscribeSessionRelease((sessionUuid, releasedDeviceId) => {
      events.releaseSession(sessionUuid);
      if (releasedDeviceId) {
        releaseDevice(releasedDeviceId);
      }
    }),
    lifecycle.subscribeDeviceRemoval(releaseDevice),
  ];
  // A lifecycle without a source never re-initialises; one constant stands for it.
  const fixedSource = {};
  let unbound: { source: object; unsubscribe: () => void } | undefined;
  let disposed = false;
  const ensureSubscribed = () => {
    if (disposed) {
      return;
    }
    const source = lifecycle.deviceUnboundSource ? lifecycle.deviceUnboundSource() : fixedSource;
    if (unbound !== undefined && unbound.source === source) {
      return;
    }
    unbound?.unsubscribe();
    unbound = undefined;
    if (source === undefined) {
      return;
    }
    const unsubscribe = lifecycle.subscribeDeviceUnbound(releaseDevice);
    if (unsubscribe) {
      unbound = { source, unsubscribe };
    }
  };
  ensureSubscribed();
  return {
    ensureSubscribed,
    unsubscribe: () => {
      disposed = true;
      unbound?.unsubscribe();
      unbound = undefined;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}
