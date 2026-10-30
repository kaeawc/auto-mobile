import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSocket } from "../fakes/FakeNetServer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import {
  REFUSAL_SURFACES_DIR,
  serializeRefusalSurfaceFixture,
  surfaceFixtureStem,
  type RefusalSurfaceFixture,
} from "../helpers/refusalWireFixtures";
import { afterEach, describe, expect, test } from "bun:test";
import { DeviceGestureRecordingSocketServer } from "../../src/daemon/deviceGestureRecordingSocketServer";
import {
  SessionScopedStreamAuthenticator,
  type StreamAuthorizeInput,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import type { DeviceGestureRecordingCommand } from "../../src/daemon/deviceGestureRecordingSocketTypes";
import { ActionableError } from "../../src/models";
import type { DeviceAdmissionGate } from "../../src/utils/deviceAdmissionGate";
import type { DeviceGestureRecordingDeviceResolution } from "../../src/daemon/deviceGestureRecordingSocketServer";
import {
  getDeviceGestureRecordingStatus,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
  resetStoppedDeviceGestureRecordings,
  DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE,
} from "../../src/daemon/deviceGestureRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BootedDevice, PlanStep } from "../../src/models";

/**
 * The socket server's handleRequest is protected; a thin subclass exposes it so
 * the authorization gate can be exercised without opening a real Unix socket or
 * driving a real recorder.
 */
class TestableServer extends DeviceGestureRecordingSocketServer {
  invoke(request: DeviceGestureRecordingCommand) {
    return this.handleRequest(request);
  }
  line(socket: FakeSocket, request: DeviceGestureRecordingCommand) {
    return this.processLine(socket, JSON.stringify(request));
  }
}

describe("DeviceGestureRecordingSocketServer user-input capture contract (#11919)", () => {
  const timer = new FakeTimer();
  const server = new TestableServer(
    undefined,
    timer,
    { authorize: () => {} },
    { assertDeviceActionable: () => {} },
    { bindingGate: async () => {} },
  );
  let drainInFlightStop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await drainInFlightStop?.();
    drainInFlightStop = undefined;
    if (getDeviceGestureRecordingStatus(timer)) {
      await stopDeviceGestureRecording(undefined, "cleanup", timer).catch(() => undefined);
    }
    resetStoppedDeviceGestureRecordings();
  });

  test.each([
    { outcome: "return the typed zero-step failure", stopError: undefined },
    { outcome: "propagate other errors unchanged", stopError: new ActionableError("stop failed") },
  ])("concurrent owned stops $outcome", async ({ stopError }) => {
    const stopStarted = Promise.withResolvers<void>();
    const stopGate = Promise.withResolvers<{ steps: PlanStep[]; stepCount: number }>();
    const stops: ReturnType<typeof server.invoke>[] = [];
    drainInFlightStop = async () => {
      stopGate.resolve({ steps: [], stepCount: 0 });
      await Promise.allSettled(stops);
    };
    const sessionUuid = "recording-owner";
    const active = await startDeviceGestureRecording(
      { deviceId: "fake-recording", name: "Fake", platform: "android" },
      timer,
      new CountingIdGenerator(),
      () => ({
        start: async () => {},
        stop: () => {
          stopStarted.resolve();
          return stopGate.promise;
        },
        stepCount: 0,
      }),
      { ownerSessionUuid: sessionUuid, baseSessionUuid: (uuid) => uuid.split(":")[0] },
    );
    const request = { command: "stop", recordingId: active.recordingId, sessionUuid } as const;
    stops.push(server.invoke(request));
    await stopStarted.promise;
    stops.push(server.invoke(request));
    const results = Promise.allSettled(stops);
    if (stopError) {
      stopGate.reject(stopError);
    } else {
      stopGate.resolve({ steps: [], stepCount: 0 });
    }
    const expected: PromiseSettledResult<unknown> = stopError
      ? { status: "rejected", reason: stopError }
      : {
          status: "fulfilled",
          value: {
            success: false,
            reason: "no_user_input_captured",
            error:
              "No recorded interactions were captured. " +
              DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE,
          },
        };
    const outcomes = await results;
    expect(outcomes).toEqual<unknown>([expected, expected]);
    if (stopError) {
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(outcome.reason).toBe(stopError);
        }
      }
    }
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
  });

  test.each(["status", "stop"] as const)(
    "%s explains the user-input-only capture scope",
    async (command) => {
      const active = await startDeviceGestureRecording(
        { deviceId: "fake-recording", name: "Fake", platform: "android" },
        timer,
        new CountingIdGenerator(),
        () => ({
          start: async () => {},
          stop: async () => ({ steps: [], stepCount: 0 }),
          stepCount: 0,
        }),
      );
      const response = await server.invoke({ command, recordingId: active.recordingId });
      if (command === "status") {
        expect(response.recording).toMatchObject({
          captureScope: "user-input",
          notice: DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE,
          eventCount: 0,
        });
      } else {
        expect(response).toEqual({
          success: false,
          reason: "no_user_input_captured",
          error:
            "No recorded interactions were captured. " +
            DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE,
        });
      }
    },
  );
});

