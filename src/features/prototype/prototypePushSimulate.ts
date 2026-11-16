import { toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { PROTOTYPE_MEDIA_SIM_EVENTS } from "./prototypeFakeMediaEngine";
import { validatePrototypePushPayload, type PrototypePushPayload } from "./prototypePush";

/** The push event `prototype simulate` delivers (#14285). */
export const PROTOTYPE_PUSH_EVENT = "notifications.push";
/** Every platform event `prototype simulate` can deliver: the push and the media events (#14257). */
export const PROTOTYPE_SIMULATE_EVENTS = [
  PROTOTYPE_PUSH_EVENT,
  ...PROTOTYPE_MEDIA_SIM_EVENTS,
] as const;

/** `auto` prefers the live connection and falls back to the system path. */
export const PROTOTYPE_PUSH_TRANSPORTS = ["auto", "connection", "system"] as const;
export type PrototypePushTransport = (typeof PROTOTYPE_PUSH_TRANSPORTS)[number];
export type PrototypePushRouteName = Exclude<PrototypePushTransport, "auto">;

/** How the runtime received the push, as reported on `prototype_platform_event`. */
export const PROTOTYPE_PUSH_DELIVERIES = ["foreground", "background", "notification"] as const;
export type PrototypePushDelivery = (typeof PROTOTYPE_PUSH_DELIVERIES)[number];

export const PROTOTYPE_PUSH_ERROR_CODES = [
  "invalid_args",
  "unavailable",
  "platform_error",
] as const;
export type PrototypePushErrorCode = (typeof PROTOTYPE_PUSH_ERROR_CODES)[number];

export interface PrototypePushReply {
  success: boolean;
  /** True when a `notifications.push` handler ran. */
  handled?: boolean;
  delivery?: PrototypePushDelivery;
  error?: string;
}

/**
 * One way to hand a push to a shown prototype: `connection` is the live runtime frame and
 * `system` is the platform push path that also reaches an app that is not running.
 */
export interface PrototypePushRoute {
  available(): Promise<boolean>;
  deliver(
    id: string,
    payload: PrototypePushPayload,
    timeoutMs?: number,
  ): Promise<PrototypePushReply>;
}

export type PrototypePushRoutes = Partial<Record<PrototypePushRouteName, PrototypePushRoute>>;

export interface PrototypePushRequest {
  id: string;
  data: unknown;
  transport?: PrototypePushTransport;
  timeoutMs?: number;
}

export type PrototypePushSimulateResult =
  | {
      success: true;
      transport: PrototypePushRouteName;
      handled: boolean;
      delivery: PrototypePushDelivery;
    }
  | {
      success: false;
      code: PrototypePushErrorCode;
      error: string;
      transport?: PrototypePushRouteName;
    };

/** The delivery a route implies when its reply does not say. */
const DEFAULT_DELIVERY: Record<PrototypePushRouteName, PrototypePushDelivery> = {
  connection: "foreground",
  system: "notification",
};

/**
 * Validate the payload, pick a route and deliver one simulated push. The payload is checked
 * before any route is asked, so an oversized or malformed push is `invalid_args` on every device.
 */
export async function simulatePrototypePush(
  routes: PrototypePushRoutes,
  request: PrototypePushRequest,
): Promise<PrototypePushSimulateResult> {
  const validation = validatePrototypePushPayload(request.data);
  if (!validation.success) {
    return {
      success: false,
      code: "invalid_args",
      error: `${validation.error.path}: ${validation.error.message}`,
    };
  }
  const chosen = await selectRoute(routes, request.transport ?? "auto");
  if (typeof chosen === "string") {
    return { success: false, code: "unavailable", error: chosen };
  }
  const [name, route] = chosen;
  let reply: PrototypePushReply;
  try {
    reply = await route.deliver(request.id, validation.payload, request.timeoutMs);
  } catch (error) {
    logger.warn(`[prototype] simulated push over ${name} failed`, error);
    return {
      success: false,
      code: "platform_error",
      transport: name,
      error: toActionableError(error, "simulate push failed").message,
    };
  }
  if (!reply.success) {
    return {
      success: false,
      code: "platform_error",
      transport: name,
      error: reply.error ?? "simulate push failed",
    };
  }
  return {
    success: true,
    transport: name,
    handled: reply.handled === true,
    delivery: reply.delivery ?? DEFAULT_DELIVERY[name],
  };
}

async function selectRoute(
  routes: PrototypePushRoutes,
  transport: PrototypePushTransport,
): Promise<[PrototypePushRouteName, PrototypePushRoute] | string> {
  const names: PrototypePushRouteName[] =
    transport === "auto" ? ["connection", "system"] : [transport];
  for (const name of names) {
    const route = routes[name];
    if (route && (await route.available())) {
      return [name, route];
    }
  }
  return transport === "auto"
    ? "simulate push: the prototype runtime is not connected and this device has no system push path. Show the prototype on a device whose runtime advertises prototype_platform_push_v1."
    : `simulate push: the ${transport} transport is not available on this device. Use transport auto to fall back.`;
}
