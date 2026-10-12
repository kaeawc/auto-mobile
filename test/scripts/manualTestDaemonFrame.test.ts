import { expect, spyOn, test } from "bun:test";
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
  if ("help" in command) {
    throw new Error("Unexpected help");
  }
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
            slots: failed ? [] : [{ slotIndex: 0, sessionUuid: "slot-session" }],
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
    keepOpenMs: 5000,
    then: [],
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

posixTest("cancel keep-open prints the late answer and gracefully ends", async () => {
  const f = fixture();
  f.connection.silent = true;
  const task = runDaemonFrame(
    { ...parsed(), mode: "cancel-keep-open", cancelAfterMs: 7, keepOpenMs: 20, then: [] },
    f.deps,
  );
  await drainUntilQuiescent(f.timer);
  expect(f.connection.writes).toHaveLength(1);
  const id = f.connection.writes[0].id;
  f.timer.advanceTime(7);
  await drainUntilQuiescent(f.timer);
  expect(f.connection.writes[1]).toMatchObject({
    method: "daemon/cancelRequest",
    type: "daemon_request",
    params: { requestId: id },
  });
  f.connection.data(
    Buffer.from(
      JSON.stringify({ type: "mcp_response", id, success: false, code: "outcome_indeterminate" }) +
        "\n",
    ),
  );
  expect(await task).toBe(0);
  expect(JSON.parse(f.out.at(-1)!)).toEqual({
    cancelled: [{ id, answered: true, success: false, code: "outcome_indeterminate" }],
  });
  expect(f.connection.ended).toBe(true);
  expect(f.connection.destroyed).toBe(false);
});

