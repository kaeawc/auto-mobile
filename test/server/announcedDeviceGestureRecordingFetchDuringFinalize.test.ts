import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep } from "../../src/models";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { SessionScopedStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import { DeviceGestureRecordingSocketServer } from "../../src/daemon/deviceGestureRecordingSocketServer";
import type { DeviceGestureRecordingCommand } from "../../src/daemon/deviceGestureRecordingSocketTypes";
import { registerPlanTools } from "../../src/server/planTools";
import {
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
} from "../../src/daemon/recordingSessionCleanup";
import {
  resetStoppedDeviceGestureRecordings,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/daemon/deviceGestureRecordingManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolJson } from "../helpers/toolResponse";

isolateToolRegistry();

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };
const OWNER = "session-a";

class TestableServer extends DeviceGestureRecordingSocketServer {
  invoke(request: DeviceGestureRecordingCommand) {
    return this.handleRequest(request);
  }
}

class FakeSessionManager implements CleanupManager {
  releaseCallbacks: ReleaseCallback[] = [];
  pendingCleanups: Array<Promise<unknown>> = [];

  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }
  onSessionDeviceUnbound(): void {}
  registerPendingDeviceCleanup(_deviceId: string, cleanup: Promise<unknown>): void {
    this.pendingCleanups.push(cleanup);
  }
  release(sessionId: string, deviceId: string): void {
    for (const callback of this.releaseCallbacks) {
      callback(
        sessionId,
        deviceId,
        "idle-timeout",
        {
          sessionId,
          deviceId,
          releaseReason: "idle-timeout",
          releasedAtMs: 0,
          terminal: true,
          heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
        },
        {},
      );
    }
  }
}

/**
 * "Recording artifacts stay fetchable by id" (#10958, docs/using/device-ownership.md): the
 * `notifications/session/released` payload names the recordings the release finalizes
 * (`recordingIds`), and it is emitted from the release callback, while the finalize is still in
 * flight. `stopDeviceGestureRecording(recordingId)` already joins a stop in flight, but neither surface
 * reaches it: both gate on `getDeviceGestureRecordingStatus()`, which is null once the stop has begun, and
 * the retained plan does not exist until the stop ends.
 *
 * So the previous owner, fetching the id it was just handed, is told "No active recording. Start
 * a recording before exporting." by exportPlan and "not an active daemon session" by the socket
 * stop. A moment later the same request returns the plan.
 */
