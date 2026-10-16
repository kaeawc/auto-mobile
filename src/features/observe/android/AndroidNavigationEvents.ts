/**
 * Navigation-event bookkeeping for the Android CtrlProxy client: recent user interactions that are
 * attached to the navigation they triggered, interaction listeners, and the serialised
 * navigation-graph write queue. Extracted from `AndroidCtrlProxyClient` (#11846); behaviour is
 * unchanged.
 */
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import type {
  NavigationEvent,
  NavigationGraphManager,
} from "../../navigation/NavigationGraphManager";
import type { InteractionEvent } from "./androidCtrlProxyInboundProtocol";

export const INTERACTION_NAVIGATION_WINDOW_MS = 5_000;
export const MAX_CACHED_INTERACTIONS = 100;

export interface RecentInteraction {
  type: string;
  elementText?: string;
  elementResourceId?: string;
  timestamp: number | undefined;
  receivedAtMs: number;
}

export class AndroidInteractionTracker {
  private readonly interactionListeners = new Set<(event: InteractionEvent) => void>();
  /** Recent interactions keyed by the app package reported on the wire. */
  readonly lastInteractionByApp = new Map<string, RecentInteraction>();

  constructor(private readonly timer: Pick<Timer, "now">) {}

  onInteraction(listener: (event: InteractionEvent) => void): () => void {
    this.interactionListeners.add(listener);
    return () => {
      this.interactionListeners.delete(listener);
    };
  }

  pruneStaleInteractions(now: number): void {
    for (const [applicationId, interaction] of this.lastInteractionByApp) {
      if (
        now < interaction.receivedAtMs ||
        now - interaction.receivedAtMs > INTERACTION_NAVIGATION_WINDOW_MS
      ) {
        this.lastInteractionByApp.delete(applicationId);
      }
    }
  }

  attachRecentInteraction(event: NavigationEvent): void {
    const hostNow = this.timer.now();
    this.pruneStaleInteractions(hostNow);
    const interaction = event.applicationId
      ? this.lastInteractionByApp.get(event.applicationId)
      : undefined;
    if (!interaction) {
      return;
    }
    const receivedAgeMs = hostNow - interaction.receivedAtMs;
    if (receivedAgeMs < 0 || receivedAgeMs > INTERACTION_NAVIGATION_WINDOW_MS) {
      return;
    }
    if (
      typeof event.timestamp === "number" &&
      typeof interaction.timestamp === "number" &&
      event.timestamp < interaction.timestamp
    ) {
      return;
    }
    event.triggeringInteraction = {
      type: interaction.type,
      elementText: interaction.elementText,
      elementResourceId: interaction.elementResourceId,
    };
  }

  notifyInteractionListeners(event: InteractionEvent): void {
    for (const listener of this.interactionListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(`[CTRL_PROXY] Interaction listener error: ${error}`);
      }
    }
  }
}

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