function recordingAuthenticator(calls: StreamAuthorizeInput[]): StreamSocketAuthenticator {
  return {
    authorize: (input) => {
      calls.push(input);
      if (input.sessionUuid !== "live") {
        throw new ActionableError(`rejected session ${input.sessionUuid}`);
      }
    },
  };
}

/**
 * FUNNEL 2: a serial whose pooled AVD identity is quarantined is refused, and
 * the refusal must come BEFORE any device work — authorization alone cannot
 * carry it, because the quarantine deliberately preserves the owning session
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
function quarantineGate(deviceId: string): DeviceAdmissionGate {
  return {
    assertDeviceActionable: (candidate, purpose) => {
      if (candidate === deviceId) {
        throw new ActionableError(`Refusing ${purpose} on device '${candidate}'`);
      }
    },
  };
}

describe("DeviceGestureRecordingSocketServer device admission (issue #6863)", () => {
  test("refuses a start on a quarantined serial before any device work", async () => {
    const calls: StreamAuthorizeInput[] = [];
    const server = new TestableServer(
      undefined,
      undefined,
      recordingAuthenticator(calls),
      quarantineGate("emu-1"),
    );
    await expect(
      server.invoke({
        command: "start",
        sessionUuid: "live",
        deviceId: "emu-1",
        platform: "android",
      }),
    ).rejects.toThrow(/Refusing to start a device gesture recording on device 'emu-1'/);
  });
});

/**
 * #6923: selection is split from readiness so the post-resolution admission
 * gate runs BEFORE any runner setup. A device the gate refuses must never reach
 * `readyDevice`, which is where CtrlProxy/runner setup side effects live.
 */
describe("DeviceGestureRecordingSocketServer gates the resolved device before readiness (#6923)", () => {
  const resolved: BootedDevice = { deviceId: "emu-1", name: "Pixel_8", platform: "android" };

  test("refuses a resolved quarantined device before any readiness side effect", async () => {
    const order: string[] = [];
    const resolution: DeviceGestureRecordingDeviceResolution = {
      selectDevice: async () => {
        order.push("select");
        return resolved;
      },
      readyDevice: async (device) => {
        order.push(`ready:${device.deviceId}`);
        return device;
      },
    };
    const gate: DeviceAdmissionGate = {
      assertDeviceActionable: (candidate, purpose) => {
        order.push(`gate:${candidate}`);
        throw new ActionableError(`Refusing ${purpose} on device '${candidate}'`);
      },
    };
    const server = new TestableServer(undefined, undefined, recordingAuthenticator([]), gate, {
      deviceResolution: resolution,
    });

    // No deviceId on the request: the target is only known after selection, so
    // the gate's one chance to refuse it is between selection and readiness.
    await expect(
      server.invoke({ command: "start", sessionUuid: "live", platform: "android" }),
    ).rejects.toThrow(/Refusing to start a device gesture recording on device 'emu-1'/);
    expect(order).toEqual(["select", "gate:emu-1"]);
  });

  test("readies the device only after the gate admits it", async () => {
    const order: string[] = [];
    const resolution: DeviceGestureRecordingDeviceResolution = {
      selectDevice: async (deviceId, platform) => {
        order.push(`select:${deviceId}:${platform}`);
        return resolved;
      },
      readyDevice: async (device) => {
        order.push(`ready:${device.deviceId}`);
        // Readiness failing here proves the call order without starting a
        // real recorder on the readied device.
        throw new ActionableError("runner setup failed");
      },
    };
    const gate: DeviceAdmissionGate = {
      assertDeviceActionable: (candidate) => {
        order.push(`gate:${candidate}`);
      },
    };
    const server = new TestableServer(undefined, undefined, recordingAuthenticator([]), gate, {
      deviceResolution: resolution,
    });

    await expect(
      server.invoke({
        command: "start",
        sessionUuid: "live",
        deviceId: "emu-1",
        platform: "android",
      }),
    ).rejects.toThrow("runner setup failed");
    expect(order).toEqual(["gate:emu-1", "select:emu-1:android", "gate:emu-1", "ready:emu-1"]);
  });
});

