import { expect, spyOn, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  FrameRpc,
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
      const result = this.respond(frame);
      this.data(
        Buffer.from(
          JSON.stringify({
            id: frame.id,
            type: "mcp_response",
            success: this.success,
            result,
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
    exists: () => false,
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
const request = {
  contractVersion: 1,
  requestId: "request-1",
  device: {
    schemaVersion: 1,
    platform: "android",
    hardware: { kind: "omitted" },
    os: { kind: "omitted" },
  },
};
const config = "/standalone/request.json";
/** In-memory wire fake mirroring handlers.ts bind-before-prepare/status and the broker tool gate.
 * No database or native lifecycle is needed to exercise connection confinement here. */
function fakeBrokerBindingFixture(failed = false) {
  const f = fixture();
  delete f.deps.env.MT_BATCH;
  const files = new Map([[config, JSON.stringify(request)]]);
  f.deps.readFile = (path) => files.get(path) ?? '{"name":"named"}';
  f.deps.exists = (path) => files.has(path);
  let bound = new Set<string>();
  const grants = new Map([[request.requestId, { sessionId: "broker-session", token: "fake-1" }]]);
  f.connection.respond = (frame) => {
    f.connection.success = true;
    if (frame.method === "daemon/capabilities") {
      return { capabilities: ["session-broker/v1"] };
    }
    if (["daemon/prepareSession", "daemon/sessionRequestStatus"].includes(frame.method)) {
      bound = new Set();
      const id =
        frame.method === "daemon/prepareSession"
          ? (frame.params.config as typeof request).requestId
          : String(frame.params.requestId);
      const grant = grants.get(id);
      if (grant && grant.token !== frame.params.livenessOwnerToken) {
        f.connection.success = false;
        return { error: "Session request belongs to another liveness owner" };
      }
      if (!failed && grant) {
        bound.add(grant.sessionId);
      }
      return {
        contractVersion: 1,
        requestId: id,
        outcome: failed ? "failed" : "ready",
        sessionUuid: failed ? null : grant?.sessionId,
        profile: failed ? null : {},
        cleanupPending: false,
      };
    }
    if (frame.method === "daemon/registerSession") {
      bound = new Set();
      const registration = frame.params.sessionBroker as {
        requestId: string;
        livenessOwnerToken: string;
      };
      const grant = grants.get(registration.requestId);
      f.connection.success =
        !!grant &&
        grant.sessionId === frame.params.sessionId &&
        grant.token === registration.livenessOwnerToken;
      if (f.connection.success) {
        bound.add(grant!.sessionId);
      }
      return {};
    }
    if (frame.method === "daemon/releaseBrokerSession") {
      const grant = [...grants.values()].find(
        (value) =>
          value.sessionId === frame.params.sessionId &&
          value.token === frame.params.livenessOwnerToken,
      );
      return {
        sessionUuid: frame.params.sessionId,
        outcome: grant ? "released" : "unknown_session",
      };
    }
    if (frame.method === "tools/call") {
      const args = frame.params.arguments as { sessionUuid?: string } | undefined;
      f.connection.success =
        !["startDevice", "provisionDevice", "getAndroid", "getApple", "killDevice"].includes(
          String(frame.params.name),
        ) &&
        (!args?.sessionUuid || bound.has(args.sessionUuid));
    }
    return {};
  };
  return { ...f, files, grants, bound: () => [...bound] };
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
      "--broker-binding",
      config,
      "--hold-ms",
      "20",
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
    brokerBinding: config,
    tokenOf: undefined,
    expectRefused: false,
    holdMs: 20,
    allowSelector: false,
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
  "broker acquisition, claim, frame, continuing heartbeats and release use ONE socket",
  async () => {
    const f = fakeBrokerBindingFixture();
    const task = runDaemonFrame({ ...parsed(), brokerBinding: config, holdMs: 4500 }, f.deps);
    await drainUntilQuiescent(f.timer);
    expect(f.connection.writes.map((frame) => frame.method)).toEqual([
      "daemon/capabilities",
      "daemon/prepareSession",
      "daemon/heartbeat",
      "ide/status",
    ]);
    const claim = f.connection.writes[2].params;
    expect(claim).toEqual({
      sessionId: "broker-session",
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
      sessionId: "broker-session",
      livenessOwnerToken: "fake-1",
    });
    const n = f.connection.writes.length;
    f.timer.advanceTime(10000);
    expect(f.connection.writes).toHaveLength(n);
  },
);
posixTest("failed broker acquisition refuses all user frames", async () => {
  const f = fakeBrokerBindingFixture(true);
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
  expect(await runDaemonFrame({ ...parsed(), brokerBinding: config }, f.deps)).toBe(1);
  expect(f.connection.writes.map((frame) => frame.method)).toEqual([
    "daemon/capabilities",
    "daemon/prepareSession",
  ]);
  expect(f.out.some((line) => line.includes('"outcome":"failed"'))).toBe(true);
});
posixTest("invalid config or JSON is refused before connect; @file is read", async () => {
  const f = fixture();
  expect(await runDaemonFrame({ ...parsed(), brokerBinding: "{}" }, f.deps)).toBe(2);
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
  "connection loss during a broker hold stops the keeper and returns 3 immediately",
  async () => {
    const f = fakeBrokerBindingFixture();
    const task = runDaemonFrame({ ...parsed(), brokerBinding: config, holdMs: 10000 }, f.deps);
    await drainUntilQuiescent(f.timer);
    f.connection.close(new Error("fake connection loss"));
    expect(await task).toBe(3);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  },
);
posixTest(
  "broker cancel modes clear the keeper without a release frame on the destroyed socket",
  async () => {
    for (const mode of ["cancel", "cancel-after"] as const) {
      const f = fakeBrokerBindingFixture();
      const task = runDaemonFrame(
        { ...parsed(), brokerBinding: config, mode, cancelAfterMs: 7 },
        f.deps,
      );
      await drainUntilQuiescent(f.timer);
      f.timer.advanceTime(7);
      expect(await task).toBe(0);
      expect(f.connection.destroyed).toBe(true);
      expect(f.err).toEqual([]);
      expect(f.connection.writesAfterDestroy).toBe(0);
      expect(
        f.connection.writes.some((frame) => frame.method === "daemon/releaseBrokerSession"),
      ).toBe(false);
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
    const f = fakeBrokerBindingFixture();
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
    const task = runDaemonFrame({ ...parsed(), brokerBinding: config, holdMs: 4500 }, f.deps);
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
    expect(f.err.join(" ")).toContain("Broker heartbeat failed: transient heartbeat failure");
    f.timer.advanceTime(2500);
    expect(await task).toBe(0);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
  },
);

posixTest("failed keeper heartbeat logs and continues to a successful exit", async () => {
  const f = fakeBrokerBindingFixture();
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
  const task = runDaemonFrame({ ...parsed(), brokerBinding: config, holdMs: 2500 }, f.deps);
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(2000);
  await drainUntilQuiescent(f.timer);
  expect(f.err.join(" ")).toContain("Broker heartbeat failed: temporary miss");
  f.timer.advanceTime(500);
  expect(await task).toBe(0);
  expect(f.timer.getPendingIntervalCount()).toBe(0);
});
posixTest(
  "keeper deadline matches proxy lease formula and tolerates a timed-out heartbeat",
  async () => {
    const f = fakeBrokerBindingFixture();
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
    const task = runDaemonFrame({ ...parsed(), brokerBinding: config, holdMs: 9000 }, f.deps);
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
      "Broker heartbeat failed: daemon/heartbeat timed out after 4000ms",
    );
    f.timer.advanceTime(3000);
    expect(await task).toBe(0);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
  },
);
posixTest("typed session-loss answer retires keeper without aborting user hold", async () => {
  const f = fakeBrokerBindingFixture();
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
  const task = runDaemonFrame({ ...parsed(), brokerBinding: config, holdMs: 6500 }, f.deps);
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
  expect(daemonMethodHint("daemon/release-broker-session")).toBe(
    "did you mean daemon/releaseBrokerSession?",
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
    const f = fakeBrokerBindingFixture();
    const respond = f.connection.respond;
    let released = false;
    f.connection.respond = (frame) => {
      if (frame.method === "daemon/releaseBrokerSession") {
        const alreadyReleased = released;
        released = true;
        return { sessionId: "broker-session", alreadyReleased, outcome: "released" };
      }
      return respond(frame);
    };
    const command = parsed([
      "send",
      "ide/status",
      "--broker-binding",
      config,
      "--then",
      'daemon/sessionInfo {"sessionId":"{{ownSessionId}}","nested":["{{ownSessionId}}"]}',
      "--then",
      'daemon/releaseBrokerSession {"sessionId":"{{ownSessionId}}","livenessOwnerToken":"{{ownLivenessOwnerToken}}"}',
    ]);
    expect(await runDaemonFrame(command, f.deps)).toBe(0);
    const user = f.connection.writes.filter((frame) =>
      ["ide/status", "daemon/sessionInfo", "daemon/releaseBrokerSession"].includes(frame.method),
    );
    expect(user.slice(0, 3).map((frame) => frame.method)).toEqual([
      "ide/status",
      "daemon/sessionInfo",
      "daemon/releaseBrokerSession",
    ]);
    expect(user[1].params).toEqual({ sessionId: "broker-session", nested: ["broker-session"] });
    expect(user[2].params).toEqual({ sessionId: "broker-session", livenessOwnerToken: "fake-1" });
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
      brokerBinding: binding,
    };
    expect(await runDaemonFrame(command, f.deps)).toBe(2);
    expect(f.connection.writes).toEqual([]);
    expect(f.paths).toEqual([]);
  }
  const f = fakeBrokerBindingFixture(true);
  expect(
    await runDaemonFrame(
      parsed([
        "send",
        "ide/status",
        "--broker-binding",
        config,
        "--then",
        'daemon/sessionInfo {"sessionId":"{{ownSessionId}}"}',
      ]),
      f.deps,
    ),
  ).toBe(1);
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
test("placeholder values resolve one grant and named clients while keys stay literal", () => {
  const identity = { sessionId: "first", clients: new Map([["b", "second"]]), token: "owner" };
  expect(
    substituteFramePlaceholders(
      {
        "{{ownSessionId}}": [
          "prefix {{ownSessionId}}",
          "{{clientSessionId:b}}",
          "{{ownLivenessOwnerToken}}",
        ],
      },
      identity,
    ),
  ).toEqual({ "{{ownSessionId}}": ["prefix first", "second", "owner"] });
  expect(() => substituteFramePlaceholders("{{ownSessionId}}", undefined)).toThrow(
    "--broker-binding",
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
        sessionId: "S",
        clients: new Map(),
        token: "T",
      }),
    ).toThrow();
  }
});
posixTest("automatic broker release accepts an unknown-session receipt", async () => {
  const f = fakeBrokerBindingFixture();
  const respond = f.connection.respond;
  f.connection.respond = (frame) =>
    frame.method === "daemon/releaseBrokerSession"
      ? { sessionUuid: "broker-session", outcome: "unknown_session" }
      : respond(frame);
  expect(await runDaemonFrame({ ...parsed(), brokerBinding: config }, f.deps)).toBe(0);
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

posixTest("keep-open summary remains final after broker cleanup", async () => {
  const f = fakeBrokerBindingFixture();
  expect(
    await runDaemonFrame(
      { ...parsed(["send", "ide/status", "--mode", "cancel-keep-open"]), brokerBinding: config },
      f.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({
    cancelled: [{ answered: true, success: true }],
  });
  expect(f.connection.writes.at(-1)?.method).toBe("daemon/releaseBrokerSession");
  expect(f.connection.ended).toBe(true);
  expect(f.connection.destroyed).toBe(false);
});

test("oversized control line fails every waiter and destroys the connection", async () => {
  const f = fixture();
  f.connection.silent = true;
  const rpc = new FrameRpc(f.connection, f.deps, 32);
  const pending = rpc.request("daemon/capabilities", {}, 100).catch((error: unknown) => error);
  const pause = rpc.pause(100).catch((error: unknown) => error);
  f.connection.data(Buffer.from("x".repeat(33)));
  expect(f.connection.destroyed).toBe(true);
  expect(((await pending) as Error).message).toBe("Control response frame exceeds 32 bytes");
  expect(((await pause) as Error).message).toBe("Control response frame exceeds 32 bytes");
  expect(() => rpc.assertOpen()).toThrow("exceeds 32 bytes");
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("valid lines after invalid control JSON are still echoed with elapsed time", () => {
  const f = fixture();
  const rpc = new FrameRpc(f.connection, f.deps, 64);
  f.connection.data(Buffer.from("invalid JSON\n"));
  expect(() => rpc.assertOpen()).toThrow("Invalid control JSON");
  f.timer.advanceTime(7);
  const line = '{"type":"mcp_response","id":"later","success":true}';
  f.connection.data(Buffer.from(line + "\n"));
  expect(f.out).toEqual(["[0ms] invalid JSON", `[7ms] ${line}`]);
});
test("response before overflow resolves and echoes before other waiters fail", async () => {
  const f = fixture();
  f.connection.silent = true;
  const rpc = new FrameRpc(f.connection, f.deps, 64);
  const first = rpc.beginRequest("daemon/capabilities", {}, 100);
  const answer = first.answer.catch((error: unknown) => error);
  const other = rpc.request("ide/status", {}, 100).catch((error: unknown) => error);
  const line = JSON.stringify({ type: "mcp_response", id: first.id, success: true });
  f.connection.data(Buffer.from(line + "\n" + "x".repeat(65)));
  expect(await answer).toEqual({ type: "mcp_response", id: first.id, success: true });
  expect(f.out).toEqual([`[0ms] ${line}`]);
  expect(((await other) as Error).message).toBe("Control response frame exceeds 64 bytes");
  expect(f.connection.destroyed).toBe(true);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
  f.connection.data(Buffer.from(line + "\n"));
  expect(f.out).toHaveLength(1);
});

function batchFixture() {
  const f = fakeBrokerBindingFixture();
  const batch = resolve("/fake/batch");
  f.deps.env.MT_BATCH = batch;
  const clients = Object.fromEntries(
    ["a", "b"].map((name) => [
      name,
      {
        platform: "android",
        profile: request.device,
        requestId: `batch-${name}-1`,
        tokenFile: `sessions/${name}/owner-token`,
      },
    ]),
  );
  f.files.set(join(batch, "broker/clients.json"), JSON.stringify(clients));
  for (const name of ["a", "b"]) {
    const dir = join(batch, "sessions", name);
    const config = { ...request, requestId: `batch-${name}-1` };
    f.files.set(join(dir, "request.json"), JSON.stringify(config));
    f.files.set(join(dir, "attempts.json"), JSON.stringify([config.requestId]));
    f.files.set(join(dir, "owner-token"), `secret-${name}-token`);
    f.files.set(
      join(dir, "init.json"),
      JSON.stringify({
        session: {
          outcome: "ready",
          sessionUuid: `session-${name}`,
          requestId: config.requestId,
        },
      }),
    );
    f.grants.set(config.requestId, { sessionId: `session-${name}`, token: `secret-${name}-token` });
  }
  return { ...f, batch };
}

posixTest(
  "batch name and request path reuse the exact identity, bind one grant, and never release it",
  async () => {
    for (const source of ["a", "/fake/batch/sessions/a/request.json"]) {
      const f = batchFixture();
      const command = parsed([
        "send",
        "tools/call",
        '{"name":"observe","arguments":{"sessionUuid":"{{ownSessionId}}"}}',
        "--broker-binding",
        source,
      ]);
      expect(await runDaemonFrame(command, f.deps)).toBe(0);
      expect(f.bound()).toEqual(["session-a"]);
      expect(
        f.connection.writes.find((frame) => frame.method === "daemon/prepareSession")?.params,
      ).toEqual({
        config: { ...request, requestId: "batch-a-1" },
        livenessOwnerToken: "secret-a-token",
      });
      expect(
        f.connection.writes.find((frame) => frame.method === "tools/call")?.params.arguments,
      ).toEqual({ sessionUuid: "session-a" });
      expect(
        f.connection.writes.some((frame) => frame.method === "daemon/releaseBrokerSession"),
      ).toBe(false);
      expect(f.timer.getPendingIntervalCount()).toBe(0);
      expect(f.paths).toHaveLength(1);
    }
  },
);

posixTest(
  "a named foreign grant is sent for isolation and refused by the bound socket",
  async () => {
    const f = batchFixture();
    expect(
      await runDaemonFrame(
        parsed([
          "send",
          "tools/call",
          '{"name":"observe","arguments":{"sessionUuid":"{{clientSessionId:b}}"}}',
          "--broker-binding",
          "a",
          "--expect-refused",
        ]),
        f.deps,
      ),
    ).toBe(0);
    expect(
      f.connection.writes.find((frame) => frame.method === "tools/call")?.params.arguments,
    ).toEqual({ sessionUuid: "session-b" });
    expect(f.bound()).toEqual(["session-a"]);
    // The other grant remains independently usable on a new connection.
    f.connection.writes.length = 0;
    expect(
      await runDaemonFrame(
        parsed([
          "send",
          "tools/call",
          '{"name":"observe","arguments":{"sessionUuid":"{{ownSessionId}}"}}',
          "--broker-binding",
          "b",
        ]),
        f.deps,
      ),
    ).toBe(0);
    expect(f.bound()).toEqual(["session-b"]);
  },
);

posixTest(
  "broker acquisition tools are locally refused and explicit expected refusals reach the gate",
  async () => {
    for (const name of ["startDevice", "provisionDevice", "getAndroid", "getApple", "killDevice"]) {
      const f = fakeBrokerBindingFixture();
      const command = parsed([
        "send",
        "tools/call",
        JSON.stringify({ name, arguments: { deviceId: "explicit" } }),
        "--broker-binding",
        config,
      ]);
      expect(await runDaemonFrame(command, f.deps)).toBe(2);
      expect(f.paths).toEqual([]);
      expect(f.err.join(" ")).toContain("--expect-refused");
      const allowed = fakeBrokerBindingFixture();
      expect(await runDaemonFrame({ ...command, expectRefused: true }, allowed.deps)).toBe(0);
      expect(allowed.connection.writes.some((frame) => frame.method === "tools/call")).toBe(true);
    }
  },
);

posixTest(
  "expected refusal exits two on any successful response, including then frames",
  async () => {
    const f = fakeBrokerBindingFixture();
    expect(
      await runDaemonFrame(
        parsed([
          "send",
          "tools/call",
          '{"name":"startDevice","arguments":{}}',
          "--broker-binding",
          config,
          "--expect-refused",
          "--then",
          "ide/status {}",
        ]),
        f.deps,
      ),
    ).toBe(2);
    const g = fakeBrokerBindingFixture();
    const respond = g.connection.respond;
    g.connection.respond = (frame) => {
      const result = respond(frame);
      if (frame.method === "tools/call") {
        g.connection.success = true;
      }
      return result;
    };
    expect(
      await runDaemonFrame(
        parsed([
          "send",
          "tools/call",
          '{"name":"killDevice","arguments":{}}',
          "--broker-binding",
          config,
          "--expect-refused",
        ]),
        g.deps,
      ),
    ).toBe(2);
  },
);

posixTest(
  "broker resources and device reads are never sent, even under expected refusal",
  async () => {
    for (const method of ["resources", "resources/list", "read", "resources/read"]) {
      const f = fakeBrokerBindingFixture();
      expect(
        await runDaemonFrame(
          parsed([
            "send",
            method,
            '{"uri":"automobile:devices/android"}',
            "--broker-binding",
            config,
            "--expect-refused",
          ]),
          f.deps,
        ),
      ).toBe(2);
      expect(f.paths).toEqual([]);
    }
  },
);

posixTest(
  "indexed and unknown client placeholders refuse before acquisition with migration guidance",
  async () => {
    for (const value of [
      "{{ownSessionId:0}}",
      "{{ownSessionId:3}}",
      "{{clientSessionId:foreign}}",
    ]) {
      const f = batchFixture();
      expect(
        await runDaemonFrame(
          parsed([
            "send",
            "daemon/sessionInfo",
            JSON.stringify({ sessionId: value }),
            "--broker-binding",
            "a",
          ]),
          f.deps,
        ),
      ).toBe(2);
      expect(f.paths).toEqual([]);
      if (value.startsWith("{{ownSessionId:")) {
        expect(f.err.join(" ")).toContain("{{clientSessionId:<name>}}");
      }
    }
  },
);

posixTest(
  "token-of changes only status/release user frames and never prints either token",
  async () => {
    for (const method of ["daemon/sessionRequestStatus", "daemon/releaseBrokerSession"]) {
      const f = batchFixture();
      expect(
        await runDaemonFrame(
          parsed([
            "send",
            method,
            '{"requestId":"batch-a-1","sessionId":"{{ownSessionId}}","livenessOwnerToken":"{{ownLivenessOwnerToken}}"}',
            "--broker-binding",
            "a",
            "--token-of",
            "b",
          ]),
          f.deps,
        ),
      ).toBe(method.endsWith("Status") ? 1 : 0);
      const user = f.connection.writes.find((frame) => frame.method === method)!;
      expect(user.params.livenessOwnerToken).toBe("secret-b-token");
      expect(
        f.connection.writes.find((frame) => frame.method === "daemon/heartbeat")?.params
          .livenessOwnerToken,
      ).toBe("secret-a-token");
      expect(f.err).toEqual(["Isolation frame: using token of batch client b."]);
      expect([...f.out, ...f.err].join(" ")).not.toContain("secret-a-token");
      expect([...f.out, ...f.err].join(" ")).not.toContain("secret-b-token");
    }
  },
);

posixTest(
  "token-of refuses self, foreign, standalone, and non-isolation methods before connecting",
  async () => {
    for (const [binding, token, method] of [
      ["a", "a", "daemon/sessionRequestStatus"],
      ["a", "foreign", "daemon/sessionRequestStatus"],
      [config, "b", "daemon/sessionRequestStatus"],
      ["a", "b", "tools/call"],
    ]) {
      const f = batchFixture();
      expect(
        await runDaemonFrame(
          parsed(["send", method, "{}", "--broker-binding", binding, "--token-of", token]),
          f.deps,
        ),
      ).toBe(2);
      expect(f.paths).toEqual([]);
    }
  },
);

posixTest(
  "all batch tokens are redacted from echoed response fields, free text and errors",
  async () => {
    const f = batchFixture();
    const respond = f.connection.respond;
    f.connection.respond = (frame) =>
      frame.method === "ide/status"
        ? { livenessOwnerToken: "secret-a-token", message: "foreign secret-b-token" }
        : respond(frame);
    expect(
      await runDaemonFrame(parsed(["send", "ide/status", "--broker-binding", "a"]), f.deps),
    ).toBe(0);
    expect(f.out.join(" ")).toContain("[REDACTED]");
    expect(f.out.join(" ")).not.toContain("secret-a-token");
    expect(f.out.join(" ")).not.toContain("secret-b-token");
    const g = fakeBrokerBindingFixture();
    g.connection.close = () => {};
    g.deps.connect = async () => {
      throw new Error("failed fake-1");
    };
    expect(await runDaemonFrame({ ...parsed(), brokerBinding: config }, g.deps)).toBe(3);
    expect(g.err.join(" ")).not.toContain("fake-1");
  },
);

posixTest("existing-client hold failure does not release its grant", async () => {
  const f = batchFixture();
  const respond = f.connection.respond;
  f.connection.respond = (frame) => {
    const result = respond(frame);
    if (frame.method === "daemon/heartbeat") {
      f.connection.success = false;
    }
    return result;
  };
  expect(await runDaemonFrame({ ...parsed(), brokerBinding: "a" }, f.deps)).toBe(1);
  expect(f.connection.writes.some((frame) => frame.method === "daemon/releaseBrokerSession")).toBe(
    false,
  );
  expect(f.timer.getPendingIntervalCount()).toBe(0);
});

test("broker flags reject incompatible modes, selector override and obsolete binding flag", () => {
  for (const flags of [
    ["--broker-binding", "a", "--allow-selector"],
    ["--expect-refused"],
    ["--token-of", "b"],
    ["--managed-binding", "a"],
    ["--broker-binding", "a", "--expect-refused", "--mode", "cancel"],
  ]) {
    expect(parseDaemonFrameArgs(["send", "ide/status", ...flags])).toHaveProperty("error");
  }
});

posixTest(
  "a failed standalone hold releases through broker ports with the cleanup budget",
  async () => {
    const f = fakeBrokerBindingFixture();
    const respond = f.connection.respond;
    f.connection.respond = (frame) => {
      const result = respond(frame);
      if (frame.method === "daemon/heartbeat") {
        f.connection.success = false;
      }
      return result;
    };
    expect(await runDaemonFrame({ ...parsed(), brokerBinding: config }, f.deps)).toBe(1);
    expect(f.connection.writes.at(-1)).toMatchObject({
      method: "daemon/releaseBrokerSession",
      timeoutMs: 240000,
      params: { sessionId: "broker-session", livenessOwnerToken: "fake-1" },
    });
    expect(f.connection.writes.some((frame) => frame.method === "ide/status")).toBe(false);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
  },
);

posixTest(
  "escaped owner tokens are redacted before response and invalid JSON diagnostics",
  async () => {
    for (const invalid of [false, true]) {
      const f = batchFixture();
      const token = 'secret-"a\\value';
      const json = invalid ? `{"broken":${JSON.stringify(token)}` : "{}";
      f.files.set(join(f.batch, "sessions/a/owner-token"), token);
      f.grants.set("batch-a-1", { sessionId: "session-a", token });
      const respond = f.connection.respond;
      f.connection.respond = (frame) =>
        frame.method === "ide/status"
          ? { livenessOwnerToken: token, message: token }
          : respond(frame);
      expect(
        await runDaemonFrame(parsed(["send", "ide/status", json, "--broker-binding", "a"]), f.deps),
      ).toBe(invalid ? 2 : 0);
      const output = [...f.out, ...f.err].join(" ");
      expect(output).not.toContain(token);
      expect(output).not.toContain(JSON.stringify(token).slice(1, -1));
    }
  },
);

posixTest("cross-client reconnect cannot expand the connection's one-session grant", async () => {
  const f = batchFixture();
  expect(
    await runDaemonFrame(
      parsed([
        "send",
        "daemon/registerSession",
        '{"sessionId":"{{clientSessionId:b}}","clientName":"isolation","sessionBroker":{"requestId":"batch-b-1","livenessOwnerToken":"{{ownLivenessOwnerToken}}"}}',
        "--broker-binding",
        "a",
        "--expect-refused",
      ]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.bound()).toEqual([]);
  expect(f.grants.get("batch-b-1")?.sessionId).toBe("session-b");
  expect(f.connection.writes.some((frame) => frame.method === "daemon/releaseBrokerSession")).toBe(
    false,
  );
});
