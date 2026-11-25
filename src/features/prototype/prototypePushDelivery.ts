import type { PrototypePushPayload } from "./prototypePush";
import {
  PROTOTYPE_PUSH_EVENT,
  type PrototypePushDelivery,
  type PrototypePushRouteName,
} from "./prototypePushSimulate";

/** The `platformRuntime.appState` values a runtime reports when it receives a push. */
export const PROTOTYPE_PUSH_APP_STATES = ["active", "inactive", "background"] as const;
export type PrototypePushAppState = (typeof PROTOTYPE_PUSH_APP_STATES)[number];

export interface PrototypePushDeliveryInput {
  /** True when the spec has a `notifications.push` handler under `platform.on`. */
  handled: boolean;
  payload: PrototypePushPayload;
  appState: PrototypePushAppState;
  /** `connection` is the live runtime frame; `system` is the platform push path. */
  route: PrototypePushRouteName;
}

/**
 * The `prototype_platform_event` payload a runtime emits for one simulated push. A type alias, not
 * an interface, so it stays assignable to `PrototypeJson`.
 */
export type PrototypePushDeliveredEvent = {
  event: typeof PROTOTYPE_PUSH_EVENT;
  data: { type: string; delivery: PrototypePushDelivery; handled: boolean };
  simulated: true;
};

/** A plain alert the runtime posts for a push no handler took. */
export type PrototypePushAlert = NonNullable<PrototypePushPayload["notification"]>;

export interface PrototypePushDeliveryOutcome {
  event: PrototypePushDeliveredEvent;
  alert?: PrototypePushAlert;
}

/**
 * What a runtime reports and posts for one simulated push (#14285), the reference the Kotlin and
 * Swift `PrototypePushDelivery` twins copy; all three replay `test/fixtures/prototype-spec/push`.
 * `notification` is the system route's delivery; on the connection route an active app is
 * `foreground` and an inactive or background one is `background`. A push no handler takes posts
 * its `notification`, if it has one, as a plain alert.
 */
export function prototypePushDelivery(
  input: PrototypePushDeliveryInput,
): PrototypePushDeliveryOutcome {
  const event: PrototypePushDeliveredEvent = {
    event: PROTOTYPE_PUSH_EVENT,
    data: {
      type: input.payload.type,
      delivery: deliveryOf(input.route, input.appState),
      handled: input.handled,
    },
    simulated: true,
  };
  const notification = input.payload.notification;
  if (input.handled || notification === undefined) {
    return { event };
  }
  return { event, alert: { ...notification } };
}

function deliveryOf(
  route: PrototypePushRouteName,
  appState: PrototypePushAppState,
): PrototypePushDelivery {
  if (route === "system") {
    return "notification";
  }
  return appState === "active" ? "foreground" : "background";
}
