import { describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DeviceDataStreamSocketServer } from "../../src/daemon/deviceDataStreamSocketServer";
import type { OnObservationRequestedCallback } from "../../src/daemon/deviceDataStreamSocketServer";
import { DeviceAssignedToBindingError } from "../../src/daemon/sessionBroker/provisioning/refusal";
import { DeviceOwnedByOtherDaemonError } from "../../src/daemon/deviceAcquisitionRefusals";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import type { ObserveResult } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// A read must never perform control-like side effects (service rebind, CtrlProxy setup) on a
// device another session, a broker binding or another daemon holds: request_observation on such a
// device takes the connect-only read, never the session observe pipeline, and is never refused.

const SLOT_EXEC = "slot-exec-session";

class FakeStreamServer extends DeviceDataStreamSocketServer {
  handler: OnObservationRequestedCallback | null = null;

  constructor() {
    super("/fake/unused.sock", new FakeTimer(), { authorize: () => {} });
  }

  setOnObservationRequested(callback: OnObservationRequestedCallback): void {
    this.handler = callback;
  }
}

interface Internals {
  sessionManager: {
    getSession(sessionUuid: string): unknown | null;
    getSessionForDevice(deviceId: string): string | null;
    getDeviceLabels(sessionUuid: string): Record<string, string> | undefined;
  };
  devicePool: {
    getDevice(deviceId: string): unknown;
    getAllDevices(): unknown[];
    assertDeviceActionable(deviceId: string, purpose: string): void;
    assertNotAssignedToBinding(input: {
      requesterSessionUuid?: string;
      deviceId: string;
    }): Promise<void>;
    assertNotClaimedByForeignDaemon(deviceId: string): Promise<void>;
  };
  deviceDataStreamServer: unknown;
  setupDeviceDataStreamCallback(): void;
}

const observation: ObserveResult = {
  observationId: "observed",
  updatedAt: 0,
  screenSize: { width: 1, height: 1 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};

async function observeAs(options: {
  requester: string;
  localHolder?: string;
  slotHeld?: boolean;
  foreign?: "claimed" | "unreadable" | "unexpectedFailure";
  slotCheckFails?: boolean;
}): Promise<{ paths: string[]; error: string | undefined; foreignChecks: number }> {
  const db = await createTestDatabase();
  const daemon = new Daemon(
    {},
    {
      timer: new FakeTimer(),
      deviceSessionRepository: new DeviceSessionRepository(db),
      idGenerator: new CountingIdGenerator("device-session"),
    },
  );
  const internals = daemon as unknown as Internals;
  const pooled = {
    id: "device-1",
    platform: "ios",
    sessionId: options.localHolder,
  };
  internals.devicePool.getDevice = () => pooled;
  internals.devicePool.getAllDevices = () => [pooled];
  internals.devicePool.assertDeviceActionable = () => {};
  internals.sessionManager.getSession = () => ({});
  internals.sessionManager.getSessionForDevice = () => options.localHolder ?? null;
  internals.sessionManager.getDeviceLabels = () => undefined;
  internals.devicePool.assertNotAssignedToBinding = async (input) => {
    if (options.slotCheckFails) {
      throw new Error("binding registry unreadable");
    }
    if (options.slotHeld && input.requesterSessionUuid !== SLOT_EXEC) {
      throw new DeviceAssignedToBindingError("observe", input.deviceId, {
        platform: "ios",
        stableDeviceId: "Pixel_9",
        holder: "session_broker",
        scopeKey: "scope",
        bindingIndex: 0,
        scopeState: null,
        execSessionUuid: SLOT_EXEC,
      });
    }
  };
  let foreignChecks = 0;
  internals.devicePool.assertNotClaimedByForeignDaemon = async (deviceId) => {
    foreignChecks += 1;
    // The real pool skips a device a local session holds.
    if (pooled.sessionId || !options.foreign) {
      return;
    }
    if (options.foreign === "unexpectedFailure") {
      throw new Error("ownership read failed");
    }
    throw new DeviceOwnedByOtherDaemonError(
      deviceId,
      options.foreign === "claimed" ? 4242 : undefined,
    );
  };
  const stream = new FakeStreamServer();
  internals.deviceDataStreamServer = stream;
  const paths: string[] = [];
  const deviceRead = spyOn(RealObserveScreen.prototype, "executeDeviceRead").mockImplementation(
    async () => {
      paths.push("device-read");
      return observation;
    },
  );
  const sessionObserve = spyOn(RealObserveScreen.prototype, "execute").mockImplementation(
    async () => {
      paths.push("session-pipeline");
      return observation;
    },
  );
  try {
    internals.setupDeviceDataStreamCallback();
    const observations = await stream.handler!({
      deviceId: "device-1",
      sessionUuid: options.requester,
      signal: new AbortController().signal,
    });
    return { paths, error: observations[0]?.observation.error, foreignChecks };
  } finally {
    deviceRead.mockRestore();
    sessionObserve.mockRestore();
    daemon.getSessionManager().stopCleanupTimer();
    // `new Daemon` publishes this fake-laden manager and pool on the process-wide DaemonState;
    // leaving it initialized breaks every later file that reads the session manager (#11614).
    DaemonState.getInstance().reset();
  }
}

describe("request_observation on a device someone else holds", () => {
  test("a viewer on an idle binding device takes the connect-only read", async () => {
    const { paths, error } = await observeAs({ requester: "viewer", slotHeld: true });
    expect(error).toBeUndefined();
    expect(paths).toEqual(["device-read"]);
  });

  test("the binding's own execution keeps the session pipeline", async () => {
    const { paths } = await observeAs({ requester: SLOT_EXEC, slotHeld: true });
    expect(paths).toEqual(["session-pipeline"]);
  });

  test("a viewer on a device another daemon claims takes the connect-only read", async () => {
    const { paths, error } = await observeAs({ requester: "viewer", foreign: "claimed" });
    expect(error).toBeUndefined();
    expect(paths).toEqual(["device-read"]);
  });

  test("an unreadable foreign claim takes the conservative connect-only read", async () => {
    const { paths } = await observeAs({ requester: "viewer", foreign: "unreadable" });
    expect(paths).toEqual(["device-read"]);
  });

  test("an ownership lookup that fails outright takes the connect-only read", async () => {
    const foreign = await observeAs({ requester: "viewer", foreign: "unexpectedFailure" });
    expect(foreign.paths).toEqual(["device-read"]);
    const binding = await observeAs({ requester: "viewer", slotCheckFails: true });
    expect(binding.paths).toEqual(["device-read"]);
  });

  test("a free device keeps the session pipeline", async () => {
    const { paths } = await observeAs({ requester: "viewer" });
    expect(paths).toEqual(["session-pipeline"]);
  });

  test("a local holder is classified without a cross-daemon lookup", async () => {
    const viewer = await observeAs({ requester: "viewer", localHolder: "owner" });
    expect(viewer.paths).toEqual(["device-read"]);
    expect(viewer.foreignChecks).toBe(0);
    const owner = await observeAs({ requester: "owner", localHolder: "owner" });
    expect(owner.paths).toEqual(["session-pipeline"]);
    expect(owner.foreignChecks).toBe(0);
  });
});
