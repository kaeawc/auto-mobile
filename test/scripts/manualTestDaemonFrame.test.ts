import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  parseDaemonFrameArgs,
  runDaemonFrame,
  type DaemonFrameCommand,
  type DaemonFrameDeps,
} from "../../scripts/manual-test/daemon-frame";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
import type { FrameConnection } from "../../scripts/manual-test/frameWire";
import { resolveDaemonStatePath } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const posixTest = process.platform === "win32" ? test.skip : test;

class FakeConnection implements FrameConnection {
  writes: Array<{ id: string; method: string; params: Record<string, unknown>; type: string }> = [];
  destroyed = false;
  writesAfterDestroy = 0;
  ended = false;
  data: (chunk: Buffer) => void = () => {};
  close: (error?: Error) => void = () => {};
  respond: (frame: FakeConnection["writes"][number]) => unknown = () => ({});
  success = true;
  silent = false;
  write(data: string): void {
    if (this.destroyed) {
      this.writesAfterDestroy++;
      throw new Error("Write after destroy");
    }
    const frame = JSON.parse(data) as FakeConnection["writes"][number];
    this.writes.push(frame);
    if (!this.silent) {
      this.data(
        Buffer.from(
          JSON.stringify({
            id: frame.id,
            type: "mcp_response",
            success: this.success,
            result: this.respond(frame),
            code: this.success ? undefined : "typed_refusal",
          }) + "\n",
        ),
      );
    }
  }
  onData(listener: (chunk: Buffer) => void): void {
    this.data = listener;
  }
  onClose(listener: (error?: Error) => void): void {
    this.close = listener;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
    queueMicrotask(() => this.close());
  }
}
function parsed(args: string[] = ["send", "ide/status"]): DaemonFrameCommand {
  const command = parseDaemonFrameArgs(args);
  if ("error" in command) {
    throw new Error(command.error);
  }
  return command;
}
function fixture() {
  const connection = new FakeConnection();
  const timer = new FakeTimer();
  const out: string[] = [],
    err: string[] = [],
    paths: string[] = [];
  const deps: DaemonFrameDeps = {
    env: {
      ...derivePrivateDaemonBatch({
        batchDir: resolve("/fake/batch"),
        count: 1,
        basePort: 3160,
        auxRoot: resolve("/fake/aux"),
        serverPath: resolve("/fake/server"),
      })[0].env,
      AUTOMOBILE_DAEMON_SOCKET_PATH: resolve("/fake/aux/d.sock"),
      AUTOMOBILE_AUX_SOCKET_DIR: resolve("/fake/aux"),
      MT_SERVER: resolve("/fake/server"),
    },
    host: { homeDirs: [resolve("/fake/home")], uid: 424242, canonicalize: resolve },
    timer,
    ids: new FakeIdGenerator(),
    connect: async (path) => {
      paths.push(path);
      return connection;
    },
    readFile: () => '{"name":"named"}',
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
  };
  return { connection, timer, out, err, paths, deps };
}
const config = JSON.stringify({
  contractVersion: 1,
  managedHostScope: "fake-host",
  runnerNamespace: "fake-runner",
  runnerIncarnation: "boot-1",
  executionAttempt: "attempt-1",
  localSlotCapacity: 1,
  requests: [
    {
      slotIndex: 0,
      role: "main",
      platform: "android",
      requestedSpec: {
        runtime: "system-images;android-36;google_apis;arm64-v8a",
        deviceType: "pixel_7",
        displayCutout: "none",
      },
    },
  ],
});
function managedFixture(failed = false) {
  const f = fixture();
  f.connection.respond = (frame) =>
    frame.method === "daemon/capabilities"
      ? { capabilities: ["managed-slots/v1"] }
      : frame.method === "daemon/acquireManagedSlots"
        ? {
            contractVersion: 1,
            scope: { scopeKey: "scope" },
            outcome: failed ? "failed" : "ready",
            slots: failed ? [] : [{ sessionUuid: "slot-session" }],
          }
        : {};
  return f;
}
test("parses every flag including explicit type, file JSON and cancellation delay", () => {
  expect(
    parsed([
      "send",
      "input/tap",
      "@params",
      "--socket",
      "/sock",
      "--type",
      "mcp_request",
      "--count",
      "2",
      "--timeout-ms",
      "90",
      "--mode",
      "cancel-after:7",
      "--managed-binding",
      config,
      "--hold-ms",
      "20",
      "--allow-selector",
      "--allow-host-mutation",
    ]),
  ).toEqual({
    method: "input/tap",
    json: "@params",
    socket: "/sock",
    type: "mcp_request",
    count: 2,
    timeoutMs: 90,
    mode: "cancel-after",
    cancelAfterMs: 7,
    managedBinding: config,
    holdMs: 20,
    allowSelector: true,
    allowHostMutation: true,
  });
  expect(parsed(["send", "x", "--mode", "cancel"]).mode).toBe("cancel");
});
test("rejects usage errors and invalid numeric/mode/type values", () => {
  for (const args of [
    [],
    ["send"],
    ["send", "--x"],
    ["send", "x", "--wat"],
    ["send", "x", "--socket"],
    ["send", "x", "a", "b"],
    ["send", "x", "--count", "1", "--count", "2"],
    ...["0", "-1", "1.5", "x", "2147483648"].map((n) => ["send", "x", "--count", n]),
    ...[
      "cancel-after:-1",
      "cancel-after:x",
      "cancel-after:1.5",
      "cancel-after:2147483648",
      "other",
    ].map((mode) => ["send", "x", "--mode", mode]),
    ["send", "x", "--type", "invalid"],
    ["send", "x", "--timeout-ms", "0"],
    ["send", "x", "--hold-ms", "-1"],
  ]) {
    expect(parseDaemonFrameArgs(args)).toHaveProperty("error");
  }
});
posixTest("private, resident fake uid and relative socket guards never connect", async () => {
  const f = fixture();
  const env = f.deps.env;
  f.deps.env = {};
  expect(await runDaemonFrame(parsed(), f.deps)).toBe(2);
  f.deps.env = env;
  for (const socket of [resolveDaemonStatePath("sock", {}, String(f.deps.host.uid)), "relative"]) {
    expect(await runDaemonFrame({ ...parsed(), socket }, f.deps)).toBe(2);
  }
  expect(f.paths).toEqual([]);
});
posixTest(
  "selector-only start is refused; explicit avdName and deliberate selector are allowed",
  async () => {
    const f = fixture();
    const command = parsed([
      "send",
      "tools/call",
      '{"name":"startDevice","arguments":{"platform":"android"}}',
    ]);
    expect(await runDaemonFrame(command, f.deps)).toBe(2);
    expect(f.paths).toEqual([]);
    expect(await runDaemonFrame({ ...command, allowSelector: true }, f.deps)).toBe(0);
    expect(
      await runDaemonFrame(
        { ...command, json: '{"name":"startDevice","arguments":{"avdName":"fake-avd"}}' },
        f.deps,
      ),
    ).toBe(0);
  },
);
posixTest(
  "send writes exactly N frames, unique ids, all lines and parsed success determine exit",
  async () => {
    const f = fixture();
    f.connection.respond = () => ({ large: "x".repeat(70000) });
    expect(await runDaemonFrame({ ...parsed(), count: 2 }, f.deps)).toBe(0);
    expect(f.connection.writes).toHaveLength(2);
    expect(new Set(f.connection.writes.map((frame) => frame.id)).size).toBe(2);
    expect(f.out[0].length).toBeGreaterThan(70000);
    f.connection.success = false;
    expect(await runDaemonFrame(parsed(), f.deps)).toBe(1);
    expect(f.out.at(-1)).toContain('"code":"typed_refusal"');
    expect(f.connection.ended).toBe(true);
  },
);
posixTest("cancel writes then destroys without waiting for replies", async () => {
  const f = fixture();
  f.connection.silent = true;
  expect(await runDaemonFrame({ ...parsed(), mode: "cancel", count: 2 }, f.deps)).toBe(0);
  expect(f.connection.writes).toHaveLength(2);
  expect(f.connection.destroyed).toBe(true);
  expect(f.connection.ended).toBe(false);
});
posixTest("cancel-after destroys only when the fake timer reaches its delay", async () => {
  const f = fixture();
  f.connection.silent = true;
  const task = runDaemonFrame({ ...parsed(), mode: "cancel-after", cancelAfterMs: 10 }, f.deps);
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(9);
  await drainUntilQuiescent(f.timer);
  expect(f.connection.destroyed).toBe(false);
  f.timer.advanceTime(1);
  expect(await task).toBe(0);
  expect(f.connection.destroyed).toBe(true);
});
posixTest("response and connection timeout exit 3", async () => {
  const f = fixture();
  f.connection.silent = true;
  const task = runDaemonFrame({ ...parsed(), timeoutMs: 10 }, f.deps);
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(10);
  expect(await task).toBe(3);
  f.deps.connect = () => new Promise(() => {});
  const connecting = runDaemonFrame({ ...parsed(), timeoutMs: 10 }, f.deps);
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(10);
  expect(await connecting).toBe(3);
});
posixTest(
  "managed acquisition, claim, frame, continuing heartbeats and release use ONE socket",
  async () => {
    const f = managedFixture();
    const task = runDaemonFrame({ ...parsed(), managedBinding: config, holdMs: 4500 }, f.deps);
    await drainUntilQuiescent(f.timer);
    expect(f.connection.writes.map((frame) => frame.method)).toEqual([
      "daemon/capabilities",
      "daemon/acquireManagedSlots",
      "daemon/heartbeat",
      "ide/status",
    ]);
    const claim = f.connection.writes[2].params;
    expect(claim).toEqual({
      sessionId: "slot-session",
      livenessPolicy: "heartbeat",
      livenessOwnerToken: "fake-1",
      claimLivenessOwnership: true,
      reportIdleRelease: true,
      reportDaemonInstance: true,
    });
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    expect(f.connection.writes.filter((frame) => frame.method === "daemon/heartbeat")).toHaveLength(
      3,
    );
    expect(f.connection.writes[4].params.claimLivenessOwnership).toBeUndefined();
    f.timer.advanceTime(500);
    expect(await task).toBe(0);
    expect(f.paths).toHaveLength(1);
    expect(f.connection.writes.at(-1)?.params).toEqual({
      sessionId: "slot-session",
      livenessOwnerToken: "fake-1",
    });
    const n = f.connection.writes.length;
    f.timer.advanceTime(10000);
    expect(f.connection.writes).toHaveLength(n);
  },
);
posixTest("failed managed acquisition still sends the frame and reflects its refusal", async () => {
  const f = managedFixture(true);
  const base = f.connection.respond;
  // Use explicit response injection to represent a refused user frame.
  f.connection.write = (data) => {
    const frame = JSON.parse(data) as FakeConnection["writes"][number];
    f.connection.writes.push(frame);
    f.connection.data(
      Buffer.from(
        JSON.stringify({
          id: frame.id,
          type: "mcp_response",
          success: frame.method !== "ide/status",
          result: base(frame),
        }) + "\n",
      ),
    );
  };
  expect(await runDaemonFrame({ ...parsed(), managedBinding: config }, f.deps)).toBe(1);
  expect(f.connection.writes.map((frame) => frame.method)).toEqual([
    "daemon/capabilities",
    "daemon/acquireManagedSlots",
    "ide/status",
  ]);
  expect(f.out.some((line) => line.includes('"outcome":"failed"'))).toBe(true);
});
posixTest("invalid config or JSON is refused before connect; @file is read", async () => {
  const f = fixture();
  expect(await runDaemonFrame({ ...parsed(), managedBinding: "{}" }, f.deps)).toBe(2);
  expect(await runDaemonFrame({ ...parsed(), json: "not json" }, f.deps)).toBe(2);
  expect(f.paths).toEqual([]);
  expect(await runDaemonFrame({ ...parsed(), json: "@fake-file" }, f.deps)).toBe(0);
  expect(f.connection.writes[0].params).toEqual({ name: "named" });
});
posixTest(
  "host discovery is sent with notice; restart/maintenance requires explicit permission",
  async () => {
    const f = fixture();
    expect(await runDaemonFrame({ ...parsed(), method: "daemon/refreshDevices" }, f.deps)).toBe(0);
    expect(f.err[0]).toStartWith("daemon/refreshDevices:");
    const n = f.paths.length;
    for (const method of [
      "ide/prepareRestart",
      "ide/prepareMaintenance",
      "ide/restartAdmitted",
      "ide/commitAcceptanceRestart",
    ]) {
      expect(await runDaemonFrame({ ...parsed(), method }, f.deps)).toBe(2);
    }
    expect(f.paths).toHaveLength(n);
    expect(
      await runDaemonFrame(
        { ...parsed(), method: "ide/prepareRestart", allowHostMutation: true },
        f.deps,
      ),
    ).toBe(0);
  },
);

