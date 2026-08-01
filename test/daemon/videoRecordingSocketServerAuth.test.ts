import { describe, expect, test } from "bun:test";
import { VideoRecordingSocketServer } from "../../src/daemon/videoRecordingSocketServer";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import type { VideoRecordingConfig, VideoRecordingConfigInput } from "../../src/models";
import { ActionableError } from "../../src/models";

function makeConfig(overrides: Partial<VideoRecordingConfig> = {}): VideoRecordingConfig {
  return {
    qualityPreset: "low",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 5,
    fps: 15,
    maxArchiveSizeMb: 100,
    format: "mp4",
    ...overrides,
  };
}

class TestableServer extends VideoRecordingSocketServer {
  invoke(request: Parameters<TestableServer["handleRequest"]>[0]) {
    return this.handleRequest(request);
  }
}

function authenticator(
  calls: Array<{ sessionUuid?: string }>
): StreamSocketAuthenticator {
  return {
    authorize: input => {
      calls.push({ sessionUuid: input.sessionUuid });
      if (input.sessionUuid !== "live") {
        throw new ActionableError(`rejected session ${input.sessionUuid}`);
      }
    },
  };
}

describe("VideoRecordingSocketServer config authorization (issue #4752)", () => {
  test("rejects config/set from an unauthenticated caller before eviction can run", async () => {
    const calls: Array<{ sessionUuid?: string }> = [];
    let updateCalled = false;
    const server = new TestableServer(
      undefined,
      undefined,
      {
        getConfig: async () => makeConfig(),
        updateConfig: async () => {
          updateCalled = true;
          return { config: makeConfig(), evictedRecordingIds: ["evicted"] };
        },
      },
      authenticator(calls)
    );

    await expect(
      server.invoke({
        id: "1",
        type: "video_recording_request",
        method: "config/set",
        params: { config: { maxArchiveSizeMb: 1 } as VideoRecordingConfigInput },
      })
    ).rejects.toThrow(/rejected session/);
    expect(updateCalled).toBe(false);
    expect(calls).toEqual([{ sessionUuid: undefined }]);
  });

  test("allows config/set from a live session", async () => {
    const calls: Array<{ sessionUuid?: string }> = [];
    const server = new TestableServer(
      undefined,
      undefined,
      {
        getConfig: async () => makeConfig(),
        updateConfig: async () => ({ config: makeConfig({ maxArchiveSizeMb: 1 }), evictedRecordingIds: [] }),
      },
      authenticator(calls)
    );

    const response = await server.invoke({
      id: "2",
      type: "video_recording_request",
      method: "config/set",
      sessionUuid: "live",
      params: { config: { maxArchiveSizeMb: 1 } as VideoRecordingConfigInput },
    });
    expect(response.success).toBe(true);
    expect(response.result?.config.maxArchiveSizeMb).toBe(1);
    expect(calls).toEqual([{ sessionUuid: "live" }]);
  });

  test("config/get is not gated by the authenticator", async () => {
    const calls: Array<{ sessionUuid?: string }> = [];
    const server = new TestableServer(
      undefined,
      undefined,
      {
        getConfig: async () => makeConfig({ fps: 30 }),
        updateConfig: async () => ({ config: makeConfig(), evictedRecordingIds: [] }),
      },
      authenticator(calls)
    );

    const response = await server.invoke({
      id: "3",
      type: "video_recording_request",
      method: "config/get",
    });
    expect(response.success).toBe(true);
    expect(response.result?.config.fps).toBe(30);
    expect(calls).toEqual([]);
  });
});