describe("DeviceGestureRecordingSocketServer authorization (issue #4752)", () => {
  test("omitted deviceId is checked against the selected device before readiness", async () => {
    const resolved: BootedDevice = { deviceId: "emu-1", name: "Pixel", platform: "android" };
    let readyCalls = 0;
    const resolution: DeviceGestureRecordingDeviceResolution = {
      selectDevice: async () => resolved,
      readyDevice: async () => {
        readyCalls++;
        throw new Error("ready reached");
      },
    };
    const owner = { current: "other" };
    const auth = new SessionScopedStreamAuthenticator(
      () => ({
        getSession: (uuid) => (uuid === "live" || uuid === "other" ? {} : null),
        getSessionForDevice: () => owner.current,
        getDeviceLabels: () => undefined,
      }),
      "device gesture recording",
      {} as NodeJS.ProcessEnv,
    );
    const server = new TestableServer(undefined, undefined, auth, undefined, {
      deviceResolution: resolution,
    });

    await expect(server.invoke({ command: "start", sessionUuid: "live" })).rejects.toThrow(
      /different daemon session/,
    );
    expect(readyCalls).toBe(0);

    owner.current = "live";
    await expect(server.invoke({ command: "start", sessionUuid: "live" })).rejects.toThrow(
      "ready reached",
    );
    expect(readyCalls).toBe(1);
  });
  test("rejects a start from an unauthenticated caller before any device work", async () => {
    const calls: StreamAuthorizeInput[] = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    await expect(
      server.invoke({ command: "start", deviceId: "emu-1", platform: "android" }),
    ).rejects.toThrow(/rejected session/);
    // Authorized against the request's own device, before resolveDevice/start.
    expect(calls).toEqual([{ sessionUuid: undefined, deviceId: "emu-1" }]);
  });

  test("rejects a stop from a caller with no live session before stopDeviceGestureRecording runs", async () => {
    const calls: StreamAuthorizeInput[] = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    // The auth gate must reject a non-live session BEFORE stopDeviceGestureRecording runs.
    // The scoped device is whatever the current active recording reports (or
    // undefined), so assert on the caller identity, not on cross-suite global
    // recording state.
    await expect(server.invoke({ command: "stop", sessionUuid: "intruder" })).rejects.toThrow(
      /rejected session/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionUuid).toBe("intruder");
  });

  test("rejects status from an unauthenticated caller", async () => {
    const calls: StreamAuthorizeInput[] = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    await expect(server.invoke({ command: "status" })).rejects.toThrow(/rejected session/);
    expect(calls).toEqual([{ sessionUuid: undefined, deviceId: undefined, admitViewer: true }]);
  });

  test("a live session passes the gate; status then returns the (empty) recording state", async () => {
    const calls: StreamAuthorizeInput[] = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    const response = await server.invoke({ command: "status", sessionUuid: "live" });
    expect(response.success).toBe(true);
    expect(calls).toEqual([{ sessionUuid: "live", deviceId: undefined, admitViewer: true }]);
  });

  // #10970: status is a read, so a live session that does not hold the device may watch it.
  describe("on a device another session holds", () => {
    const sessions = new Set(["owner", "viewer"]);
    const authenticator = new SessionScopedStreamAuthenticator(
      () => ({
        getSession: (sessionUuid: string) => (sessions.has(sessionUuid) ? {} : null),
        getSessionForDevice: (deviceId: string) => (deviceId === "emu-held" ? "owner" : null),
        getDeviceLabels: () => undefined,
      }),
      "deviceGestureRecording",
      {},
    );

    test("status from a live non-owner is admitted", async () => {
      const server = new TestableServer(undefined, undefined, authenticator);
      const response = await server.invoke({
        command: "status",
        sessionUuid: "viewer",
        deviceId: "emu-held",
      });
      expect(response.success).toBe(true);
    });

    test("ownership refusal crosses the real aux response boundary", async () => {
      const server = new TestableServer(undefined, new FakeTimer(), authenticator);
      const socket = new FakeSocket();
      await server.line(socket, {
        command: "start",
        sessionUuid: "viewer",
        deviceId: "emu-held",
        platform: "android",
      });
      await drainMicrotasks(32);
      const response = socket.getWrittenMessages()[0];
      expect(response).toMatchObject({
        success: false,
        code: "device_owned_by_other_session",
        retryable: false,
        deviceId: "emu-held",
      });
      const fixture: RefusalSurfaceFixture = {
        surface: "aux-socket-response",
        name: "device_owned_by_other_session",
        builder: "DeviceGestureRecordingSocketServer.processLine",
        payload: response,
      };
      const path = join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`);
      const serialized = serializeRefusalSurfaceFixture(fixture);
      if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
        writeFileSync(path, serialized);
      }
      expect(readFileSync(path, "utf8")).toBe(serialized);
    });

    test("start from a live non-owner is still refused", async () => {
      const server = new TestableServer(undefined, undefined, authenticator);
      await expect(
        server.invoke({
          command: "start",
          sessionUuid: "viewer",
          deviceId: "emu-held",
          platform: "android",
        }),
      ).rejects.toThrow(/bound to a different daemon session/);
      await expect(
        server.invoke({
          command: "start",
          sessionUuid: "viewer",
          deviceId: "emu-held",
          platform: "android",
        }),
      ).rejects.toMatchObject({ code: "device_owned_by_other_session", retryable: false });
    });
  });
});

test("recording stop cannot disguise another device as the caller's own", async () => {
  const timer = new FakeTimer();
  let stops = 0;
  const recorder = {
    start: async () => {},
    stop: async () => {
      stops++;
      return { steps: [{ tool: "tapOn", params: { text: "OK" } }], stepCount: 1 };
    },
    stepCount: 1,
  };
  const active = await startDeviceGestureRecording(
    { deviceId: "other-device", platform: "android", name: "Fake" },
    timer,
    new CountingIdGenerator(),
    () => recorder,
  );
  const auth = new SessionScopedStreamAuthenticator(
    () => ({
      getSession: () => ({}),
      getSessionForDevice: (id) => (id === "own-device" ? "live" : "other"),
      getDeviceLabels: () => undefined,
    }),
    "device gesture recording",
    {},
  );
  const server = new TestableServer(undefined, timer, auth);
  try {
    await expect(
      server.invoke({ command: "stop", sessionUuid: "live", deviceId: "own-device" }),
    ).rejects.toThrow(/different daemon session|not found/);
    expect(stops).toBe(0);
    expect(getDeviceGestureRecordingStatus(timer)?.recordingId).toBe(active.recordingId);
  } finally {
    if (getDeviceGestureRecordingStatus(timer)) {
      await stopDeviceGestureRecording(active.recordingId, "cleanup", timer);
    }
  }
});

describe("DeviceGestureRecordingSocketServer broker-binding exclusion (#11352)", () => {
  const slotDevice: BootedDevice = { deviceId: "slot-1", name: "Pixel_8", platform: "android" };
  const openGate: DeviceAdmissionGate = { assertDeviceActionable: () => {} };

  function harness(refuse: boolean) {
    const order: string[] = [];
    const resolution: DeviceGestureRecordingDeviceResolution = {
      selectDevice: async () => slotDevice,
      readyDevice: async (device) => {
        order.push(`ready:${device.deviceId}`);
        throw new ActionableError("runner setup failed");
      },
    };
    const slotGate = async (input: {
      action: string;
      device: { deviceId: string; platform: string };
      requesterSessionUuid: string | undefined;
    }) => {
      order.push(`slot:${input.action}:${input.device.deviceId}:${input.requesterSessionUuid}`);
      if (refuse) {
        throw new ActionableError("device_assigned_to_binding");
      }
    };
    const server = new TestableServer(undefined, undefined, recordingAuthenticator([]), openGate, {
      deviceResolution: resolution,
      bindingGate: slotGate,
    });
    return { order, server };
  }

  test("refuses a start on an idle slot device before readiness", async () => {
    const { order, server } = harness(true);

    await expect(
      server.invoke({ command: "start", sessionUuid: "live", platform: "android" }),
    ).rejects.toThrow("device_assigned_to_binding");
    expect(order).toEqual(["slot:deviceGestureRecording start:slot-1:live"]);
  });

  test("the slot's own execution (gate admits) reaches readiness", async () => {
    const { order, server } = harness(false);

    await expect(
      server.invoke({ command: "start", sessionUuid: "live", platform: "android" }),
    ).rejects.toThrow("runner setup failed");
    expect(order).toEqual(["slot:deviceGestureRecording start:slot-1:live", "ready:slot-1"]);
  });

  test("refuses a stop of an active recording on a slot device without stopping it", async () => {
    const timer = new FakeTimer();
    let stops = 0;
    const recorder = {
      start: async () => {},
      stop: async () => {
        stops++;
        return { steps: [{ tool: "tapOn", params: { text: "OK" } }], stepCount: 1 };
      },
      stepCount: 1,
    };
    const active = await startDeviceGestureRecording(
      slotDevice,
      timer,
      new CountingIdGenerator(),
      () => recorder,
    );
    const { order, server } = harness(true);
    try {
      await expect(server.invoke({ command: "stop", sessionUuid: "live" })).rejects.toThrow(
        "device_assigned_to_binding",
      );
      expect(order).toEqual(["slot:deviceGestureRecording stop:slot-1:live"]);
      expect(stops).toBe(0);
    } finally {
      await stopDeviceGestureRecording(active.recordingId, "cleanup", timer);
    }
  });
});

test("socket stop preserves a partial-plan warning in its existing error field", async () => {
  const timer = new FakeTimer();
  const error = new Error("getevent exited with code 1");
  const recorder = {
    start: async () => {},
    stop: async () => ({
      steps: [{ tool: "tapOn", params: { text: "OK" } }],
      stepCount: 1,
      touchTrackFailure: { error, failedAt: 1250 },
    }),
    stepCount: 1,
  };
  const active = await startDeviceGestureRecording(
    { deviceId: "fake-device", platform: "android", name: "Fake" },
    timer,
    new CountingIdGenerator(),
    () => recorder,
  );
  const server = new TestableServer(undefined, timer, recordingAuthenticator([]));
  try {
    const response = await server.invoke({
      command: "stop",
      sessionUuid: "live",
      recordingId: active.recordingId,
      planName: "partial",
    });
    expect(response.success).toBe(true);
    expect(response.stepCount).toBe(1);
    expect(response.planContent).toContain("tapOn");
    expect(response.error).toBe(
      "Warning: Touch track (getevent) stopped 1250 ms after recording start: getevent exited with code 1. Later taps may be missing.",
    );
  } finally {
    if (getDeviceGestureRecordingStatus(timer)) {
      await stopDeviceGestureRecording(active.recordingId, "cleanup", timer);
    }
  }
});
