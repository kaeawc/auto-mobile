import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep } from "../../../src/models";
import type { SessionManager } from "../../../src/daemon/sessionManager";
import { SessionScopedStreamAuthenticator } from "../../../src/daemon/streamSocketAuth";
import { TestRecordingSocketServer } from "../../../src/daemon/testRecordingSocketServer";
import type { TestRecordingCommand } from "../../../src/daemon/testRecordingSocketTypes";
import { registerPlanTools } from "../../../src/server/planTools";
import {
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
} from "../../../src/server/recordingSessionCleanup";
import {
  resetStoppedTestRecordings,
  startTestRecording,
  stopTestRecording,
} from "../../../src/server/testRecordingManager";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

isolateToolRegistry();

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };
const OWNER = "session-a";

class TestableServer extends TestRecordingSocketServer {
  invoke(request: TestRecordingCommand) {
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
 * flight. `stopTestRecording(recordingId)` already joins a stop in flight, but neither surface
 * reaches it: both gate on `getTestRecordingStatus()`, which is null once the stop has begun, and
 * the retained plan does not exist until the stop ends.
 *
 * So the previous owner, fetching the id it was just handed, is told "No active recording. Start
 * a recording before exporting." by exportPlan and "not an active daemon session" by the socket
 * stop. A moment later the same request returns the plan.
 */
describe("the previous owner fetches the announced test recording while its release-time stop is in flight", () => {
  let finishStop!: () => void;
  const timer = new FakeTimer();

  beforeAll(() => {
    if (!ToolRegistry.getTool("exportPlan")) {
      registerPlanTools();
    }
  });

  afterEach(async () => {
    finishStop();
    await stopTestRecording(undefined, undefined, timer).catch(() => undefined);
    resetStoppedTestRecordings();
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
    await startTestRecording(
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
      OWNER,
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
    const payload = JSON.parse((await pending).content?.[0]?.text ?? "{}");

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
        "testRecording",
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
});
