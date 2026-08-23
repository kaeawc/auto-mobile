import { describe, expect, test } from "bun:test";
import { TestRecordingSocketServer } from "../../src/daemon/testRecordingSocketServer";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import type { TestRecordingCommand } from "../../src/daemon/testRecordingSocketTypes";
import { ActionableError } from "../../src/models";

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

describe("TestRecordingSocketServer authorization (issue #4752)", () => {
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
    expect(calls).toEqual([{ sessionUuid: undefined, deviceId: undefined }]);
  });

  test("a live session passes the gate; status then returns the (empty) recording state", async () => {
    const calls: Array<{ sessionUuid?: string; deviceId?: string }> = [];
    const server = new TestableServer(undefined, undefined, recordingAuthenticator(calls));
    const response = await server.invoke({ command: "status", sessionUuid: "live" });
    expect(response.success).toBe(true);
    expect(calls).toEqual([{ sessionUuid: "live", deviceId: undefined }]);
  });
});
