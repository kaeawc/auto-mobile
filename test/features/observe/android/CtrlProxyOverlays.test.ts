import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { MAX_OVERLAY_SPEC_BYTES } from "../../../../src/features/overlay/overlaySpec";
import type { OverlayEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";
import { ActionableError } from "../../../../src/models/ActionableError";
import { PortManager } from "../../../../src/utils/PortManager";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
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
  commands: string[] | null = [
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
  if (commands !== null) {
    await receive({ type: "connected", supportedCommands: commands });
  }
  return { client, socket, timer, receive };
}
async function expectRefusal(pending: Promise<unknown>, path: string): Promise<void> {
  let failure: unknown;
  void pending.catch((error: unknown) => {
    failure = error;
  });
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve();
  }
  expect(failure).toBeInstanceOf(ActionableError);
  expect(failure instanceof Error ? failure.message : "").toContain(path);
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

  describe("display targeting", () => {
    const withDisplay = [
      "full_command_set_v1",
      "request_id_echo_v1",
      "show_overlay",
      "overlay_display_id_v1",
    ];
    const withoutFlag = withDisplay.filter((command) => command !== "overlay_display_id_v1");

    async function sendShow(
      commands: string[] | null,
      displayId: number | undefined,
    ): Promise<Record<string, unknown> | undefined> {
      const { client, socket } = await harness(commands);
      const sent: Record<string, unknown>[] = [];
      const send = spyOn(socket, "send").mockImplementation((data) => {
        sent.push(JSON.parse(String(data)));
      });
      try {
        void client.requestShowOverlay(spec, 5000, undefined, displayId).catch(() => undefined);
        for (let turn = 0; turn < 10; turn++) {
          await Promise.resolve();
        }
        return sent[0];
      } finally {
        send.mockRestore();
      }
    }

    test("an explicit display is sent as displayId", async () => {
      expect(await sendShow(withDisplay, 2)).toMatchObject({ type: "show_overlay", displayId: 2 });
    });

    test.each([undefined, 0])("display %p omits the field, as before targeting", async (id) => {
      for (const commands of [withDisplay, withoutFlag]) {
        const message = await sendShow(commands, id);
        expect(message?.type).toBe("show_overlay");
        expect(Object.hasOwn(message ?? {}, "displayId")).toBe(false);
      }
    });

    test.each([
      ["without the flag", withoutFlag],
      ["with only the gesture flag", [...withoutFlag, "gesture_display_id_v1"]],
      ["on a legacy handshake without the flag", ["show_overlay", "gesture_display_id_v1"]],
    ])("%s refuses before sending rather than defaulting", async (_name, commands) => {
      const { client, socket } = await harness(commands);
      const send = spyOn(socket, "send");
      try {
        await expect(client.requestShowOverlay(spec, 5000, undefined, 2)).rejects.toBeInstanceOf(
          ActionableError,
        );
        await expect(client.requestShowOverlay(spec, 5000, undefined, 2)).rejects.toThrow(
          "overlay_display_id_v1",
        );
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
      }
    });
  });

  describe("inspect", () => {
    const inspectable = [
      "full_command_set_v1",
      "request_id_echo_v1",
      "inspect_overlays",
      "overlay_persistence_replay_v1",
    ];

    test("sends inspect_overlays and returns the overlays and dropped count", async () => {
      const { client, socket, receive } = await harness(inspectable);
      let finish!: (value: Record<string, unknown>) => void;
      const sent = new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      });
      const send = spyOn(socket, "send").mockImplementation((data) =>
        finish(JSON.parse(String(data))),
      );
      try {
        const pending = client.requestInspectOverlays();
        const message = await sent;
        expect(message.type).toBe("inspect_overlays");
        const entry = {
          id: "proto",
          persistent: true,
          state: { label: "typed" },
          pages: { pager: 1 },
          lastSequence: 4,
        };
        await receive({
          type: "overlay_result",
          timestamp: 42,
          requestId: message.requestId,
          success: true,
          overlays: [entry],
          droppedEvents: 3,
        });
        expect(await pending).toMatchObject({
          success: true,
          overlays: [entry],
          droppedEvents: 3,
        });
      } finally {
        send.mockRestore();
      }
    });

    test.each([
      ["without the flag", ["full_command_set_v1", "inspect_overlays"]],
      ["on a legacy handshake", ["inspect_overlays"]],
    ])("%s refuses before sending", async (_name, commands) => {
      const { client, socket } = await harness(commands);
      const send = spyOn(socket, "send");
      try {
        await expect(client.requestInspectOverlays()).rejects.toThrow(
          "overlay_persistence_replay_v1",
        );
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
      }
    });
  });

  test.each(["show_overlay", "update_overlay"])(
    "%s surfaces missingAssets as a warning on a successful result",
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
            : client.requestUpdateOverlay({ id: "panel", state: { enabled: false } });
        const message = await sent;
        await receive({
          type: "overlay_result",
          timestamp: 42,
          requestId: message.requestId,
          success: true,
          error: null,
          missingAssets: ["hero", "logo"],
        });
        expect(await pending).toEqual({
          timestamp: 42,
          requestId: message.requestId,
          success: true,
          error: null,
          missingAssets: ["hero", "logo"],
        });
      } finally {
        send.mockRestore();
      }
    },
  );

  test("a result from a device that predates missingAssets has no such key", async () => {
    const { client, socket, receive } = await harness();
    let finish!: (value: Record<string, unknown>) => void;
    const sent = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const send = spyOn(socket, "send").mockImplementation((data) =>
      finish(JSON.parse(String(data))),
    );
    try {
      const pending = client.requestShowOverlay(spec);
      const message = await sent;
      await receive({
        type: "overlay_result",
        timestamp: 42,
        requestId: message.requestId,
        success: true,
        error: null,
      });
      expect("missingAssets" in (await pending)).toBe(false);
    } finally {
      send.mockRestore();
    }
  });

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
      await expect(client.requestShowOverlay(spec)).rejects.toThrow(
        "this CtrlProxy build does not support overlays",
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  test.each([
    { error: "Unknown command type: show_overlay", unknown: true },
    { error: "Malformed request: missing spec.root.type", unknown: false },
    { error: "Handler error: failed to render", unknown: false },
    { error: "ctrlproxy_busy: command queue full", unknown: false },
  ])("correlated error settles with device message: $error", async ({ error, unknown }) => {
    const { client, socket, receive } = await harness(unknown ? null : undefined);
    let sent!: (frame: Record<string, unknown>) => void;
    const dispatched = new Promise<Record<string, unknown>>((resolve) => {
      sent = resolve;
    });
    const send = spyOn(socket, "send").mockImplementation((data) => sent(JSON.parse(String(data))));
    try {
      let result: unknown;
      const pending = client.requestShowOverlay(spec).then((value) => {
        result = value;
        return value;
      });
      const frame = await dispatched;
      await receive({ type: "error", requestId: frame.requestId, error });
      // Bounded microtask drain detects the old orphaned promise without wall-clock waits.
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve();
      }
      expect(result).toMatchObject({ success: false, error, totalTimeMs: 0 });
      await pending;
      expect(client["requestManager"].getPendingCount()).toBe(0);
      if (!unknown) {
        send.mockImplementation((data) => {
          void receive({
            type: "overlay_result",
            requestId: JSON.parse(String(data)).requestId,
            timestamp: 43,
            success: true,
            error: null,
          });
        });
        expect(await client.requestShowOverlay(spec)).toMatchObject({ success: true });
      }
    } finally {
      send.mockRestore();
    }
  });

  test("failed overlay_result keeps show_overlay supported", async () => {
    const { client, socket, receive } = await harness();
    const send = spyOn(socket, "send").mockImplementation((data) => {
      void receive({
        type: "overlay_result",
        timestamp: 42,
        requestId: JSON.parse(String(data)).requestId,
        success: false,
        error: "bad spec.root.type",
      });
    });
    try {
      expect(await client.requestShowOverlay(spec)).toMatchObject({ success: false });
      expect(await client.requestShowOverlay(spec)).toMatchObject({ success: false });
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      send.mockRestore();
    }
  });

  test.each([
    {
      label: "unknown property",
      value: { ...spec, root: { ...spec.root, surprise: true } },
      path: "root.surprise",
    },
    { label: "unknown node", value: { ...spec, root: { type: "future" } }, path: "root.type" },
    {
      label: "over-limit spec",
      value: { ...spec, root: { ...spec.root, text: "x".repeat(MAX_OVERLAY_SPEC_BYTES + 1) } },
      path: "$",
    },
    {
      label: "bad state key",
      value: { ...spec, state: { "bad-key": true } },
      path: 'state["bad-key"]',
    },
  ])("rejects $label before show or replacement update dispatch", async ({ value, path }) => {
    const { client, socket } = await harness();
    const send = spyOn(socket, "send");
    try {
      // Wire boundary deliberately exercises untrusted shapes without weakening app types.
      const invalid = value as typeof spec;

      await expectRefusal(client.requestShowOverlay(invalid), path);
      await expectRefusal(client.requestUpdateOverlay({ id: spec.id, spec: invalid }), path);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  test.each([
    { update: { id: "panel", state: { "bad-key": true } }, path: "state" },
    { update: { id: "other", spec }, path: "spec.id" },
  ])("invalid update $path never dispatches", async ({ update, path }) => {
    const { client, socket } = await harness();
    const send = spyOn(socket, "send");
    try {
      await expectRefusal(client.requestUpdateOverlay(update), path);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  test("matching replacement id sends", async () => {
    const { client, socket, receive } = await harness();
    const send = spyOn(socket, "send").mockImplementation((data) => {
      const frame = JSON.parse(String(data));
      expect(frame.spec).toEqual(spec);
      expect(frame.id).toBe(spec.id);
      void receive({
        type: "overlay_result",
        requestId: frame.requestId,
        timestamp: 42,
        success: true,
      });
    });
    try {
      expect(await client.requestUpdateOverlay({ id: spec.id, spec })).toMatchObject({
        success: true,
      });
    } finally {
      send.mockRestore();
    }
  });

  test("fake records overlay calls, configures results, and emits until unsubscribe", async () => {
    const fake = new FakeCtrlProxy(new FakeTimer());
    const failure = { success: false, error: "configured" };
    fake.setOverlayResult(failure);
    expect(await fake.requestShowOverlay(spec, 25)).toEqual(failure);
    expect(await fake.requestUpdateOverlay({ id: spec.id, spec }, 30)).toEqual(failure);
    expect(await fake.requestDismissOverlay({ all: true }, 35)).toEqual(failure);
    expect(fake.getOverlayHistory()).toEqual([
      { method: "show", spec, timeoutMs: 25, perf: undefined },
      { method: "update", update: { id: spec.id, spec }, timeoutMs: 30, perf: undefined },
      { method: "dismiss", target: { all: true }, timeoutMs: 35, perf: undefined },
    ]);
    const received: OverlayEvent[] = [];
    const unsubscribe = fake.onOverlayEvent((value) => received.push(value));
    fake.emitOverlayEvent(event as OverlayEvent);
    unsubscribe();
    fake.emitOverlayEvent(event as OverlayEvent);
    expect(received).toEqual([event]);
  });

  test("event strips future top-level fields", async () => {
    const { client, receive } = await harness();
    const received: OverlayEvent[] = [];
    client.onOverlayEvent((value) => received.push(value));
    await receive({ ...event, displayId: 3 });
    expect(received).toEqual([event]);
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
    { ...event, state: { "bad-key": true } },
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
