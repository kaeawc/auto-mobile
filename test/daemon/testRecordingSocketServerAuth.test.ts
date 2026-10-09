import { describe, expect, test } from "bun:test";
import { TestRecordingSocketServer } from "../../src/daemon/testRecordingSocketServer";
import {
  SessionScopedStreamAuthenticator,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import type { TestRecordingCommand } from "../../src/daemon/testRecordingSocketTypes";
import { ActionableError } from "../../src/models";
import type { DeviceAdmissionGate } from "../../src/daemon/deviceAdmissionGate";
import type { TestRecordingDeviceResolution } from "../../src/daemon/testRecordingSocketServer";
import {
  getTestRecordingStatus,
  startTestRecording,
  stopTestRecording,
} from "../../src/server/testRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BootedDevice } from "../../src/models";

/**
 * The socket server's handleRequest is protected; a thin subclass exposes it so
 * the authorization gate can be exercised without opening a real Unix socket or
 * driving a real recorder.
 */
class TestableServer extends TestRecordingSocketServer {
  invoke(request: TestRecordingCommand) {
    return this.handleRequest(request);
  }
}

function recordingAuthenticator(
  calls: Array<{ sessionUuid?: string; deviceId?: string }>,
): StreamSocketAuthenticator {
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

describe("TestRecordingSocketServer device admission (issue #6863)", () => {
  test("refuses a start on a quarantined serial before any device work", async () => {
    const calls: Array<{ sessionUuid?: string; deviceId?: string }> = [];
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
    ).rejects.toThrow(/Refusing to start a test recording on device 'emu-1'/);
  });
});

/**
 * #6923: selection is split from readiness so the post-resolution admission
 * gate runs BEFORE any runner setup. A device the gate refuses must never reach
 * `readyDevice`, which is where CtrlProxy/runner setup side effects live.
 */
describe("TestRecordingSocketServer gates the resolved device before readiness (#6923)", () => {
  const resolved: BootedDevice = { deviceId: "emu-1", name: "Pixel_8", platform: "android" };

  test("refuses a resolved quarantined device before any readiness side effect", async () => {
    const order: string[] = [];
    const resolution: TestRecordingDeviceResolution = {
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
    const server = new TestableServer(
      undefined,
      undefined,
      recordingAuthenticator([]),
      gate,
      resolution,
    );

    // No deviceId on the request: the target is only known after selection, so
    // the gate's one chance to refuse it is between selection and readiness.
    await expect(
      server.invoke({ command: "start", sessionUuid: "live", platform: "android" }),
    ).rejects.toThrow(/Refusing to start a test recording on device 'emu-1'/);
    expect(order).toEqual(["select", "gate:emu-1"]);
  });

  test("readies the device only after the gate admits it", async () => {
    const order: string[] = [];
    const resolution: TestRecordingDeviceResolution = {
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
    const server = new TestableServer(
      undefined,
      undefined,
      recordingAuthenticator([]),
      gate,
      resolution,
    );

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

describe("TestRecordingSocketServer authorization (issue #4752)", () => {
  test("omitted deviceId is checked against the selected device before readiness", async () => {
    const resolved: BootedDevice = { deviceId: "emu-1", name: "Pixel", platform: "android" };
    let readyCalls = 0;
    const resolution: TestRecordingDeviceResolution = {
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
      "test recording",
      {} as NodeJS.ProcessEnv,
    );
    const server = new TestableServer(undefined, undefined, auth, undefined, resolution);

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
    const calls: Array<{ sessionUuid?: string; deviceId?: string }> = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    await expect(
      server.invoke({ command: "start", deviceId: "emu-1", platform: "android" }),
    ).rejects.toThrow(/rejected session/);
    // Authorized against the request's own device, before resolveDevice/start.
    expect(calls).toEqual([{ sessionUuid: undefined, deviceId: "emu-1" }]);
  });

  test("rejects a stop from a caller with no live session before stopTestRecording runs", async () => {
    const calls: Array<{ sessionUuid?: string; deviceId?: string }> = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    // The auth gate must reject a non-live session BEFORE stopTestRecording runs.
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
    const calls: Array<{ sessionUuid?: string; deviceId?: string }> = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    await expect(server.invoke({ command: "status" })).rejects.toThrow(/rejected session/);
    expect(calls).toEqual([{ sessionUuid: undefined, deviceId: undefined, admitViewer: true }]);
  });

  test("a live session passes the gate; status then returns the (empty) recording state", async () => {
    const calls: Array<{ sessionUuid?: string; deviceId?: string }> = [];
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
      "testRecording",
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
  const active = await startTestRecording(
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
    "test recording",
    {},
  );
  const server = new TestableServer(undefined, timer, auth);
  try {
    await expect(
      server.invoke({ command: "stop", sessionUuid: "live", deviceId: "own-device" }),
    ).rejects.toThrow(/different daemon session|not found/);
    expect(stops).toBe(0);
    expect(getTestRecordingStatus(timer)?.recordingId).toBe(active.recordingId);
  } finally {
    if (getTestRecordingStatus(timer)) {
      await stopTestRecording(active.recordingId, "cleanup", timer);
    }
  }
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
  const active = await startTestRecording(
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
    if (getTestRecordingStatus(timer)) {
      await stopTestRecording(active.recordingId, "cleanup", timer);
    }
  }
});
