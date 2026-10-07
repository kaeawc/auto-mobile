import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS,
  decideForwardLeaseReclaim,
  decodeForwardLeaseOwnerMetadata,
  encodeForwardLeaseOwnerMetadata,
  resolveCtrlProxyForwardLeaseIdleMs,
  type DeviceLeaseOwnerStatus,
} from "../../../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";

const metadata = { socketPath: "/tmp/priv/daemon.sock", acquiredAt: 1_000 };
const idleMs = 60_000;

function status(overrides: Partial<DeviceLeaseOwnerStatus> = {}): DeviceLeaseOwnerStatus {
  return {
    pid: 4242,
    deviceId: "emulator-5600",
    sessionId: null,
    activeExecutions: 0,
    idleForMs: null,
    ...overrides,
  };
}

describe("forwarding-lease owner metadata", () => {
  test("round-trips through the single-line lock metadata", () => {
    const encoded = encodeForwardLeaseOwnerMetadata(metadata);
    expect(encoded).not.toContain("\n");
    expect(decodeForwardLeaseOwnerMetadata(encoded)).toEqual(metadata);
  });

  test("treats absent, unparseable, or malformed metadata as none", () => {
    expect(decodeForwardLeaseOwnerMetadata(undefined)).toBeUndefined();
    expect(decodeForwardLeaseOwnerMetadata("not json")).toBeUndefined();
    expect(decodeForwardLeaseOwnerMetadata(JSON.stringify({ socketPath: "" }))).toBeUndefined();
  });

  test("resolves the idle period from the environment with a 60s default", () => {
    expect(resolveCtrlProxyForwardLeaseIdleMs({})).toBe(DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS);
    expect(
      resolveCtrlProxyForwardLeaseIdleMs({ AUTOMOBILE_CTRL_PROXY_LEASE_IDLE_MS: "5000" }),
    ).toBe(5000);
    expect(resolveCtrlProxyForwardLeaseIdleMs({ AUTOMOBILE_CTRL_PROXY_LEASE_IDLE_MS: "-1" })).toBe(
      DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS,
    );
  });
});

describe("decideForwardLeaseReclaim", () => {
  test("refuses an owner that recorded no socket, keeping the pre-#10497 behaviour", () => {
    expect(
      decideForwardLeaseReclaim({ ownerPid: 4242, metadata: undefined, report: undefined, idleMs })
        .action,
    ).toBe("refuse");
  });

  test("reclaims from an owner whose socket is unreachable", () => {
    const decision = decideForwardLeaseReclaim({
      ownerPid: 4242,
      metadata,
      report: { kind: "unreachable", detail: "ECONNREFUSED" },
      idleMs,
    });
    expect(decision).toEqual({
      action: "reclaim",
      reason: "its control socket /tmp/priv/daemon.sock is unreachable (ECONNREFUSED)",
    });
  });

  test("refuses a busy owner that does not answer, or cannot report status", () => {
    for (const report of [
      { kind: "no-response", detail: "no answer within 2000ms" } as const,
      { kind: "unsupported", detail: "Unsupported daemon method" } as const,
    ]) {
      expect(decideForwardLeaseReclaim({ ownerPid: 4242, metadata, report, idleMs }).action).toBe(
        "refuse",
      );
    }
  });

  test("reclaims when the socket is now served by a different daemon", () => {
    const decision = decideForwardLeaseReclaim({
      ownerPid: 4242,
      metadata,
      report: { kind: "status", status: status({ pid: 9999, sessionId: "s-new" }) },
      idleMs,
    });
    expect(decision.action).toBe("reclaim");
    expect(decision.reason).toContain("now served by PID 9999");
  });

  test("refuses an owner with a live session and names it", () => {
    const decision = decideForwardLeaseReclaim({
      ownerPid: 4242,
      metadata,
      report: { kind: "status", status: status({ sessionId: "session-abc" }) },
      idleMs,
    });
    expect(decision).toEqual({
      action: "refuse",
      reason: "it has live session session-abc on emulator-5600",
    });
  });

  test("refuses an owner with in-flight tool calls, a stream subscriber, or recent activity", () => {
    for (const overrides of [
      { activeExecutions: 1 },
      { streaming: true },
      { idleForMs: idleMs - 1 },
    ]) {
      const decision = decideForwardLeaseReclaim({
        ownerPid: 4242,
        metadata,
        report: { kind: "status", status: status(overrides) },
        idleMs,
      });
      expect(decision.action).toBe("refuse");
    }
  });

  test("reclaims from an idle owner", () => {
    for (const idleForMs of [null, idleMs]) {
      expect(
        decideForwardLeaseReclaim({
          ownerPid: 4242,
          metadata,
          report: { kind: "status", status: status({ idleForMs }) },
          idleMs,
        }).action,
      ).toBe("reclaim");
    }
  });
});
