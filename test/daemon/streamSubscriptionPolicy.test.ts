import { describe, expect, test } from "bun:test";
import {
  assertMayControl,
  classifyStreamMessage,
  decideLifecycleEvent,
  decideOwnershipChange,
  subscriptionKindForIdentity,
  ViewerReadOnlyError,
  type StreamSubscriptionKind,
  type StreamSubscriptionEndReason,
} from "../../src/daemon/streamSubscriptionPolicy";
import { ActionableError } from "../../src/models/ActionableError";

describe("transport-independent subscription policy", () => {
  test("ownership decisions preserve viewers, downgrade live owners, and end lost identities", () => {
    for (const kind of ["owner", "viewer"] as const) {
      for (const ownsDevice of [false, true]) {
        expect(
          decideOwnershipChange({ kind, authEnabled: true, sessionExists: false, ownsDevice }),
        ).toEqual({ action: "end", reason: "session_ended" });
        expect(
          decideOwnershipChange({ kind, authEnabled: false, sessionExists: false, ownsDevice }),
        ).toEqual({ action: "keep" });
        expect(
          decideOwnershipChange({ kind, authEnabled: true, sessionExists: true, ownsDevice }),
        ).toEqual({ action: kind === "owner" && !ownsDevice ? "downgrade" : "keep" });
      }
    }
  });
  test("subscribe kind reflects ownership, with owner semantics when auth is disabled", () => {
    expect(
      subscriptionKindForIdentity({ authEnabled: true, sessionExists: true, ownsDevice: false }),
    ).toBe("viewer");
    expect(
      subscriptionKindForIdentity({ authEnabled: true, sessionExists: true, ownsDevice: true }),
    ).toBe("owner");
    expect(
      subscriptionKindForIdentity({ authEnabled: false, sessionExists: false, ownsDevice: false }),
    ).toBe("owner");
  });
  test("all lifecycle events end both kinds with typed reasons", () => {
    for (const kind of ["owner", "viewer"] as const) {
      for (const event of ["device_removed", "identity_quarantined", "daemon_shutdown"] as const) {
        expect(decideLifecycleEvent({ kind, event })).toEqual({ action: "end", reason: event });
      }
    }
  });
  test("control table distinguishes handshake, ignored relay input and WebRTC reads", () => {
    expect(classifyStreamMessage({ transport: "video_relay", action: "subscribe" })).toBe(
      "admission",
    );
    for (const action of ["subscribe", "stop", "status", "garbage"]) {
      expect(classifyStreamMessage({ transport: "video_relay", action, postHandshake: true })).toBe(
        "mutating",
      );
    }
    for (const action of ["start", "stop"] as const) {
      expect(classifyStreamMessage({ transport: "webrtc", action })).toBe("mutating");
      expect(() => assertMayControl("viewer", { transport: "webrtc", action })).toThrow(
        ViewerReadOnlyError,
      );
    }
    for (const action of ["status", "list", "await"] as const) {
      expect(classifyStreamMessage({ transport: "webrtc", action })).toBe("read");
      expect(() => assertMayControl("viewer", { transport: "webrtc", action })).not.toThrow();
    }
    for (const kind of ["owner", "viewer"] as StreamSubscriptionKind[]) {
      expect(() =>
        assertMayControl(kind, { transport: "video_relay", action: "subscribe" }),
      ).not.toThrow();
    }
    expect(() => assertMayControl("owner", { transport: "webrtc", action: "start" })).not.toThrow();
    const error = new ViewerReadOnlyError();
    expect(error).toBeInstanceOf(ActionableError);
    expect(error.code).toBe("viewer_read_only");
  });
});

test("own-lease release/renew is distinct from stream control; unknown actions fail closed", () => {
  for (const action of ["start", "stop"]) {
    expect(classifyStreamMessage({ transport: "webrtc", action, target: "own_lease" })).toBe(
      "own_lease",
    );
    expect(() =>
      assertMayControl("viewer", { transport: "webrtc", action, target: "own_lease" }),
    ).not.toThrow();
    expect(classifyStreamMessage({ transport: "webrtc", action, target: "stream" })).toBe(
      "mutating",
    );
  }
  for (const action of ["status", "list", "await"]) {
    expect(classifyStreamMessage({ transport: "webrtc", action, target: "own_lease" })).toBe(
      "read",
    );
  }
  for (const action of ["garbage", "constructor", "toString"]) {
    expect(classifyStreamMessage({ transport: "webrtc", action, target: "own_lease" })).toBe(
      "mutating",
    );
    expect(() =>
      assertMayControl("viewer", { transport: "webrtc", action, target: "own_lease" }),
    ).toThrow(ViewerReadOnlyError);
  }
});

test("owner stop is an end reason but never a lifecycle or ownership outcome", () => {
  const reason: StreamSubscriptionEndReason = "stopped_by_owner";
  expect(reason).toBe("stopped_by_owner");
  // Compile-only contract assertions; owner stops do not enter the lifecycle dispatcher.
  if (false) {
    // @ts-expect-error Owner stop is not a device lifecycle event.
    decideLifecycleEvent({ kind: "viewer", event: reason });
    // @ts-expect-error Ownership reconciliation can only end a missing session.
    const decision: ReturnType<typeof decideOwnershipChange> = { action: "end", reason };
    void decision;
  }
});