posixTest(
  "connection loss during a managed hold stops the keeper and returns 3 immediately",
  async () => {
    const f = managedFixture();
    const task = runDaemonFrame({ ...parsed(), managedBinding: config, holdMs: 10000 }, f.deps);
    await drainUntilQuiescent(f.timer);
    f.connection.close(new Error("fake connection loss"));
    expect(await task).toBe(3);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  },
);
posixTest(
  "managed cancel modes clear the keeper without a release frame on the destroyed socket",
  async () => {
    for (const mode of ["cancel", "cancel-after"] as const) {
      const f = managedFixture();
      const task = runDaemonFrame(
        { ...parsed(), managedBinding: config, mode, cancelAfterMs: 7 },
        f.deps,
      );
      await drainUntilQuiescent(f.timer);
      f.timer.advanceTime(7);
      expect(await task).toBe(0);
      expect(f.connection.destroyed).toBe(true);
      expect(f.err).toEqual([]);
      expect(f.connection.writesAfterDestroy).toBe(0);
      expect(f.connection.writes.some((frame) => frame.method === "daemon/releaseExecution")).toBe(
        false,
      );
      expect(f.timer.getPendingIntervalCount()).toBe(0);
    }
  },
);

posixTest(
  "explicit canonical resident socket and relocated resident basename never connect",
  async () => {
    const f = fixture();
    f.deps.host.canonicalize = (path) => resolve(path.replace(/^\/private\/tmp(?=\/|$)/, "/tmp"));
    for (const socket of [
      "/private/tmp/auto-mobile-daemon-424242.sock",
      "/different/auto-mobile-daemon-424242.sock",
    ]) {
      expect(await runDaemonFrame({ ...parsed(), socket }, f.deps)).toBe(2);
    }
    f.deps.host.canonicalize = (path) =>
      resolve(
        path === "/fake/control-alias.sock"
          ? "/canonical-tmp/auto-mobile-daemon-424242.sock"
          : path.replace(/^\/tmp(?=\/|$)/, "/canonical-tmp"),
      );
    expect(await runDaemonFrame({ ...parsed(), socket: "/fake/control-alias.sock" }, f.deps)).toBe(
      2,
    );
    expect(f.paths).toEqual([]);
  },
);
posixTest(
  "keeper starts only after claim response and logs a failed heartbeat without aborting",
  async () => {
    const f = managedFixture();
    const write = f.connection.write.bind(f.connection);
    let claim: FakeConnection["writes"][number] | undefined;
    f.connection.write = (data) => {
      const frame = JSON.parse(data) as FakeConnection["writes"][number];
      if (frame.method === "daemon/heartbeat" && frame.params.claimLivenessOwnership) {
        claim = frame;
        f.connection.writes.push(frame);
      } else if (frame.method === "daemon/heartbeat") {
        f.connection.writes.push(frame);
        f.connection.data(
          Buffer.from(
            JSON.stringify({
              id: frame.id,
              type: "mcp_response",
              success: false,
              error: "transient heartbeat failure",
              code: "temporary",
            }) + "\n",
          ),
        );
      } else {
        write(data);
      }
    };
    const task = runDaemonFrame({ ...parsed(), managedBinding: config, holdMs: 4500 }, f.deps);
    await drainUntilQuiescent(f.timer);
    expect(claim).toBeDefined();
    expect(f.timer.getPendingIntervalCount()).toBe(0);
    f.connection.data(
      Buffer.from(
        JSON.stringify({ id: claim!.id, type: "mcp_response", success: true, result: {} }) + "\n",
      ),
    );
    await drainUntilQuiescent(f.timer);
    expect(f.timer.getPendingIntervalCount()).toBe(1);
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    expect(f.err.join(" ")).toContain("Managed heartbeat failed: transient heartbeat failure");
    f.timer.advanceTime(2500);
    expect(await task).toBe(0);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
  },
);

