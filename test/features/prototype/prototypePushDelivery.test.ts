import { describe, expect, test } from "bun:test";
import type { PrototypePushPayload } from "../../../src/features/prototype/prototypePush";
import {
  PROTOTYPE_PUSH_APP_STATES,
  prototypePushDelivery,
} from "../../../src/features/prototype/prototypePushDelivery";

const plain: PrototypePushPayload = { type: "message", data: { id: "m1" } };
const withAlert: PrototypePushPayload = {
  type: "message",
  data: {},
  notification: { title: "Ada", body: "Hi", channel: "chat", group: "dm", badge: 3 },
};

describe("prototypePushDelivery", () => {
  test("the connection route is foreground only while the app is active", () => {
    const deliveries = PROTOTYPE_PUSH_APP_STATES.map(
      (appState) =>
        prototypePushDelivery({ handled: true, payload: plain, appState, route: "connection" })
          .event.data.delivery,
    );
    expect(deliveries).toEqual(["foreground", "background", "background"]);
  });

  test("the system route is a notification delivery in every app state", () => {
    const deliveries = PROTOTYPE_PUSH_APP_STATES.map(
      (appState) =>
        prototypePushDelivery({ handled: false, payload: plain, appState, route: "system" }).event
          .data.delivery,
    );
    expect(deliveries).toEqual(["notification", "notification", "notification"]);
  });

  test("the event names the push type and whether a handler ran", () => {
    expect(
      prototypePushDelivery({
        handled: false,
        payload: plain,
        appState: "background",
        route: "connection",
      }),
    ).toEqual({
      event: {
        event: "notifications.push",
        data: { type: "message", delivery: "background", handled: false },
        simulated: true,
      },
    });
  });

  test("an unhandled push posts its notification as an alert with every field", () => {
    const outcome = prototypePushDelivery({
      handled: false,
      payload: withAlert,
      appState: "active",
      route: "connection",
    });
    expect(outcome.alert).toEqual({
      title: "Ada",
      body: "Hi",
      channel: "chat",
      group: "dm",
      badge: 3,
    });
    expect(outcome.alert).not.toBe(withAlert.notification);
  });

  test("a handled push or one without a notification posts no alert", () => {
    expect(
      prototypePushDelivery({
        handled: true,
        payload: withAlert,
        appState: "active",
        route: "connection",
      }).alert,
    ).toBeUndefined();
    expect(
      prototypePushDelivery({ handled: false, payload: plain, appState: "active", route: "system" })
        .alert,
    ).toBeUndefined();
  });
});
