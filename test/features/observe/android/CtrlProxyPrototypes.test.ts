import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { MAX_PROTOTYPE_SPEC_BYTES } from "../../../../src/features/prototype/prototypeSpec";
import type { PrototypeEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";
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
  type: "prototype_event",
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
    "show_prototype",
    "dismiss_prototype",
  ],
) {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "prototype-test", platform: "android", name: "Android", isEmulator: true },
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

describe("CtrlProxy prototypes", () => {
  test.each(["show_prototype", "dismiss_prototype"])(
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
          type === "show_prototype"
            ? client.requestShowPrototype(spec)
            : client.requestDismissPrototype({ all: true });
        const message = await sent;
        expect(message.type).toBe(type);
        expect(message.requestId).toBeString();
        if (type === "show_prototype") {
          expect(message.spec).toEqual(spec);
        }
        if (type === "dismiss_prototype") {
          expect(message.all).toBe(true);
        }
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await receive({
          type: "prototype_result",
          timestamp: 42,
          requestId: "other",
          success: true,
          error: null,
        });
        expect(settled).toBe(false);
        await receive({
          type: "prototype_result",
          timestamp: 42,
          requestId: message.requestId,
          success: false,
          error: "prototype host not wired",
        });
        expect(await pending).toEqual({
          timestamp: 42,
          requestId: message.requestId,
          success: false,
          error: "prototype host not wired",
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
      "show_prototype",
      "prototype_display_id_v1",
    ];
    const withoutFlag = withDisplay.filter((command) => command !== "prototype_display_id_v1");

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
        void client.requestShowPrototype(spec, 5000, undefined, displayId).catch(() => undefined);
        for (let turn = 0; turn < 10; turn++) {
          await Promise.resolve();
        }
        return sent[0];
      } finally {
        send.mockRestore();
      }
    }

    test("an explicit display is sent as displayId", async () => {
      expect(await sendShow(withDisplay, 2)).toMatchObject({
        type: "show_prototype",
        displayId: 2,
      });
    });

    test.each([undefined, 0])("display %p omits the field, as before targeting", async (id) => {
      for (const commands of [withDisplay, withoutFlag]) {
        const message = await sendShow(commands, id);
        expect(message?.type).toBe("show_prototype");
        expect(Object.hasOwn(message ?? {}, "displayId")).toBe(false);
      }
    });

    test.each([
      ["without the flag", withoutFlag],
      ["with only the gesture flag", [...withoutFlag, "gesture_display_id_v1"]],
      ["on a legacy handshake without the flag", ["show_prototype", "gesture_display_id_v1"]],
    ])("%s refuses before sending rather than defaulting", async (_name, commands) => {
      const { client, socket } = await harness(commands);
      const send = spyOn(socket, "send");
      try {
        await expect(client.requestShowPrototype(spec, 5000, undefined, 2)).rejects.toBeInstanceOf(
          ActionableError,
        );
        await expect(client.requestShowPrototype(spec, 5000, undefined, 2)).rejects.toThrow(
          "prototype_display_id_v1",
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
      "inspect_prototypes",
      "prototype_persistence_replay_v1",
    ];

    test("sends inspect_prototypes and returns the prototypes and dropped count", async () => {
      const { client, socket, receive } = await harness(inspectable);
      let finish!: (value: Record<string, unknown>) => void;
      const sent = new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      });
      const send = spyOn(socket, "send").mockImplementation((data) =>
        finish(JSON.parse(String(data))),
      );
      try {
        const pending = client.requestInspectPrototypes();
        const message = await sent;
        expect(message.type).toBe("inspect_prototypes");
        const entry = {
          id: "proto",
          persistent: true,
          state: { label: "typed" },
          pages: { pager: 1 },
          lastSequence: 4,
        };
        await receive({
          type: "prototype_result",
          timestamp: 42,
          requestId: message.requestId,
          success: true,
          prototypes: [entry],
          droppedEvents: 3,
        });
        expect(await pending).toMatchObject({
          success: true,
          prototypes: [entry],
          droppedEvents: 3,
        });
      } finally {
        send.mockRestore();
      }
    });

    test.each([
      ["without the flag", ["full_command_set_v1", "inspect_prototypes"]],
      ["on a legacy handshake", ["inspect_prototypes"]],
    ])("%s refuses before sending", async (_name, commands) => {
      const { client, socket } = await harness(commands);
      const send = spyOn(socket, "send");
      try {
        await expect(client.requestInspectPrototypes()).rejects.toThrow(
          "prototype_persistence_replay_v1",
        );
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
      }
    });
  });

  test.each(["show_prototype"])(
    "%s surfaces missingAssets as a warning on a successful result",
    async () => {
      const { client, socket, receive } = await harness();
      let finish!: (value: Record<string, unknown>) => void;
      const sent = new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      });
      const send = spyOn(socket, "send").mockImplementation((data) =>
        finish(JSON.parse(String(data))),
      );
      try {
        const pending = client.requestShowPrototype(spec);
        const message = await sent;
        await receive({
          type: "prototype_result",
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
      const pending = client.requestShowPrototype(spec);
      const message = await sent;
      await receive({
        type: "prototype_result",
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
    [[], ["full_command_set_v1"], ["full_command_set_v1", "dismiss_prototype"]].map((commands) => ({
      commands,
    })),
  )("old capabilities $commands throw before sending", async ({ commands }) => {
    const { client, socket } = await harness(commands);
    const send = spyOn(socket, "send");
    try {
      await expect(client.requestShowPrototype(spec)).rejects.toBeInstanceOf(ActionableError);
      await expect(client.requestShowPrototype(spec)).rejects.toThrow("show_prototype");
      await expect(client.requestShowPrototype(spec)).rejects.toThrow(
        "this CtrlProxy build does not support prototypes",
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  test.each([
    { error: "Unknown command type: show_prototype", unknown: true },
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
      const pending = client.requestShowPrototype(spec).then((value) => {
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
            type: "prototype_result",
            requestId: JSON.parse(String(data)).requestId,
            timestamp: 43,
            success: true,
            error: null,
          });
        });
        expect(await client.requestShowPrototype(spec)).toMatchObject({ success: true });
      }
    } finally {
      send.mockRestore();
    }
  });

  test("failed prototype_result keeps show_prototype supported", async () => {
    const { client, socket, receive } = await harness();
    const send = spyOn(socket, "send").mockImplementation((data) => {
      void receive({
        type: "prototype_result",
        timestamp: 42,
        requestId: JSON.parse(String(data)).requestId,
        success: false,
        error: "bad spec.root.type",
      });
    });
    try {
      expect(await client.requestShowPrototype(spec)).toMatchObject({ success: false });
      expect(await client.requestShowPrototype(spec)).toMatchObject({ success: false });
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
      value: { ...spec, root: { ...spec.root, text: "x".repeat(MAX_PROTOTYPE_SPEC_BYTES + 1) } },
      path: "$",
    },
    {
      label: "bad state key",
      value: { ...spec, state: { "bad-key": true } },
      path: 'state["bad-key"]',
    },
  ])("rejects $label before show dispatch", async ({ value, path }) => {
    const { client, socket } = await harness();
    const send = spyOn(socket, "send");
    try {
      // Wire boundary deliberately exercises untrusted shapes without weakening app types.
      const invalid = value as typeof spec;

      await expectRefusal(client.requestShowPrototype(invalid), path);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  test.each([
    [true, true],
    [false, undefined],
    [undefined, undefined],
  ])("reset %p sends reset %p", async (reset, wire) => {
    const { client, socket, receive } = await harness();
    const frames: Record<string, unknown>[] = [];
    const send = spyOn(socket, "send").mockImplementation((data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      void receive({
        type: "prototype_result",
        requestId: frame.requestId,
        timestamp: 42,
        success: true,
      });
    });
    try {
      expect(
        await client.requestShowPrototype(spec, 5000, undefined, undefined, reset),
      ).toMatchObject({ success: true });
      expect(frames).toHaveLength(1);
      expect(frames[0].reset).toBe(wire);
      expect(Object.hasOwn(frames[0], "reset")).toBe(wire !== undefined);
    } finally {
      send.mockRestore();
    }
  });

  test("fake records prototype calls, configures results, and emits until unsubscribe", async () => {
    const fake = new FakeCtrlProxy(new FakeTimer());
    const failure = { success: false, error: "configured" };
    fake.setPrototypeResult(failure);
    expect(await fake.requestShowPrototype(spec, 25)).toEqual(failure);
    expect(await fake.requestDismissPrototype({ all: true }, 35)).toEqual(failure);
    expect(fake.getPrototypeHistory()).toEqual([
      { method: "show", spec, timeoutMs: 25, perf: undefined },
      { method: "dismiss", target: { all: true }, timeoutMs: 35, perf: undefined },
    ]);
    const received: PrototypeEvent[] = [];
    const unsubscribe = fake.onPrototypeEvent((value) => received.push(value));
    fake.emitPrototypeEvent(event as PrototypeEvent);
    unsubscribe();
    fake.emitPrototypeEvent(event as PrototypeEvent);
    expect(received).toEqual([event]);
  });

  test("event strips future top-level fields", async () => {
    const { client, receive } = await harness();
    const received: PrototypeEvent[] = [];
    client.onPrototypeEvent((value) => received.push(value));
    await receive({ ...event, displayId: 3 });
    expect(received).toEqual([event]);
  });

  test("events decode and unsubscribe, independent of request-id echo", async () => {
    const { client, receive } = await harness();
    const received: PrototypeEvent[] = [];
    const unsubscribe = client.onPrototypeEvent((value) => received.push(value));
    await receive(event);
    expect(received).toEqual([event]);
    unsubscribe();
    await receive({ ...event, sequence: 2 });
    expect(received).toHaveLength(1);
  });

  test("events pushed while nobody listens go to the next subscriber in order", async () => {
    const { client, receive } = await harness();
    await receive(event);
    await receive({ ...event, sequence: 2 });
    const received: PrototypeEvent[] = [];
    client.onPrototypeEvent((value) => received.push(value));
    await receive({ ...event, sequence: 3 });
    expect(received.map((value) => value.sequence)).toEqual([1, 2, 3]);

    const later: PrototypeEvent[] = [];
    client.onPrototypeEvent((value) => later.push(value));
    expect(later).toEqual([]);
  });

  test("staged events are bounded to the device's offline ring", async () => {
    const { client, receive } = await harness();
    for (let sequence = 1; sequence <= 205; sequence++) {
      await receive({ ...event, sequence });
    }
    const received: PrototypeEvent[] = [];
    client.onPrototypeEvent((value) => received.push(value));
    expect(received).toHaveLength(200);
    expect(received[0]?.sequence).toBe(6);
  });

  test("listener errors are logged and other listeners still receive", async () => {
    const { client, receive } = await harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const received: PrototypeEvent[] = [];
    try {
      client.onPrototypeEvent(() => {
        throw new Error("broken consumer");
      });
      client.onPrototypeEvent((value) => received.push(value));
      await receive(event);
      expect(received).toEqual([event]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test.each([["light"], ["dark"], [undefined]] as const)(
    "show_prototype carries a top-level appearance %p only when one is given",
    async (appearance) => {
      const { client, socket } = await harness();
      const sent: Record<string, unknown>[] = [];
      const send = spyOn(socket, "send").mockImplementation((data) => {
        sent.push(JSON.parse(String(data)));
      });
      try {
        void client
          .requestShowPrototype(spec, 5000, undefined, undefined, undefined, appearance)
          .catch(() => undefined);
        for (let turn = 0; turn < 10; turn++) {
          await Promise.resolve();
        }
        expect(sent[0]?.type).toBe("show_prototype");
        expect(sent[0]?.spec).toEqual(spec);
        expect(sent[0]?.appearance).toBe(appearance);
        expect(Object.hasOwn(sent[0] ?? {}, "appearance")).toBe(appearance !== undefined);
      } finally {
        send.mockRestore();
      }
    },
  );

  test("an appearance_changed event decodes with a null name and its {mode, source} payload", async () => {
    const { client, receive } = await harness();
    const received: PrototypeEvent[] = [];
    client.onPrototypeEvent((value) => received.push(value));
    // The literal android/protocol WebSocketResponseTest round-trips.
    const frame = {
      type: "prototype_event",
      timestamp: 42,
      id: "panel",
      sequence: 4,
      kind: "appearance_changed",
      name: null,
      payload: { mode: "light", source: "system" },
      state: {},
      pages: {},
    };
    await receive(frame);
    expect(received).toEqual([frame as PrototypeEvent]);
  });

  test("an event of a kind this host does not know is warned about and passed on as a sequence marker", async () => {
    const { client, receive } = await harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const received: PrototypeEvent[] = [];
    try {
      client.onPrototypeEvent((value) => received.push(value));
      // A future kind may carry fields of any shape; only the envelope is read.
      await receive({ ...event, sequence: 7, kind: "pose_changed", name: 3, state: [1], extra: 1 });
      expect(received).toEqual([
        {
          type: "prototype_event",
          timestamp: 42,
          id: "panel",
          sequence: 7,
          kind: "unknown",
          name: null,
          payload: null,
          state: {},
          pages: {},
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('unknown kind "pose_changed"');
      // The frame did not fail the connection: the next known event still arrives.
      await receive({ ...event, sequence: 8 });
      expect(received.map((value) => value.sequence)).toEqual([7, 8]);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    { ...event, kind: "" },
    { ...event, kind: 4 },
    { ...event, kind: "pose_changed", sequence: -1 },
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
    const received: PrototypeEvent[] = [];
    try {
      client.onPrototypeEvent((value) => received.push(value));
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
      const pending = client.requestShowPrototype(spec, 50);
      await sent;
      timer.advanceTime(50);
      expect(await pending).toMatchObject({
        success: false,
        error: "prototype_result timed out after 50ms",
      });
      expect(client["requestManager"].getPendingCount()).toBe(0);
    } finally {
      send.mockRestore();
    }
  });
});
