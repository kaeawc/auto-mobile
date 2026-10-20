import { describe, it, expect, beforeEach } from "bun:test";
import {
  ConfigSocketRequest,
  ConfigSocketServer,
} from "../../../src/daemon/socketServer/ConfigSocketServer";
import { DeviceSnapshotSocketServer } from "../../../src/daemon/deviceSnapshotSocketServer";
import { DEFAULT_DEVICE_SNAPSHOT_CONFIG } from "../../../src/models/DeviceSnapshotConfigDefaults";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../../src/models/VideoRecordingConfigParsing";
import { VideoRecordingSocketServer } from "../../../src/daemon/videoRecordingSocketServer";
import type {
  DeviceSnapshotConfig,
  DeviceSnapshotConfigInput,
  VideoRecordingConfig,
  VideoRecordingConfigInput,
} from "../../../src/models";
import { FakeSocket } from "../../fakes/FakeNetServer";
import { FakeTimer } from "../../fakes/FakeTimer";

interface TestConfig {
  enabled: boolean;
  limit: number;
}

interface TestConfigInput {
  enabled?: boolean;
  limit?: number;
}

type DeviceSnapshotSocketRequest = ConfigSocketRequest<
  "device_snapshot_request",
  DeviceSnapshotConfigInput
>;
type VideoRecordingSocketRequest = ConfigSocketRequest<
  "video_recording_request",
  VideoRecordingConfigInput
>;

type TestRequest = ConfigSocketRequest<"test_config_request", TestConfigInput>;

class TestableConfigSocketServer extends ConfigSocketServer<
  TestConfig,
  TestConfigInput,
  "test_config_request",
  "test_config_response",
  "evictedItemIds"
> {
  public getCalls = 0;
  public updateCalls: Array<TestConfigInput | null> = [];
  public nextConfig: TestConfig = { enabled: true, limit: 5 };
  public nextEvictedItemIds: string[] = [];

  constructor(timer: FakeTimer) {
    super({
      socketPath: "/fake/path/config.sock",
      timer,
      serverName: "TestConfig",
      responseType: "test_config_response",
      evictedKey: "evictedItemIds",
      methodLabel: "test config",
      getConfig: async () => {
        this.getCalls += 1;
        return this.nextConfig;
      },
      updateConfig: async (update) => {
        this.updateCalls.push(update);
        return {
          config: this.nextConfig,
          evictedItems: this.nextEvictedItemIds,
        };
      },
    });
  }

  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket, line);
    const pending = this.pendingBySocket.get(socket);
    if (pending) {
      await pending;
    }
  }
}

describe("ConfigSocketServer", () => {
  let timer: FakeTimer;
  let server: TestableConfigSocketServer;
  let socket: FakeSocket;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    server = new TestableConfigSocketServer(timer);
    socket = new FakeSocket();
  });

  it("returns config for config/get requests", async () => {
    const request: TestRequest = {
      id: "get-1",
      type: "test_config_request",
      method: "config/get",
    };

    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages();
    expect(server.getCalls).toBe(1);
    expect(messages).toEqual([
      {
        id: "get-1",
        type: "test_config_response",
        success: true,
        result: { config: { enabled: true, limit: 5 } },
      },
    ]);
  });

  it("passes config/set updates through and includes non-empty evictions under the configured key", async () => {
    server.nextConfig = { enabled: false, limit: 3 };
    server.nextEvictedItemIds = ["old-1", "old-2"];
    const request: TestRequest = {
      id: "set-1",
      type: "test_config_request",
      method: "config/set",
      params: {
        config: { enabled: false },
      },
    };

    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages();
    expect(server.updateCalls).toEqual([{ enabled: false }]);
    expect(messages).toEqual([
      {
        id: "set-1",
        type: "test_config_response",
        success: true,
        result: {
          config: { enabled: false, limit: 3 },
          evictedItemIds: ["old-1", "old-2"],
        },
      },
    ]);
  });

  it("passes null config/set updates through and omits empty eviction arrays", async () => {
    const request: TestRequest = {
      id: "reset-1",
      type: "test_config_request",
      method: "config/set",
      params: {
        config: null,
      },
    };

    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages();
    expect(server.updateCalls).toEqual([null]);
    expect(messages).toEqual([
      {
        id: "reset-1",
        type: "test_config_response",
        success: true,
        result: {
          config: { enabled: true, limit: 5 },
        },
      },
    ]);
  });

  it("returns an error response when config/set omits params.config", async () => {
    const request: TestRequest = {
      id: "bad-set",
      type: "test_config_request",
      method: "config/set",
    };

    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages();
    expect(server.updateCalls).toEqual([]);
    expect(messages).toEqual([
      {
        id: "bad-set",
        type: "test_config_response",
        success: false,
        error: "config/set requires params.config",
      },
    ]);
  });

  it("returns an error response for unsupported methods", async () => {
    const request = {
      id: "bad-method",
      type: "test_config_request",
      method: "config/delete",
    };

    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages();
    expect(messages).toEqual([
      {
        id: "bad-method",
        type: "test_config_response",
        success: false,
        error: "Unsupported test config method: config/delete",
      },
    ]);
  });
});