posixTest("failed keeper heartbeat logs and continues to a successful exit", async () => {
  const f = managedFixture();
  const write = f.connection.write.bind(f.connection);
  f.connection.write = (data) => {
    const frame = JSON.parse(data) as FakeConnection["writes"][number];
    if (frame.method === "daemon/heartbeat" && !frame.params.claimLivenessOwnership) {
      f.connection.writes.push(frame);
      f.connection.data(
        Buffer.from(
          JSON.stringify({
            id: frame.id,
            type: "mcp_response",
            success: false,
            error: "temporary miss",
            code: "temporary",
          }) + "\n",
        ),
      );
    } else {
      write(data);
    }
  };
  const task = runDaemonFrame({ ...parsed(), managedBinding: config, holdMs: 2500 }, f.deps);
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(2000);
  await drainUntilQuiescent(f.timer);
  expect(f.err.join(" ")).toContain("Managed heartbeat failed: temporary miss");
  f.timer.advanceTime(500);
  expect(await task).toBe(0);
  expect(f.timer.getPendingIntervalCount()).toBe(0);
});
posixTest(
  "keeper deadline matches proxy lease formula and tolerates a timed-out heartbeat",
  async () => {
    const f = managedFixture();
    f.deps.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS = "12000";
    const write = f.connection.write.bind(f.connection);
    let missed = false;
    f.connection.write = (data) => {
      const frame = JSON.parse(data) as FakeConnection["writes"][number];
      if (frame.method === "daemon/heartbeat" && !frame.params.claimLivenessOwnership && !missed) {
        missed = true;
        f.connection.writes.push(frame);
      } else {
        write(data);
      }
    };
    const task = runDaemonFrame({ ...parsed(), managedBinding: config, holdMs: 9000 }, f.deps);
    await drainUntilQuiescent(f.timer);
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    expect(f.connection.writes.at(-1)).toHaveProperty("timeoutMs", 4000);
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    expect(f.err).toEqual([]);
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    expect(f.err.join(" ")).toContain(
      "Managed heartbeat failed: daemon/heartbeat timed out after 4000ms",
    );
    f.timer.advanceTime(3000);
    expect(await task).toBe(0);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
  },
);
posixTest("typed session-loss answer retires keeper without aborting user hold", async () => {
  const f = managedFixture();
  const write = f.connection.write.bind(f.connection);
  f.connection.write = (data) => {
    const frame = JSON.parse(data) as FakeConnection["writes"][number];
    if (frame.method === "daemon/heartbeat" && !frame.params.claimLivenessOwnership) {
      f.connection.writes.push(frame);
      f.connection.data(
        Buffer.from(
          JSON.stringify({
            id: frame.id,
            type: "mcp_response",
            success: false,
            error: "session gone",
            code: "daemon_session_not_found",
          }) + "\n",
        ),
      );
    } else {
      write(data);
    }
  };
  const task = runDaemonFrame({ ...parsed(), managedBinding: config, holdMs: 6500 }, f.deps);
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(2000);
  await drainUntilQuiescent(f.timer);
  expect(f.timer.getPendingIntervalCount()).toBe(0);
  f.timer.advanceTime(4500);
  expect(await task).toBe(0);
  expect(f.connection.writes.filter((frame) => frame.method === "daemon/heartbeat")).toHaveLength(
    2,
  );
});
