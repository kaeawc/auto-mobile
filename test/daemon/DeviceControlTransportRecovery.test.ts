import { describe, expect, test } from "bun:test";
import {
  DeviceControlTransportRecovery,
  isRetryableSessionRecoveryResult,
  type BoundSessionRecoveryPort,
} from "../../src/daemon/socketServer/DeviceControlTransportRecovery";
import { ReleasedBoundSessionError } from "../../src/daemon/socketServer/ReleasedBoundSessionError";

type Release = ReturnType<BoundSessionRecoveryPort["terminalReleaseSnapshot"]>;

/** #11815: bound-session recovery admission, driven through an injected release port. */
class FakeRecoveryPort implements BoundSessionRecoveryPort {
  readonly calls: string[] = [];
  inWindow: boolean | undefined = false;
  windowError: Error | undefined;
  terminal: Release;
  expired: Release;
  expiredError: Error | undefined;

  async isReleasedSessionInRestartRecoveryWindow(sessionUuid: string) {
    this.calls.push(`window:${sessionUuid}`);
    if (this.windowError) {
      throw this.windowError;
    }
    return this.inWindow;
  }

  terminalReleaseSnapshot(sessionUuid: string): Release {
    this.calls.push(`terminal:${sessionUuid}`);
    return this.terminal;
  }

  async expiredReleaseSnapshot(sessionUuid: string): Promise<Release> {
    this.calls.push(`expired:${sessionUuid}`);
    if (this.expiredError) {
      throw this.expiredError;
    }
    return this.expired;
  }
}

function pendingResponse(error: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ success: false, error }) }],
    structuredContent: { success: false, error },
  };
}

async function rejection(promise: Promise<unknown>): Promise<ReleasedBoundSessionError> {
  try {
    await promise;
  } catch (error) {
    return error as ReleasedBoundSessionError;
  }
  throw new Error("expected rejection");
}

describe("DeviceControlTransportRecovery.withAdmittedBoundSession", () => {
  test("a healthy session forwards synchronously without touching the port", () => {
    const port = new FakeRecoveryPort();
    const recovery = new DeviceControlTransportRecovery(port);
    const seen: Array<string | undefined> = [];

    const result = recovery.withAdmittedBoundSession(undefined, (recoverable) => {
      seen.push(recoverable);
      return "forwarded";
    });

    expect(result).toBe("forwarded");
    expect(seen).toEqual([undefined]);
    expect(port.calls).toEqual([]);
  });

  test("a release inside the restart window forwards with the recoverable session", async () => {
    const port = new FakeRecoveryPort();
    port.inWindow = true;
    const recovery = new DeviceControlTransportRecovery(port);
    const seen: Array<string | undefined> = [];

    const pending = recovery.withAdmittedBoundSession("s-1", (recoverable) => {
      seen.push(recoverable);
      return 42;
    });

    expect(seen).toEqual([]);
    expect(await pending).toBe(42);
    expect(seen).toEqual(["s-1"]);
    expect(port.calls).toEqual(["window:s-1"]);
  });

  test("the window is consulted synchronously, before the first await settles", async () => {
    const port = new FakeRecoveryPort();
    port.inWindow = true;
    const pending = new DeviceControlTransportRecovery(port).withAdmittedBoundSession(
      "s-1",
      () => 1,
    );
    expect(port.calls).toEqual(["window:s-1"]);
    await pending;
  });

  test("a terminal release outside the window fails with that release", async () => {
    const port = new FakeRecoveryPort();
    port.terminal = { releaseReason: "idle-timeout" } as Release;
    const error = await rejection(
      Promise.resolve(
        new DeviceControlTransportRecovery(port).withAdmittedBoundSession("s-1", () => 1),
      ),
    );

    expect(error).toBeInstanceOf(ReleasedBoundSessionError);
    expect(error.failure.sessionUuid).toBe("s-1");
    expect(error.failure.reason).toBe("idle-timeout");
    expect(error.failure.release).toEqual({ releaseReason: "idle-timeout" } as Release);
    expect(port.calls).toEqual(["window:s-1", "terminal:s-1"]);
  });

  test("with no terminal release it reports the expired release", async () => {
    const port = new FakeRecoveryPort();
    port.expired = { releaseReason: "expired" } as Release;
    const error = await rejection(
      Promise.resolve(
        new DeviceControlTransportRecovery(port).withAdmittedBoundSession("s-1", () => 1),
      ),
    );

    expect(error.failure.reason).toBe("expired");
    expect(port.calls).toEqual(["window:s-1", "terminal:s-1", "expired:s-1"]);
  });

  test("a failed expired read keeps the fail-closed not-found answer", async () => {
    const port = new FakeRecoveryPort();
    port.expiredError = new Error("db down");
    const error = await rejection(
      Promise.resolve(
        new DeviceControlTransportRecovery(port).withAdmittedBoundSession("s-1", () => 1),
      ),
    );

    expect(error.failure.reason).toBe("session-not-found");
    expect(error.failure.release).toBeUndefined();
  });

  test("a failed window read falls through to the terminal release", async () => {
    const port = new FakeRecoveryPort();
    port.windowError = new Error("window unreadable");
    port.terminal = { releaseReason: "manual" } as Release;
    const error = await rejection(
      Promise.resolve(
        new DeviceControlTransportRecovery(port).withAdmittedBoundSession("s-1", () => 1),
      ),
    );

    expect(error.failure.reason).toBe("manual");
  });
});

describe("isRetryableSessionRecoveryResult", () => {
  const retryable = { code: "session_recovery_pending", retryable: true, sessionUuid: "s-1" };

  test("accepts a retryable pending error naming the session", () => {
    expect(isRetryableSessionRecoveryResult(pendingResponse(retryable), "s-1")).toBe(true);
  });

  test("rejects another session, a non-retryable error and other codes", () => {
    expect(isRetryableSessionRecoveryResult(pendingResponse(retryable), "s-2")).toBe(false);
    expect(
      isRetryableSessionRecoveryResult(pendingResponse({ ...retryable, retryable: false }), "s-1"),
    ).toBe(false);
    expect(
      isRetryableSessionRecoveryResult(pendingResponse({ ...retryable, code: "other" }), "s-1"),
    ).toBe(false);
  });

  test("rejects successes and non-object responses", () => {
    expect(isRetryableSessionRecoveryResult(undefined, "s-1")).toBe(false);
    expect(isRetryableSessionRecoveryResult("x", "s-1")).toBe(false);
    expect(isRetryableSessionRecoveryResult({ content: [] }, "s-1")).toBe(false);
  });
});
