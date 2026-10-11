import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { VideoRecorderService } from "../../src/features/video";
import type { BootedDevice } from "../../src/models";
import {
  listActiveVideoRecordings,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../src/server/videoRecordingManager";
import { resetSegmentedSessions } from "../../src/server/videoRecordingTools";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { RealToolCallPath } from "../helpers/realToolCallPath";

const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const unheld: BootedDevice = { name: "Pixel C", deviceId: "emulator-5558", platform: "android" };
const HOLDER = "sess-holder";
const STRANGER = "sess-stranger";
const OWNER = "conn-holder";
const OTHER = "conn-stranger";

/**
 * #11647 over the real MCP ingress, with the daemon's own requester resolver: a
 * `videoRecording stop {recordingId}` that names no session is a sessionless control call on the
 * recording's device. Another connection is refused while a session holds that device; the
 * connection that acquired the holding session still stops its own recording without naming it,
 * and a recording on a device no session holds stays open.
 */
describe("videoRecording stop by id with no sessionUuid, over the MCP ingress", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let fixture: McpTestFixture | undefined;
  let backend: FakeVideoCaptureBackend;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  let archiveRoot: string;

  const stopById = (connection: string, recordingId: string) =>
    fixture!.client.callTool({
      name: "videoRecording",
      arguments: { action: "stop", recordingId, [INTERNAL_MCP_SESSION_PARAM]: connection },
    });

  const bind = (sessionUuid: string, device: BootedDevice, connection: string) =>
    pool.bindOrReuseDeviceSession(
      sessionUuid,
      device.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      connection,
    );

  const record = async (device: BootedDevice, ownerSessionUuid?: string) => {
    const active = await startVideoRecording({ device, ownerSessionUuid });
    await fsPromises.writeFile(active.outputPath, "video-bytes");
    return active.recordingId;
  };
  const activeIds = async () =>
    (await listActiveVideoRecordings()).map((active) => active.recordingId);

  const installFakeRecorder = async () => {
    backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    await setVideoRecordingManagerDependencies({
      videoRecorderService: new VideoRecorderService({
        backend,
        idGenerator: new FakeIdGenerator(),
        archiveRoot,
        now: () => new Date(timer.now()),
      }),
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
    });
  };

  beforeAll(async () => {
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-vstop-ingress-"));
    // Pay the server module's cold import outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture({ daemonMode: true });
    await warm.setup();
    // ...and the tool's first call, against fakes only.
    timer = new FakeTimer();
    await installFakeRecorder();
    await warm.client
      .callTool({ name: "videoRecording", arguments: { action: "stop", recordingId: "warm-up" } })
      .catch(() => undefined);
    resetVideoRecordingManagerDependencies();
    await warm.teardown();
    restore();
  });

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free, unheld]);
    discovery.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "video-stop-ingress-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free, unheld]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([held, free, unheld]).install();
    await bind(HOLDER, held, OWNER);
    manager.setDeviceReadiness(HOLDER, "automationReady");
    await bind(STRANGER, free, OTHER);
    manager.setDeviceReadiness(STRANGER, "automationReady");
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();

    await installFakeRecorder();
  });

  afterEach(async () => {
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    await fixture?.teardown();
    fixture = undefined;
    tools.uninstall();
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  });

  afterAll(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  test("another connection is refused and the holder's capture keeps running", async () => {
    const recordingId = await record(held, HOLDER);
    const stopsBefore = backend.stopCalls.length;

    const result = await stopById(OTHER, recordingId);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(backend.stopCalls.length).toBe(stopsBefore);
    expect(await activeIds()).toEqual([recordingId]);
  });

  test("the connection that acquired the holding session stops its recording", async () => {
    const recordingId = await record(held, HOLDER);

    const result = await stopById(OWNER, recordingId);

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain(recordingId);
    expect(await activeIds()).toEqual([]);
  });

  test("an owned recording on a device no session holds stays stoppable by anyone", async () => {
    const recordingId = await record(unheld, "sess-gone");

    const result = await stopById(OTHER, recordingId);

    expect(result.isError).not.toBe(true);
    expect(await activeIds()).toEqual([]);
  });

  test("an ownerless recording on a held device stays stoppable by anyone", async () => {
    const recordingId = await record(held);

    const result = await stopById(OTHER, recordingId);

    expect(result.isError).not.toBe(true);
    expect(await activeIds()).toEqual([]);
  });
});
