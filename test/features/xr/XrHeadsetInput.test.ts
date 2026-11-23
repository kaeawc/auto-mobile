import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  GrpcXrHeadsetInputInjector,
  planXrPointerEvents,
  resolveXrInputEndpoint,
  XR_AIM_SETTLE_MS,
  XR_DEFAULT_HOLD_MS,
  XR_DRAG_STEPS,
} from "../../../src/features/xr/XrHeadsetInput";
import type {
  EmulatorGrpcDiscovery,
  EmulatorGrpcEndpoint,
} from "../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import type {
  EmulatorInputEventSender,
  TimedInputEvent,
} from "../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorInputEventClient";
import { encodeXrPointerInputEvent } from "../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorXrInputMessages";

class RecordingSender implements EmulatorInputEventSender {
  readonly sent: Array<{ events: readonly TimedInputEvent[]; signal?: AbortSignal }> = [];
  async send(events: readonly TimedInputEvent[], signal?: AbortSignal): Promise<void> {
    this.sent.push({ events, signal });
  }
}

const shape = (request: Parameters<typeof planXrPointerEvents>[0]) =>
  planXrPointerEvents(request).map(({ event, delayAfterMs }) => [
    event.channel,
    event.x,
    event.y,
    event.buttons,
    delayAfterMs,
  ]);

describe("planXrPointerEvents", () => {
  test("select aims, holds the primary button, then releases at the same point", () => {
    expect(shape({ pointer: "hand", action: "select", x: 1280, y: 900 })).toEqual([
      ["hand", 1280, 900, 0, XR_AIM_SETTLE_MS],
      ["hand", 1280, 900, 1, XR_DEFAULT_HOLD_MS],
      ["hand", 1280, 900, 0, 0],
    ]);
    expect(shape({ pointer: "eye", action: "select", x: 5, y: 6, holdMs: 0 })[1]).toEqual([
      "eye",
      5,
      6,
      1,
      0,
    ]);
  });

  test("point only aims, with no button", () => {
    expect(shape({ pointer: "eye", action: "point", x: 10, y: 20 })).toEqual([
      ["eye", 10, 20, 0, 0],
    ]);
  });

  test("drag pinches at the start, moves in held steps and releases at the end", () => {
    const plan = shape({
      pointer: "hand",
      action: "drag",
      x: 100,
      y: 1000,
      toX: 100,
      toY: 0,
      durationMs: 500,
    });
    expect(plan).toHaveLength(XR_DRAG_STEPS + 3);
    expect(plan[0]).toEqual(["hand", 100, 1000, 0, XR_AIM_SETTLE_MS]);
    expect(plan[1]).toEqual(["hand", 100, 1000, 1, 50]);
    expect(plan[2]).toEqual(["hand", 100, 900, 1, 50]);
    expect(plan[XR_DRAG_STEPS + 1]).toEqual(["hand", 100, 0, 1, 50]);
    expect(plan.at(-1)).toEqual(["hand", 100, 0, 0, 0]);
  });

  test("drag needs both end coordinates and the hand pointer", () => {
    expect(() => planXrPointerEvents({ pointer: "hand", action: "drag", x: 1, y: 1 })).toThrow(
      /needs toX and toY/,
    );
    expect(() =>
      planXrPointerEvents({ pointer: "eye", action: "drag", x: 1, y: 1, toX: 2, toY: 2 }),
    ).toThrow(ActionableError);
  });
});

describe("GrpcXrHeadsetInputInjector", () => {
  test("sends the encoded plan with its pauses and reports the exact host interface", async () => {
    const sender = new RecordingSender();
    const signal = new AbortController().signal;
    const result = await new GrpcXrHeadsetInputInjector(sender).inject({
      pointer: "hand",
      action: "select",
      x: 640,
      y: 480,
      signal,
    });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].signal).toBe(signal);
    expect(sender.sent[0].events).toEqual(
      planXrPointerEvents({ pointer: "hand", action: "select", x: 640, y: 480 }).map(
        ({ event, delayAfterMs }) => ({ message: encodeXrPointerInputEvent(event), delayAfterMs }),
      ),
    );
    expect(result).toMatchObject({
      success: true,
      pointer: "hand",
      action: "select",
      rpc: "android.emulation.control.EmulatorController/streamInputEvent",
      field: "xr_hand_event",
      events: [
        { x: 640, y: 480, buttons: 0 },
        { x: 640, y: 480, buttons: 1 },
        { x: 640, y: 480, buttons: 0 },
      ],
    });
    expect(result.message).toContain("observe afterwards");
  });

  test("eye input reports the xr_eye_event field", async () => {
    const result = await new GrpcXrHeadsetInputInjector(new RecordingSender()).inject({
      pointer: "eye",
      action: "point",
      x: 1,
      y: 2,
    });
    expect(result.field).toBe("xr_eye_event");
  });
});

describe("resolveXrInputEndpoint", () => {
  const endpoint: EmulatorGrpcEndpoint = {
    pid: 42,
    consolePort: 5556,
    address: "localhost:8555",
    auth: { kind: "none" },
    descriptionFile: "/tmp/pid_42.ini",
  };
  const discovery = (found?: EmulatorGrpcEndpoint): EmulatorGrpcDiscovery & { ports: number[] } => {
    const ports: number[] = [];
    return {
      ports,
      findByConsolePort: async (port) => {
        ports.push(port);
        return found;
      },
    };
  };

  test("finds the endpoint by the serial's console port", async () => {
    const found = discovery(endpoint);
    expect(await resolveXrInputEndpoint("emulator-5556", found)).toBe(endpoint);
    expect(found.ports).toEqual([5556]);
  });

  test("refuses a non-emulator serial before discovery", async () => {
    const found = discovery(endpoint);
    await expect(resolveXrInputEndpoint("R5CT123", found)).rejects.toThrow(/not a local emulator/);
    expect(found.ports).toEqual([]);
  });

  test("an emulator without a gRPC advertisement is an actionable error", async () => {
    await expect(resolveXrInputEndpoint("emulator-5554", discovery())).rejects.toThrow(
      /does not advertise a gRPC endpoint/,
    );
  });
});
