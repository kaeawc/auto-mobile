import { toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { PROTOTYPE_MEDIA_SIM_EVENTS } from "./prototypeFakeMediaEngine";
import { PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY } from "../observe/android/ctrlProxyProtocol/capabilities";
import { PROTOTYPE_PLATFORM_MODULES, prototypePlatformEvent } from "./prototypePlatform";
import type { PrototypeJson } from "./prototypeJson";
import { validatePrototypePushPayload, type PrototypePushPayload } from "./prototypePush";

/** The push event `prototype simulate` delivers (#14285). */
export const PROTOTYPE_PUSH_EVENT = "notifications.push";
/** Events with dedicated push and media simulation routes (#14257). */
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

/** What the `connection` route needs from a shown prototype's runtime transport. */
export interface PrototypePushRuntime {
  supports(capability: string): Promise<boolean>;
  simulatePlatformEvent(
    id: string,
    event: string,
    data: { [key: string]: PrototypeJson },
    timeoutMs?: number,
  ): Promise<{
    success: boolean;
    error?: string | null;
    pushHandled?: unknown;
    pushDelivery?: unknown;
  }>;
}

/**
 * The runtime capabilities a live push needs: platform event injection, the notifications module
 * and the push event's own capability (`prototype_platform_push_v1`), read from the contract.
 */
export const PROTOTYPE_PUSH_CONNECTION_CAPABILITIES: readonly string[] = [
  PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY,
  ...[
    PROTOTYPE_PLATFORM_MODULES.notifications?.capability,
    prototypePlatformEvent(PROTOTYPE_PUSH_EVENT)?.definition.capability,
  ].filter((capability): capability is string => capability !== undefined),
];

function isPushDelivery(value: unknown): value is PrototypePushDelivery {
  return (PROTOTYPE_PUSH_DELIVERIES as readonly unknown[]).includes(value);
}

/**
 * The `connection` route (#14285): RT-8's `simulate_prototype_platform` frame carrying the push
 * payload as the `notifications.push` event data. It is available only while the runtime
 * advertises every {@link PROTOTYPE_PUSH_CONNECTION_CAPABILITIES}; the reply's `pushHandled` and
 * `pushDelivery` are kept only when well-typed, so a runtime that omits them falls back to the
 * route default.
 */
export function prototypePushConnectionRoute(runtime: PrototypePushRuntime): PrototypePushRoute {
  return {
    async available() {
      for (const capability of PROTOTYPE_PUSH_CONNECTION_CAPABILITIES) {
        if (!(await runtime.supports(capability))) {
          return false;
        }
      }
      return true;
    },
    async deliver(id, payload, timeoutMs) {
      const reply = await runtime.simulatePlatformEvent(
        id,
        PROTOTYPE_PUSH_EVENT,
        { ...payload },
        timeoutMs,
      );
      return {
        success: reply.success,
        ...(typeof reply.pushHandled === "boolean" ? { handled: reply.pushHandled } : {}),
        ...(isPushDelivery(reply.pushDelivery) ? { delivery: reply.pushDelivery } : {}),
        ...(typeof reply.error === "string" ? { error: reply.error } : {}),
      };
    },
  };
}

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
