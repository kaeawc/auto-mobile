import { describe, expect, test } from "bun:test";
import { DaemonBoundSessionExpiredError } from "../../../src/daemon/proxy/daemonErrors";
import {
  HeldSessionLosses,
  type HeldSessionLossesPort,
} from "../../../src/daemon/proxy/HeldSessionLosses";
import type { StallHandoverRecord } from "../../../src/daemon/proxy/ProxySessionState";

function harness() {
  const sessionPlatforms = new Map<string, "android" | "ios">([
    ["held-a", "android"],
    ["held-i", "ios"],
    ["bound", "android"],
  ]);
  const state = {
    bound: undefined as string | undefined,
    terminal: undefined as string | undefined,
    others: new Set<string>(),
    stalls: new Map<string, StallHandoverRecord>(),
    sessionless: true,
  };
  const reported: Array<Record<string, unknown>> = [];
  const surfaced: unknown[] = [];
  const port: HeldSessionLossesPort = {
    boundSessionUuid: () => state.bound,
    terminalBoundSessionUuid: () => state.terminal,
    isOtherHeldSession: (id) => state.others.has(id),
    otherHeldSessionUuids: () => state.others.keys(),
    stallHandover: (id) => state.stalls.get(id),
    isSessionlessControlDeviceTool: () => state.sessionless,
    sessionUuidFromArgs: (args) =>
      typeof args.sessionUuid === "string" ? args.sessionUuid : undefined,
    reportPendingSessionLoss: (args) => {
      reported.push(args);
    },
    noteReleaseSurfacedBy: (answer) => {
      surfaced.push(answer);
    },
  };
  return { losses: new HeldSessionLosses(sessionPlatforms, port), state, reported, surfaced };
}

describe("HeldSessionLosses", () => {
  test("records a loss only for a tracked held session that is neither bound nor terminal", () => {
    const h = harness();
    h.state.others.add("held-a");
    h.losses.recordTerminalLoss("held-a", "idle");
    expect(h.losses.pending.get("held-a")).toMatchObject({ platform: "android", reason: "idle" });

    h.losses.recordTerminalLoss("unknown", "idle");
    h.state.bound = "held-i";
    h.state.others.add("held-i");
    h.losses.recordTerminalLoss("held-i", "idle");
    h.state.bound = undefined;
    // Held and not the latest binding, but it is the terminal binding: no platform report for it.
    h.state.others.add("bound");
    h.state.terminal = "bound";
    h.losses.recordTerminalLoss("bound", "idle");
    expect([...h.losses.pending.keys()]).toEqual(["held-a"]);
  });

  test("a session handed over as the latest binding is not recorded as a held loss", () => {
    const h = harness();
    h.state.stalls.set("held-a", { restore: { bound: true } } as StallHandoverRecord);
    h.losses.recordTerminalLoss("held-a");
    expect(h.losses.pending.size).toBe(0);
    h.state.stalls.set("held-a", { restore: { bound: false } } as StallHandoverRecord);
    h.losses.recordTerminalLoss("held-a");
    expect(h.losses.pending.get("held-a")?.reason).toBe("released");
  });

  test("a second record keeps the specific reason and the latest release evidence", () => {
    const h = harness();
    h.state.others.add("held-a");
    h.losses.recordTerminalLoss("held-a", "daemon_restart");
    h.losses.recordTerminalLoss("held-a", "released");
    expect(h.losses.pending.get("held-a")?.reason).toBe("daemon_restart");
    h.losses.recordTerminalLoss("held-a", "idle", undefined, true);
    expect(h.losses.pending.get("held-a")).toMatchObject({ reason: "idle", proxyJudged: true });
  });

  test("only a not-found answer that ended the session records a loss", () => {
    const h = harness();
    h.state.others.add("held-a");
    h.losses.recordNotFoundLoss("held-a", { kind: "pending" } as never);
    expect(h.losses.pending.size).toBe(0);
    h.losses.recordNotFoundLoss("held-a", { kind: "ended", reason: "gone" } as never);
    expect(h.losses.pending.get("held-a")?.reason).toBe("gone");
  });

  test("selecting a session clears its loss and its platform's losses", () => {
    const h = harness();
    h.state.others.add("held-a").add("held-i");
    h.losses.recordTerminalLoss("held-a");
    h.losses.recordTerminalLoss("held-i");
    h.losses.clearForSelection("bound", undefined);
    expect([...h.losses.pending.keys()]).toEqual(["held-i"]);
    h.losses.clearForSelection("unknown", "ios");
    expect(h.losses.pending.size).toBe(0);
  });

  test("a platform-only control call reports the first loss for that platform once", () => {
    const h = harness();
    h.state.others.add("held-a");
    h.losses.recordTerminalLoss("held-a", "idle");
    // The lost session is no longer held, so it does not count as a live session of its platform.
    h.state.others.delete("held-a");
    let thrown: unknown;
    try {
      h.losses.reportPlatformLoss("setActiveDevice", { platform: "android" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DaemonBoundSessionExpiredError);
    expect(h.reported).toEqual([{ sessionUuid: "held-a" }]);
    expect(h.surfaced).toEqual([thrown]);
  });

  test.each([
    ["a terminal binding exists", (h: ReturnType<typeof harness>) => (h.state.terminal = "x")],
    [
      "the tool is not a sessionless control tool",
      (h: ReturnType<typeof harness>) => (h.state.sessionless = false),
    ],
  ])("no report when %s", (_name, arrange) => {
    const h = harness();
    h.state.others.add("held-a");
    h.losses.recordTerminalLoss("held-a");
    h.state.others.delete("held-a");
    arrange(h);
    expect(() =>
      h.losses.reportPlatformLoss("setActiveDevice", { platform: "android" }),
    ).not.toThrow();
    expect(h.losses.pending.size).toBe(1);
  });

  test.each([
    ["an explicit deviceId", { platform: "android", deviceId: "emulator-5554" }],
    ["a named session", { platform: "android", sessionUuid: "s" }],
    ["a device object", { platform: "android", device: { id: 1 } }],
    ["another platform", { platform: "ios" }],
  ])("no report with %s", (_name, args) => {
    const h = harness();
    h.state.others.add("held-a");
    h.losses.recordTerminalLoss("held-a");
    h.state.others.delete("held-a");
    expect(() => h.losses.reportPlatformLoss("setActiveDevice", args)).not.toThrow();
    expect(h.losses.pending.size).toBe(1);
  });

  test("a live session of the same platform clears the platform's losses instead of reporting", () => {
    const h = harness();
    h.state.others.add("held-a");
    h.losses.recordTerminalLoss("held-a");
    h.state.bound = "bound";
    expect(() =>
      h.losses.reportPlatformLoss("setActiveDevice", { platform: "android" }),
    ).not.toThrow();
    expect(h.losses.pending.size).toBe(0);
  });
});