import { classifyFrameMethod, daemonMethodHint } from "../../scripts/manual-test/daemon-frame";
import {
  DAEMON_FRAME_COMMANDS,
  DAEMON_FRAME_FLAGS,
} from "../../scripts/manual-test/daemonFrameHelp";
import { substituteFramePlaceholders } from "../../scripts/manual-test/daemonFramePlaceholders";
test("frame help variants enumerate all parser commands and flags", () => {
  for (const args of [["--help"], ["-h"], ["help"], ["send", "--help"]]) {
    const result = parseDaemonFrameArgs(args);
    if (!("help" in result)) {
      throw new Error("Expected help");
    }
    for (const name of [...DAEMON_FRAME_COMMANDS, ...Object.keys(DAEMON_FRAME_FLAGS)]) {
      expect(result.help).toContain(name);
    }
    expect(result.help).toContain("proxy-owned session is rejected");
  }
});
test("session-info and heartbeat build exact non-owning keeper frames", () => {
  const info = parsed([
    "session-info",
    "S",
    "--count",
    "2",
    "--timeout-ms",
    "99",
    "--socket",
    "/private/sock",
  ]);
  expect(info.method).toBe("daemon/sessionInfo");
  expect(JSON.parse(info.json!)).toEqual({ sessionId: "S" });
  expect(info.count).toBe(2);
  expect(info.timeoutMs).toBe(99);
  const heartbeat = parsed(["heartbeat", "S"]);
  expect(heartbeat.method).toBe("daemon/heartbeat");
  expect(JSON.parse(heartbeat.json!)).toEqual({
    sessionId: "S",
    livenessPolicy: "cli",
    livenessOwnerKind: "cli-keeper",
    idleTimeoutMs: 120000,
  });
  for (const op of ["session-info", "heartbeat"]) {
    expect(parseDaemonFrameArgs([op])).toHaveProperty("error");
  }
});
posixTest("kebab-case hint preserves the requested method on the wire", async () => {
  const f = fixture();
  expect(
    await runDaemonFrame(parsed(["send", "daemon/session-info", '{"sessionId":"S"}']), f.deps),
  ).toBe(0);
  expect(f.err).toContain("did you mean daemon/sessionInfo?");
  expect(f.connection.writes[0].method).toBe("daemon/session-info");
  expect(daemonMethodHint("daemon/release-execution")).toBe(
    "did you mean daemon/releaseExecution?",
  );
  expect(daemonMethodHint("daemon/non-existent")).toBeUndefined();
});
test("every notice and maintenance route is classified alongside read routes", () => {
  for (const method of [
    "ide/prepareRestart",
    "ide/prepareMaintenance",
    "ide/completeMaintenance",
    "ide/restartAdmitted",
    "ide/restartAcceptanceSession",
    "ide/commitAcceptanceRestart",
    "ide/releaseAcceptanceRestart",
  ]) {
    expect(classifyFrameMethod(method)).toBe("maintenance");
  }
  for (const method of [
    "ide/setFeatureFlag",
    "ide/updateService",
    "ide/setKeyValue",
    "ide/removeKeyValue",
    "ide/clearKeyValueFile",
    "ide/republishIdentity",
  ]) {
    expect(classifyFrameMethod(method)).toBe("mutation");
  }
  for (const method of [
    "daemon/sessionInfo",
    "daemon/heartbeat",
    "daemon/capabilities",
    "daemon/availableDevices",
    "daemon/activeSessions",
    "ide/status",
  ]) {
    expect(classifyFrameMethod(method)).toBe("none");
  }
  expect(classifyFrameMethod("daemon/refreshDevices")).toBe("inventory");
});
posixTest("inventory notice names the refresh and read methods stay quiet", async () => {
  const f = fixture();
  expect(await runDaemonFrame(parsed(["send", "daemon/refreshDevices"]), f.deps)).toBe(0);
  expect(f.err[0]).toContain("daemon inventory refresh; no device is booted or claimed");
  f.err.length = 0;
  expect(await runDaemonFrame(parsed(["session-info", "S"]), f.deps)).toBe(0);
  expect(f.err).toEqual([]);
});
posixTest("cancel keep-open without an answer prints a bounded false summary", async () => {
  const f = fixture();
  f.connection.silent = true;
  const task = runDaemonFrame(
    parsed(["send", "tools/call", '{"name":"sendKeys"}', "--mode", "cancel-keep-open:20"]),
    f.deps,
  );
  await drainUntilQuiescent(f.timer);
  const id = f.connection.writes[0].id;
  expect(f.connection.writes[1]).toMatchObject({
    method: "daemon/cancelRequest",
    params: { requestId: id },
  });
  f.timer.advanceTime(20);
  expect(await task).toBe(0);
  expect(JSON.parse(f.out.at(-1)!)).toEqual({ cancelled: [{ id, answered: false }] });
  expect(f.connection.ended).toBe(true);
  expect(f.connection.destroyed).toBe(false);
});
posixTest(
  "sequential then frames resolve own identities and release without spurious failure",
  async () => {
    const f = managedFixture();
    const respond = f.connection.respond;
    let released = false;
    f.connection.respond = (frame) => {
      if (frame.method === "daemon/releaseExecution") {
        const alreadyReleased = released;
        released = true;
        return { sessionId: "slot-session", alreadyReleased, outcome: "reusable_for_this_slot" };
      }
      return respond(frame);
    };
    const command = parsed([
      "send",
      "ide/status",
      "--managed-binding",
      config,
      "--then",
      'daemon/sessionInfo {"sessionId":"{{ownSessionId}}","nested":["{{ownSessionId:0}}"]}',
      "--then",
      'daemon/releaseExecution {"sessionId":"{{ownSessionId}}","livenessOwnerToken":"{{ownLivenessOwnerToken}}"}',
    ]);
    expect(await runDaemonFrame(command, f.deps)).toBe(0);
    const user = f.connection.writes.filter((frame) =>
      ["ide/status", "daemon/sessionInfo", "daemon/releaseExecution"].includes(frame.method),
    );
    expect(user.slice(0, 3).map((frame) => frame.method)).toEqual([
      "ide/status",
      "daemon/sessionInfo",
      "daemon/releaseExecution",
    ]);
    expect(user[1].params).toEqual({ sessionId: "slot-session", nested: ["slot-session"] });
    expect(user[2].params).toEqual({ sessionId: "slot-session", livenessOwnerToken: "fake-1" });
    expect(f.paths).toHaveLength(1);
    expect(f.err).toEqual([]);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
  },
);
posixTest("unresolved placeholders refuse before any connection or frame", async () => {
  for (const binding of [undefined, config]) {
    const f = fixture();
    const command = {
      ...parsed([
        "send",
        "ide/status",
        "--then",
        'daemon/sessionInfo {"sessionId":"{{ownSessionId:9}}"}',
      ]),
      managedBinding: binding,
    };
    expect(await runDaemonFrame(command, f.deps)).toBe(2);
    expect(f.connection.writes).toEqual([]);
    expect(f.paths).toEqual([]);
  }
  const f = managedFixture(true);
  expect(
    await runDaemonFrame(
      parsed([
        "send",
        "ide/status",
        "--managed-binding",
        config,
        "--then",
        'daemon/sessionInfo {"sessionId":"{{ownSessionId}}"}',
      ]),
      f.deps,
    ),
  ).toBe(2);
  expect(f.connection.writes.some((frame) => frame.method === "ide/status")).toBe(false);
});
posixTest("a refused then frame exits one and later frames still run", async () => {
  const f = fixture();
  f.connection.respond = (frame) => {
    f.connection.success = frame.method !== "daemon/sessionInfo";
    return {};
  };
  // FakeConnection captures success before respond(), so emit the refusal explicitly instead.
  const write = f.connection.write.bind(f.connection);
  f.connection.write = (data) => {
    const frame = JSON.parse(data) as FakeConnection["writes"][number];
    f.connection.success = frame.method !== "daemon/sessionInfo";
    write(data);
  };
  expect(
    await runDaemonFrame(
      parsed([
        "send",
        "ide/status",
        "--then",
        "daemon/sessionInfo {}",
        "--then",
        "daemon/capabilities {}",
      ]),
      f.deps,
    ),
  ).toBe(1);
  expect(f.connection.writes.map((frame) => frame.method)).toEqual([
    "ide/status",
    "daemon/sessionInfo",
    "daemon/capabilities",
  ]);
});
posixTest("then device-start and maintenance guards apply before anything is sent", async () => {
  for (const frame of [
    'tools/call {"name":"startDevice","arguments":{"platform":"android"}}',
    "ide/prepareRestart {}",
  ]) {
    const f = fixture();
    expect(await runDaemonFrame(parsed(["send", "ide/status", "--then", frame]), f.deps)).toBe(2);
    expect(f.connection.writes).toEqual([]);
    expect(f.paths).toEqual([]);
  }
});
test("placeholder values select sparse slot indices and keep object keys literal", () => {
  const identity = {
    sessionIds: ["first", "second"],
    slots: new Map([[3, "second"]]),
    token: "owner",
  };
  expect(
    substituteFramePlaceholders(
      {
        "{{ownSessionId}}": [
          "prefix {{ownSessionId}}",
          "{{ownSessionId:3}}",
          "{{ownLivenessOwnerToken}}",
        ],
      },
      identity,
    ),
  ).toEqual({ "{{ownSessionId}}": ["prefix first", "second", "owner"] });
  expect(() => substituteFramePlaceholders("{{ownSessionId}}", undefined)).toThrow(
    "--managed-binding",
  );
});