class SimulatedDeviceSnapshotSocketServer extends DeviceSnapshotSocketServer {
  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket, line);
    await this.pendingBySocket.get(socket);
  }
}

class SimulatedVideoRecordingSocketServer extends VideoRecordingSocketServer {
  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket, line);
    await this.pendingBySocket.get(socket);
  }
}

describe("config socket wrappers", () => {
  it("keeps the device snapshot response type and eviction key", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const socket = new FakeSocket();
    const config: DeviceSnapshotConfig = {
      ...DEFAULT_DEVICE_SNAPSHOT_CONFIG,
      includeAppData: true,
    };
    const updates: Array<DeviceSnapshotConfigInput | null> = [];
    const server = new SimulatedDeviceSnapshotSocketServer("/fake/path/device.sock", timer, {
      getConfig: async () => config,
      updateConfig: async (update) => {
        updates.push(update);
        return {
          config,
          evictedSnapshotNames: ["snapshot-a"],
        };
      },
    });
    const request: DeviceSnapshotSocketRequest = {
      id: "device-set",
      type: "device_snapshot_request",
      method: "config/set",
      params: {
        config: { includeAppData: true },
      },
    };

    await server.simulateLine(socket, JSON.stringify(request));

    expect(updates).toEqual([{ includeAppData: true }]);
    expect(socket.getWrittenMessages()).toEqual([
      {
        id: "device-set",
        type: "device_snapshot_response",
        success: true,
        result: {
          config,
          evictedSnapshotNames: ["snapshot-a"],
        },
      },
    ]);
  });

  it("keeps the video recording response type and eviction key", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const socket = new FakeSocket();
    const config: VideoRecordingConfig = { ...DEFAULT_VIDEO_RECORDING_CONFIG, format: "mp4" };
    const updates: Array<VideoRecordingConfigInput | null> = [];
    const server = new SimulatedVideoRecordingSocketServer(
      "/fake/path/video.sock",
      timer,
      {
        getConfig: async () => config,
        updateConfig: async (update) => {
          updates.push(update);
          return {
            config,
            evictedRecordingIds: ["recording-a"],
          };
        },
      },
      // This suite exercises the config wrapper, not the auth gate (covered in
      // videoRecordingSocketServerAuth.test.ts); inject a permissive authenticator.
      { authorize: () => {} },
    );
    const request: VideoRecordingSocketRequest = {
      id: "video-set",
      type: "video_recording_request",
      method: "config/set",
      params: {
        config: { format: "mp4" },
      },
    };

    await server.simulateLine(socket, JSON.stringify(request));

    expect(updates).toEqual([{ format: "mp4" }]);
    expect(socket.getWrittenMessages()).toEqual([
      {
        id: "video-set",
        type: "video_recording_response",
        success: true,
        result: {
          config,
          evictedRecordingIds: ["recording-a"],
        },
      },
    ]);
  });
});
