import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { OVERLAY_MIN_CTRL_PROXY_VERSION } from "../../../../src/features/observe/android/CtrlProxyOverlays";
import type { OverlayEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";
import { ActionableError } from "../../../../src/models/ActionableError";
import { PortManager } from "../../../../src/utils/PortManager";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const }, opacity: 90 },
  root: { type: "text" as const, text: "Hello" },
};
const event = {
  type: "overlay_event",
  timestamp: 42,
  id: "panel",
  sequence: 1,
  kind: "emit",
  name: "next",
  payload: { nested: [true, null] },
  state: { label: "Next", enabled: true },
  pages: { pager: 0 },
};
const clients: AndroidCtrlProxyClient[] = [];
async function harness(
  commands = [
    "full_command_set_v1",
    "request_id_echo_v1",
    "show_overlay",
    "update_overlay",
    "dismiss_overlay",
  ],
) {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "overlay-test", platform: "android", name: "Android", isEmulator: true },
    new FakeAdbExecutor(),
    () => socket,
    timer,
    new FakeInstalledAppsRepository(),
  );
  clients.push(client);
  await Promise.resolve();
  client["ws"] = socket as unknown as WebSocket;
  spyOn(client, "ensureConnected").mockResolvedValue(true);
  const receive = (frame: object) => client["handleWebSocketMessage"](JSON.stringify(frame));
  await receive({ type: "connected", supportedCommands: commands });
  return { client, socket, timer, receive };
}
afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

describe("CtrlProxy overlays", () => {
  test.each(["show_overlay", "update_overlay", "dismiss_overlay"])(
    "sends %s and correlates the result",
    async (type) => {
      const { client, socket, receive } = await harness();
      let finish!: (value: Record<string, unknown>) => void;
      const sent = new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      });
      const send = spyOn(socket, "send").mockImplementation((data) =>
        finish(JSON.parse(String(data))),
      );
      try {
        const pending =
          type === "show_overlay"
            ? client.requestShowOverlay(spec)
            : type === "update_overlay"
              ? client.requestUpdateOverlay({ id: "panel", state: { enabled: false } })
              : client.requestDismissOverlay({ all: true });
        const message = await sent;
        expect(message.type).toBe(type);
        expect(message.requestId).toBeString();
        if (type === "show_overlay") {
          expect(message.spec).toEqual(spec);
        }
        if (type === "update_overlay") {
          expect(message.state).toEqual({ enabled: false });
        }
        if (type === "dismiss_overlay") {
          expect(message.all).toBe(true);
        }
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await receive({
          type: "overlay_result",
          timestamp: 42,
          requestId: "other",
          success: true,
          error: null,
        });
        expect(settled).toBe(false);
        await receive({
          type: "overlay_result",
          timestamp: 42,
          requestId: message.requestId,
          success: false,
          error: "overlay host not wired",
        });
        expect(await pending).toEqual({
          timestamp: 42,
          requestId: message.requestId,
          success: false,
          error: "overlay host not wired",
        });
        expect(client["requestManager"].getPendingCount()).toBe(0);
      } finally {
        send.mockRestore();
      }
    },
  );

  test.each(
    [[], ["full_command_set_v1"], ["full_command_set_v1", "update_overlay", "dismiss_overlay"]].map(
      (commands) => ({ commands }),
    ),
  )("old capabilities $commands throw before sending", async ({ commands }) => {
    const { client, socket } = await harness(commands);
    const send = spyOn(socket, "send");
    try {
      await expect(client.requestShowOverlay(spec)).rejects.toBeInstanceOf(ActionableError);
      await expect(client.requestShowOverlay(spec)).rejects.toThrow("show_overlay");
      await expect(client.requestShowOverlay(spec)).rejects.toThrow(OVERLAY_MIN_CTRL_PROXY_VERSION);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  test("events decode and unsubscribe, independent of request-id echo", async () => {
    const { client, receive } = await harness();
    const received: OverlayEvent[] = [];
    const unsubscribe = client.onOverlayEvent((value) => received.push(value));
    await receive(event);
    expect(received).toEqual([event]);
    unsubscribe();
    await receive({ ...event, sequence: 2 });
    expect(received).toHaveLength(1);
  });

  test("listener errors are logged and other listeners still receive", async () => {
    const { client, receive } = await harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const received: OverlayEvent[] = [];
    try {
      client.onOverlayEvent(() => {
        throw new Error("broken consumer");
      });
      client.onOverlayEvent((value) => received.push(value));
      await receive(event);
      expect(received).toEqual([event]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    { ...event, kind: "unknown" },
    { ...event, sequence: -1 },
    { ...event, sequence: 1.5 },
    { ...event, state: { bad: null } },
    { ...event, requestId: "unsolicited-must-not-correlate" },
    { ...event, id: null },
    { ...event, payload: undefined, name: undefined },
  ])("malformed event is logged and dropped", async (frame) => {
    const { client, receive } = await harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const received: OverlayEvent[] = [];
    try {
      client.onOverlayEvent((value) => received.push(value));
      await expect(receive(frame)).resolves.toBeUndefined();
      expect(received).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("timeout uses FakeTimer and clears the waiter", async () => {
    const { client, socket, timer } = await harness();
    let finish!: () => void;
    const sent = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const send = spyOn(socket, "send").mockImplementation(() => finish());
    try {
      const pending = client.requestShowOverlay(spec, 50);
      await sent;
      timer.advanceTime(50);
      expect(await pending).toMatchObject({
        success: false,
        error: "overlay_result timed out after 50ms",
      });
      expect(client["requestManager"].getPendingCount()).toBe(0);
    } finally {
      send.mockRestore();
    }
  });
});