posixTest(
  "keep-open connection failure with multiple requests leaves no unhandled rejection",
  async () => {
    const f = fixture();
    f.connection.write = () => {
      throw new Error("fake broken connection");
    };
    expect(
      await runDaemonFrame(
        parsed(["send", "ide/status", "--count", "2", "--mode", "cancel-keep-open"]),
        f.deps,
      ),
    ).toBe(3);
    expect(f.err.join(" ")).toContain("fake broken connection");
    expect(f.connection.ended).toBe(true);
  },
);
test("cancellation window and placeholder syntax refuse unresolvable input", () => {
  expect(
    parseDaemonFrameArgs([
      "send",
      "ide/status",
      "--mode",
      "cancel-keep-open:2147483647",
      "--cancel-after-ms",
      "1",
    ]),
  ).toHaveProperty("error");
  for (const value of [
    "{{ownSessionId:}}",
    "{{ownSessionId:-1}}",
    "{{ownSessionId:0.5}}",
    "{{ownLivenessOwnerToken:0}}",
  ]) {
    expect(() =>
      substituteFramePlaceholders(value, {
        sessionIds: ["S"],
        slots: new Map([[0, "S"]]),
        token: "T",
      }),
    ).toThrow("Cannot resolve");
  }
});
posixTest("automatic managed release treats a typed missing session as completed", async () => {
  const f = managedFixture();
  const write = f.connection.write.bind(f.connection);
  f.connection.write = (data) => {
    const frame = JSON.parse(data) as FakeConnection["writes"][number];
    if (frame.method === "daemon/releaseExecution") {
      f.connection.writes.push(frame);
      f.connection.data(
        Buffer.from(
          JSON.stringify({
            type: "mcp_response",
            id: frame.id,
            success: false,
            code: "daemon_session_not_found",
            error: "already gone",
          }) + "\n",
        ),
      );
    } else {
      write(data);
    }
  };
  expect(await runDaemonFrame({ ...parsed(), managedBinding: config }, f.deps)).toBe(0);
  expect(f.err).toEqual([]);
});

import { main as helpMain } from "../../scripts/manual-test/daemon-frame";
test("help main writes stdout and returns zero for top-level and subcommand help", async () => {
  const argv = process.argv;
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const args of [["--help"], ["-h"], ["help"], ["send", "--help"]]) {
      process.argv = ["bun", "daemon-frame.ts", ...args];
      expect(await helpMain()).toBe(0);
    }
    expect(out).toHaveBeenCalledTimes(4);
    expect(err).not.toHaveBeenCalled();
    process.argv = ["bun", "daemon-frame.ts", "invalid-command"];
    expect(await helpMain()).toBe(2);
    expect(err.mock.calls[0][0]).toContain("--help for usage");
  } finally {
    process.argv = argv;
    out.mockRestore();
    err.mockRestore();
  }
});

posixTest("heartbeat convenience honours the keeper idle timeout from injected env", async () => {
  const f = fixture();
  f.deps.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS = "240000";
  expect(await runDaemonFrame(parsed(["heartbeat", "S"]), f.deps)).toBe(0);
  expect(f.connection.writes[0].params).toEqual({
    sessionId: "S",
    livenessPolicy: "cli",
    livenessOwnerKind: "cli-keeper",
    idleTimeoutMs: 240000,
  });
});

posixTest("keep-open summary remains final after managed cleanup", async () => {
  const f = managedFixture();
  expect(
    await runDaemonFrame(
      { ...parsed(["send", "ide/status", "--mode", "cancel-keep-open"]), managedBinding: config },
      f.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({
    cancelled: [{ answered: true, success: true }],
  });
  expect(f.connection.writes.at(-1)?.method).toBe("daemon/releaseExecution");
  expect(f.connection.ended).toBe(true);
  expect(f.connection.destroyed).toBe(false);
});