describe("the previous owner fetches the announced device gesture recording while its release-time stop is in flight", () => {
  let finishStop!: () => void;
  const timer = new FakeTimer();

  beforeAll(() => {
    if (!ToolRegistry.getTool("exportPlan")) {
      registerPlanTools();
    }
  });

  afterEach(async () => {
    finishStop();
    await stopDeviceGestureRecording(undefined, undefined, timer).catch(() => undefined);
    resetStoppedDeviceGestureRecordings();
  });

  /** Releases the owner; returns the recording id the released notification would name. */
  const releaseOwnerWithStopInFlight = async (): Promise<{
    announcedId: string;
    finalized: Promise<unknown>;
  }> => {
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    let stopBegan = false;
    await startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      () => ({
        stepCount: 0,
        start: async () => undefined,
        stop: async () => {
          stopBegan = true;
          await stopGate;
          return { steps: [step], stepCount: 1 };
        },
      }),
      { ownerSessionUuid: OWNER },
    );
    const manager = new FakeSessionManager();
    registerRecordingSessionCleanup(manager, {
      ...defaultRecordingSessionCleanupDeps,
      timer,
      stopSegmentedRecordings: async () => undefined,
      listActiveVideoRecordings: async () => [],
    });
    manager.release(OWNER, device.deviceId);
    const [announcedId] = takeRecordingIdsFinalizedByRelease(OWNER);
    for (let turn = 0; turn < 10 && !stopBegan; turn += 1) {
      await Promise.resolve();
    }
    expect(stopBegan).toBe(true);
    return { announcedId, finalized: Promise.all(manager.pendingCleanups) };
  };

  test("exportPlan by the announced id returns the plan, not 'No active recording'", async () => {
    const { announcedId, finalized } = await releaseOwnerWithStopInFlight();

    const pending = ToolRegistry.getTool("exportPlan")!.handler({
      recordingId: announcedId,
      sessionUuid: OWNER,
    });
    finishStop();
    await finalized;
    const payload = toolJson(await pending);

    expect(payload.error).toBeUndefined();
    expect(payload.recordingId).toBe(announcedId);
    expect(payload.stepCount).toBe(1);
  });

  test("the socket stop by the announced id returns the plan, not a session rejection", async () => {
    const { announcedId, finalized } = await releaseOwnerWithStopInFlight();
    // The owner's session is gone: the release that announced the id ended it.
    const server = new TestableServer(
      undefined,
      undefined,
      new SessionScopedStreamAuthenticator(
        () => ({
          getSession: () => null,
          getSessionForDevice: () => null,
          getDeviceLabels: () => undefined,
        }),
        "deviceGestureRecording",
        {},
      ),
    );

    const pending = server
      .invoke({ command: "stop", recordingId: announcedId, sessionUuid: OWNER })
      .then(
        (response) => ({ recordingId: response.recordingId, error: undefined }),
        (error: Error) => ({ recordingId: undefined, error: error.message }),
      );
    finishStop();
    await finalized;

    expect(await pending).toEqual({ recordingId: announcedId, error: undefined });
  });
  const stopInFlight = async (rejectStop = false) => {
    const gate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const started = await startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("join"),
      () => ({
        stepCount: 1,
        start: async () => undefined,
        stop: async () => {
          await gate;
          if (rejectStop) {
            throw new Error("fake recorder stop failed");
          }
          return { steps: [step], stepCount: 1 };
        },
      }),
      { ownerSessionUuid: OWNER },
    );
    const stopped = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    // Observe rejection immediately while the requester joins the same stop.
    const outcome = stopped.then(
      () => undefined,
      (error: Error) => error,
    );
    return { id: started.recordingId, outcome };
  };

  const endedSessionServer = () =>
    new TestableServer(
      undefined,
      timer,
      new SessionScopedStreamAuthenticator(
        () => ({
          getSession: () => null,
          getSessionForDevice: () => null,
          getDeviceLabels: () => undefined,
        }),
        "deviceGestureRecording",
        {},
      ),
    );

  for (const surface of ["exportPlan", "socket"] as const) {
    for (const requester of ["stranger", "unknown-id"] as const) {
      test(`${surface} does not join a stranger or an unknown id`, async () => {
        const { id, outcome } = await stopInFlight();
        const recordingId = requester === "unknown-id" ? "unknown" : id;
        const sessionUuid = requester === "stranger" ? "session-b" : OWNER;
        // These must settle while the owner's recorder is still blocked on the fake gate.
        if (surface === "exportPlan") {
          const response = await ToolRegistry.getTool("exportPlan")!.handler({
            recordingId,
            sessionUuid,
          });
          const payload = toolJson(response);
          expect(payload.error).toBe("No active recording. Start a recording before exporting.");
          expect(payload.planContent).toBeUndefined();
        } else {
          await expect(
            endedSessionServer().invoke({ command: "stop", recordingId, sessionUuid }),
          ).rejects.toThrow("not an active daemon session");
        }
        finishStop();
        expect(await outcome).toBeUndefined();
      });
    }

    test(`${surface} returns its existing error path when the joined stop rejects`, async () => {
      const { id, outcome } = await stopInFlight(true);
      const pending =
        surface === "exportPlan"
          ? ToolRegistry.getTool("exportPlan")!
              .handler({ recordingId: id, sessionUuid: OWNER })
              .then((response) => toolJson(response))
          : endedSessionServer()
              .invoke({ command: "stop", recordingId: id, sessionUuid: OWNER })
              .then(
                () => ({ error: undefined }),
                (error: Error) => ({ error: error.message }),
              );
      finishStop();
      expect((await pending).error).toContain("fake recorder stop failed");
      expect(await outcome).toBeInstanceOf(Error);
    });
  }
});
