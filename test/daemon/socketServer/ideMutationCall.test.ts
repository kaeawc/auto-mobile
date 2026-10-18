import { describe, expect, test } from "bun:test";
import { runTrackedIdeMutation } from "../../../src/daemon/socketServer/ideMutationCall";
import { buildIdeStatus } from "../../../src/daemon/socketServer/ideStatus";
import { executionTracker } from "../../../src/server/executionTracker";
import { getAbortSignal } from "../../../src/utils/AbortContext";

describe("runTrackedIdeMutation", () => {
  test("keeps the tracked execution in flight until the route settles, then ends it", async () => {
    const execution = executionTracker.startExecution("ide/test", undefined, "holder-session");
    const before = executionTracker.getActiveExecutionCount();
    let during = -1;
    const result = await runTrackedIdeMutation("sock", async (call) => {
      expect(call.socketSessionId).toBe("sock");
      call.track(execution, true);
      during = executionTracker.getActiveExecutionCount();
      return "done";
    });
    expect(result).toBe("done");
    expect(during).toBe(before);
    expect(executionTracker.getActiveExecutionCount()).toBe(before - 1);
  });

  test("runs the route under the owner's abort signal", async () => {
    const owner = new AbortController();
    const seen: AbortSignal[] = [];
    await runTrackedIdeMutation(
      undefined,
      async () => {
        const signal = getAbortSignal();
        if (signal) {
          seen.push(signal);
        }
      },
      owner.signal,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(false);
  });

  test("refuses to start when the owner already aborted", async () => {
    const owner = new AbortController();
    owner.abort(new Error("gone"));
    let ran = false;
    await expect(
      runTrackedIdeMutation(
        undefined,
        async () => {
          ran = true;
        },
        owner.signal,
      ),
    ).rejects.toThrow("gone");
    expect(ran).toBe(false);
  });
});

describe("buildIdeStatus", () => {
  test("reports identity fields and a capability fingerprint only when one is set", () => {
    const source = {
      daemonIdentity: {
        version: "1.2.3",
        build: { buildId: "b1", entryScript: "/e.js" },
      } as never,
      identityStartedAt: 10,
      identityProcessStartedAt: 5,
      identityDbPath: "/db",
      identityPidFilePath: "/pid",
      identitySockets: { control: "/s" },
      socketPath: "/s",
      startupOptions: {} as never,
      processGenerationToken: undefined,
      acceptanceDiscoveryCapability: undefined,
    };
    const plain = buildIdeStatus(source);
    expect(plain.version).toBe("1.2.3");
    expect(plain.buildId).toBe("b1");
    expect(plain.startedAt).toBe(10);
    expect(plain.reportedSocketPath).toBe("/s");
    expect(plain.acceptanceCapabilityFingerprint).toBeNull();
    const withCap = buildIdeStatus({ ...source, acceptanceDiscoveryCapability: "secret" });
    expect(withCap.acceptanceCapabilityFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});
