/**
 * Serialised navigation-graph write queue for the Android CtrlProxy client. Extracted from
 * `AndroidCtrlProxyClient` (#11846); behaviour is unchanged.
 */
import type {
  NavigationEvent,
  NavigationGraphManager,
} from "../../navigation/NavigationGraphManager";

export interface AndroidNavigationWriteQueueContext {
  readonly deviceId: string;
  getNavigationGraphManager(): Pick<NavigationGraphManager, "recordNavigationEvent">;
}

export class AndroidNavigationWriteQueue {
  private navigationWriteTail: Promise<void> = Promise.resolve();

  constructor(private readonly context: AndroidNavigationWriteQueueContext) {}

  enqueue(received: NavigationEvent): Promise<void> {
    const navigationGraphManager = this.context.getNavigationGraphManager();
    // Stamp the device that received the event: the manager's telemetry must not read the
    // recorder's ambient context, which another device's client may have set (#10195).
    const event: NavigationEvent = { ...received, deviceId: this.context.deviceId };
    const navWrite = this.navigationWriteTail.then(
      () => navigationGraphManager.recordNavigationEvent(event),
      () => navigationGraphManager.recordNavigationEvent(event),
    );
    // A failed event remains observable to its handler, but cannot permanently block later
    // navigation frames from reaching the graph.
    this.navigationWriteTail = navWrite.catch(() => undefined);
    return navWrite;
  }
}
