import { logger } from "../utils/logger";
import { sessionDeviceBinding, type SessionDeviceIdentity } from "./sessionDeviceBinding";
import type { Platform } from "../models";

export const SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD =
  "notifications/automobile/sessionDeviceRebound";

export interface SessionDeviceRebound {
  sessionId: string;
  previousDeviceId: string;
  deviceId: string;
  stableDeviceId?: string;
  avdName?: string;
  generation: number;
}

export interface SessionDeviceReboundEmitter {
  emit(event: SessionDeviceRebound): void;
}

function sessionDeviceRebound(
  session: SessionDeviceIdentity & { platform: Platform },
  previousDeviceId: string,
): SessionDeviceRebound {
  const { sessionUuid, ...binding } = sessionDeviceBinding(session);
  return {
    ...binding,
    sessionId: sessionUuid,
    previousDeviceId,
    ...(session.platform === "android" && binding.stableDeviceId !== undefined
      ? { avdName: binding.stableDeviceId }
      : {}),
  };
}

/** Publication uses an injected sink; notification failures cannot undo a live binding. */
export function publishSessionDeviceRebound(
  emitter: SessionDeviceReboundEmitter | undefined,
  session: SessionDeviceIdentity & { platform: Platform },
  previousDeviceId: string,
): void {
  try {
    emitter?.emit(sessionDeviceRebound(session, previousDeviceId));
  } catch (error) {
    logger.warn("[SessionManager] Failed to announce rebound session device", error);
  }
}

export class SessionDeviceReboundBroadcasterClass implements SessionDeviceReboundEmitter {
  private readonly listeners = new Set<(event: SessionDeviceRebound) => void>();

  subscribe(listener: (event: SessionDeviceRebound) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SessionDeviceRebound): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn("[SessionDeviceReboundBroadcaster] listener failed", error);
      }
    }
  }
}

export const SessionDeviceReboundBroadcaster = new SessionDeviceReboundBroadcasterClass();
