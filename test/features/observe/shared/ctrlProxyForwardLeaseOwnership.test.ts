import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS,
  decideForwardLeaseReclaim,
  decideOwnerRelinquish,
  decodeForwardLeaseOwnerMetadata,
  encodeForwardLeaseOwnerMetadata,
  resolveCtrlProxyForwardLeaseIdleMs,
  type DeviceLeaseOwnerStatus,
  type DeviceLeaseRelinquishResult,
  type ForwardLeaseRelinquishReport,
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

function relinquished(
  overrides: Partial<DeviceLeaseRelinquishResult> = {},
): ForwardLeaseRelinquishReport {
  return {
    kind: "relinquish",
    result: {
      ...status(),
      released: true,
      reason: "it reports no live session or recent activity",
      ...overrides,
    },
  };
}

describe("decideForwardLeaseReclaim", () => {
  test("refuses an owner that recorded no socket, keeping the pre-#10497 behaviour", () => {
    expect(
      decideForwardLeaseReclaim({ ownerPid: 4242, metadata: undefined, report: undefined }).action,
    ).toBe("refuse");
  });

  test("takes over from an owner whose socket is unreachable", () => {
    const decision = decideForwardLeaseReclaim({
      ownerPid: 4242,
      metadata,
      report: { kind: "unreachable", detail: "ECONNREFUSED" },
    });
    expect(decision).toEqual({
      action: "takeover",
      reason: "its control socket /tmp/priv/daemon.sock is unreachable (ECONNREFUSED)",
    });
  });

  test("refuses a busy owner that does not answer, or cannot relinquish", () => {
    for (const report of [
      { kind: "no-response", detail: "no answer within 5000ms" } as const,
      { kind: "unsupported", detail: "Unsupported daemon method" } as const,
    ]) {
      expect(decideForwardLeaseReclaim({ ownerPid: 4242, metadata, report }).action).toBe("refuse");
    }
  });

  test("takes over when the socket is now served by a different daemon", () => {
    const decision = decideForwardLeaseReclaim({
      ownerPid: 4242,
      metadata,
      report: relinquished({ pid: 9999, released: false, reason: "it has live session s-new" }),
    });
    expect(decision.action).toBe("takeover");
    expect(decision.reason).toContain("now served by PID 9999");
  });

  test("acquires normally once the owner released the lease itself", () => {
    expect(decideForwardLeaseReclaim({ ownerPid: 4242, metadata, report: relinquished() })).toEqual(
      { action: "acquire", reason: "it reports no live session or recent activity" },
    );
  });

  test("refuses with the owner's reason, transient only when the owner says so", () => {
    const transientOf = (report: ForwardLeaseRelinquishReport) => {
      const decision = decideForwardLeaseReclaim({ ownerPid: 4242, metadata, report });
      return decision.action === "refuse" ? (decision.transient ?? false) : undefined;
    };
    expect(
      decideForwardLeaseReclaim({
        ownerPid: 4242,
        metadata,
        report: relinquished({ released: false, reason: "it has live session s" }),
      }),
    ).toEqual({ action: "refuse", reason: "it has live session s" });
    expect(transientOf({ kind: "no-response", detail: "slow" })).toBe(true);
    expect(transientOf({ kind: "unsupported", detail: "old" })).toBe(false);
    expect(
      transientOf(relinquished({ released: false, reason: "used 5s ago", transient: true })),
    ).toBe(true);
  });
});

describe("decideOwnerRelinquish (#10506 review)", () => {
  test("keeps the lease with a live session and names it", () => {
    expect(decideOwnerRelinquish(status({ sessionId: "session-abc" }), idleMs)).toEqual({
      release: false,
      reason: "it has live session session-abc on emulator-5600",
    });
  });

  test("keeps the lease for in-flight tool calls, CtrlProxy requests or a stream, not transiently", () => {
    for (const overrides of [
      { activeExecutions: 1 },
      { inFlightRequests: 2 },
      { streaming: true },
    ]) {
      const decision = decideOwnerRelinquish(status(overrides), idleMs);
      expect(decision.release).toBe(false);
      expect(decision).not.toHaveProperty("transient");
    }
  });

  test("keeps the lease after recent use, as a transient refusal", () => {
    expect(decideOwnerRelinquish(status({ idleForMs: 5_000 }), idleMs)).toEqual({
      release: false,
      reason: "it used emulator-5600 5s ago",
      transient: true,
    });
  });

  test("releases when idle for the full period or never used", () => {
    for (const idleForMs of [null, idleMs]) {
      expect(decideOwnerRelinquish(status({ idleForMs }), idleMs).release).toBe(true);
    }
  });
});
