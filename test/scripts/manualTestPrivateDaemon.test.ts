import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  parsePrivateDaemonArgs,
  runPrivateDaemonCommand,
} from "../../scripts/manual-test/private-daemon";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
import { fixture, options, parsed } from "./manualTestPrivateDaemonFixture";
const posixTest = process.platform === "win32" ? test.skip : test;
test.each(["mkdir", "writeFile"])(
  "F5 failing baseline %s preserves launch result",
  async (kind) => {
    const f = fixture();
    await runPrivateDaemonCommand({ op: "init", options }, f.deps);
    const mkdir = f.deps.mkdir;
    f.deps.mkdir = (path, mode) => {
      if (kind === "mkdir" && path === join(options.batchDir, "shared")) {
        throw new Error("baseline mkdir failed");
      }
      mkdir(path, mode);
    };
    const write = f.deps.writeFile;
    f.deps.writeFile = (path, text) => {
      if (kind === "writeFile" && path.endsWith("host-devices-at-start.json")) {
        throw new Error("baseline write failed");
      }
      write(path, text);
    };
    f.deps.runCommand = async (command, args, env) => {
      f.launches.push({ command, args, env });
      return { exitCode: 7 };
    };
    expect(
      await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
    ).toBe(7);
    expect(f.launches).toHaveLength(1);
    expect(f.logs.filter((line) => line.startsWith("BASELINE WARNING:"))).toEqual([
      expect.stringContaining("provenance will be unknown"),
    ]);
  },
);
test("F8 help documents evidence, refusals, launch exit codes and gate limitations", () => {
  const help = parsePrivateDaemonArgs(["--help"]);
  if (!("help" in help)) {
    throw new Error("Expected help");
  }
  for (const text of [
    "batch-inferred",
    "foreign",
    "bootedBy",
    "processAvdName",
    "ps eww",
    "not yet been observed on a live batch",
    "inferred-not-stopped",
    "device ID (serial/UDID)",
    "ambiguous selector stops nothing",
    "ambiguous",
    "held-by-other-daemon",
    "daemonErrors",
    "device_already_stopped",
    "start propagates",
    "--wait-ms 0",
    "best-effort",
    "PID is gone",
  ]) {
    expect(help.help).toContain(text);
  }
});
posixTest("parses each command and exact start passthrough", () => {
  expect(
    parsed([
      "init",
      "--batch-dir",
      options.batchDir,
      "--count",
      "2",
      "--base-port",
      "3160",
      "--server",
      options.serverPath,
      "--env",
      "NOTE=a=b",
      "--split-adb-coordination",
      "--orphan-idle-ms",
      "0",
    ]).op,
  ).toBe("init");
  for (const op of ["start", "stop", "status", "env"]) {
    expect(parsed([op, "--batch-dir", options.batchDir, "--daemon", "1"]).op).toBe(op);
  }
  const start = parsed([
    "start",
    "--batch-dir",
    options.batchDir,
    "--",
    "--debug",
    "--plan-execution-lock-scope",
    "session",
  ]);
  if (start.op !== "start") {
    throw new Error("wrong op");
  }
  expect(start.extraFlags).toEqual(["--debug", "--plan-execution-lock-scope", "session"]);
  expect(parsed(["status", "--batch-dir", options.batchDir]).op).toBe("status");
});
test("rejects missing values, unknown flags, invalid daemon and owned port flags", () => {
  for (const args of [
    [],
    ["init", "--batch-dir", "/batch"],
    ["start", "--batch-dir"],
    ["start", "--batch-dir", "/batch", "--wat"],
    ["env", "--batch-dir", "/batch"],
    ["stop", "--batch-dir", "/batch", "--daemon", "x"],
    ["start", "--batch-dir", "/batch", "--daemon", "0"],
    ["status", "--batch-dir", "/batch", "--", "--debug"],
    ...["--port", "--port=3190", "--strict-port", "--strict-port=false"].map((flag) => [
      "start",
      "--batch-dir",
      "/batch",
      "--",
      flag,
    ]),
  ]) {
    expect(parsePrivateDaemonArgs(args)).toHaveProperty("error");
  }
});
posixTest("init writes only private manifest/env/0700 dirs, refuses overwrite", async () => {
  const f = fixture();
  expect(await runPrivateDaemonCommand({ op: "init", options }, f.deps)).toBe(0);
  expect(f.writes).toEqual([
    join(options.batchDir, "daemon1", "env.sh"),
    join(options.batchDir, "daemon2", "env.sh"),
    join(options.batchDir, "batch.json"),
    ...[1, 2].flatMap((index) =>
      ["am", "proxy", "frame", "aux"].map((name) =>
        join(options.batchDir, "bin", `${name}${index}`),
      ),
    ),
    join(options.batchDir, "shared", "preflight-0.json"),
  ]);
  expect(f.dirs.every(([, mode]) => mode === 0o700)).toBe(true);
  expect(JSON.parse(f.files.get(join(options.batchDir, "batch.json"))!).specs).toEqual(
    derivePrivateDaemonBatch(options),
  );
  f.writes.length = 0;
  expect(await runPrivateDaemonCommand({ op: "init", options }, f.deps)).toBe(2);
  expect(f.writes).toEqual([]);
});
test("init refusal writes and creates nothing", async () => {
  const f = fixture();
  expect(
    await runPrivateDaemonCommand(
      { op: "init", options: { ...options, batchDir: "relative" } },
      f.deps,
    ),
  ).toBe(2);
  expect(f.writes).toEqual([]);
  expect(f.dirs).toEqual([]);
  expect(f.launches).toEqual([]);
});
posixTest("start uses strict owned port and derived env, writes a plain pid", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  expect(
    await runPrivateDaemonCommand(
      parsed(["start", "--batch-dir", options.batchDir, "--daemon", "1", "--", "--debug"]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0].command).toBe(f.deps.runtimePath);
  expect(f.launches[0].args).toEqual([
    options.serverPath,
    "--daemon",
    "start",
    "--port",
    "3160",
    "--strict-port",
    "--debug",
  ]);
  expect(f.launches[0].env).toEqual({ KEEP: "kept", ...derivePrivateDaemonBatch(options)[0].env });
  expect(f.files.get(join(options.batchDir, "daemon1", "pid.txt"))).toBe("1234\n");
  expect(JSON.parse(f.logs[0]).pid).toBe(1234);
});
posixTest("start refuses any live pid before launching the batch", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.files.set(derivePrivateDaemonBatch(options)[1].pidFilePath, '{"pid":1234}');
  f.deps.isPidAlive = () => true;
  expect(
    await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(2);
  expect(f.launches).toEqual([]);
});
posixTest("gone stop, status and env never launch", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.writes.length = 0;
  f.dirs.length = 0;
  expect(
    await runPrivateDaemonCommand(
      parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1"]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.launches).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.dirs).toEqual([]);
  f.files.set(join(options.batchDir, "daemon1", "pid.txt"), "1234\n");
  await runPrivateDaemonCommand(parsed(["status", "--batch-dir", options.batchDir]), f.deps);
  await runPrivateDaemonCommand(
    parsed(["env", "--batch-dir", options.batchDir, "--daemon", "1"]),
    f.deps,
  );
  expect(f.launches).toHaveLength(0);
  expect(f.logs.at(-1)).toBe(join(options.batchDir, "daemon1", "env.sh"));
});
posixTest("tampered specs/default options are refused before a launch", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  const path = join(options.batchDir, "batch.json");
  const manifest = JSON.parse(f.files.get(path)!);
  manifest.specs[0].env.AUTOMOBILE_DATA_DIR = "/home/fake/.auto-mobile";
  f.files.set(path, JSON.stringify(manifest));
  expect(
    await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(2);
  expect(f.launches).toEqual([]);
});

posixTest("successful stop removes pid.txt", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  const path = derivePrivateDaemonBatch(options)[0].plainPidFilePath;
  f.files.set(path, "99\n");
  expect(
    await runPrivateDaemonCommand(
      parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1"]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.files.has(path)).toBe(false);
});

import {
  PRIVATE_DAEMON_COMMANDS,
  PRIVATE_DAEMON_FLAGS,
} from "../../scripts/manual-test/privateDaemonHelp";
import { renderPrivateDaemonWrappers } from "../../scripts/manual-test/privateDaemonWrappers";
import { PRODUCT_PATH_ENV_VARIABLES } from "../../scripts/manual-test/productPathEnv";
function initArgs(extra: string[] = []): string[] {
  return ["init", "--batch-dir", options.batchDir, "--count", "2", "--base-port", "3160", ...extra];
}
test("daemon arg tokens are verbatim, scoped, and env assignments are validated", () => {
  const command = parsed(
    initArgs([
      "--daemon-arg",
      "--",
      "--daemon-arg=--debug",
      "--daemon-arg",
      "2:--tool-call-recording",
      "--daemon-arg",
      "session",
      "--env",
      "NOTE=global",
      "--daemon-env",
      "2:NOTE=local",
    ]),
  );
  if (command.op !== "init") {
    throw new Error("Expected init");
  }
  expect(command.options.daemonArgs).toEqual(["--", "--debug", "session"]);
  expect(command.options.daemonArgsByDaemon).toEqual({ "2": ["--tool-call-recording"] });
  expect(command.options.daemonEnv).toEqual({ "2": { NOTE: "local" } });
  for (const extra of [
    ["--daemon-env", "3:NOTE=x"],
    ["--daemon-env", "0:NOTE=x"],
    ["--daemon-env", "1:NOTE=x", "--daemon-env", "1:NOTE=y"],
    ["--daemon-env", "1:AUTOMOBILE_DATA_DIR=/fake"],
    ["--env", "BAD-NAME=x"],
    ["--daemon-arg", "--port"],
    ["--daemon-arg=--strict-port=false"],
    ["--daemon-arg", "2:--port=50"],
  ]) {
    expect(parsePrivateDaemonArgs(initArgs(extra))).toHaveProperty("error");
  }
});
posixTest(
  "recorded args roundtrip through stop and selected restart with one-off extras",
  async () => {
    const f = fixture();
    const recorded = {
      ...options,
      daemonArgs: ["--plan-execution-lock-scope", "session"],
      daemonArgsByDaemon: { "2": ["--tool-call-recording"] },
      daemonEnv: { "2": { NOTE: "private" } },
    };
    await runPrivateDaemonCommand({ op: "init", options: recorded }, f.deps);
    expect(JSON.parse(f.files.get(join(options.batchDir, "batch.json"))!).options).toEqual(
      recorded,
    );
    const spec = derivePrivateDaemonBatch(recorded)[1];
    f.files.set(spec.plainPidFilePath, "9\n");
    await runPrivateDaemonCommand(
      parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "2"]),
      f.deps,
    );
    f.files.set(spec.plainPidFilePath, "8\n");
    await runPrivateDaemonCommand(
      parsed(["start", "--batch-dir", options.batchDir, "--daemon", "2", "--", "--debug"]),
      f.deps,
    );
    expect(f.launches[0].args.slice(3)).toEqual([
      "--port",
      "3161",
      "--strict-port",
      ...recorded.daemonArgs,
      "--tool-call-recording",
      "--debug",
    ]);
    expect(f.launches[0].env.NOTE).toBe("private");
    expect(JSON.parse(f.logs.at(-1)!).args).toEqual(f.launches[0].args.slice(3));
    expect(f.files.get(spec.plainPidFilePath)).toBe("1234\n");
  },
);
posixTest(
  "failed stop preserves pid.txt and successful stop tolerates a missing file",
  async () => {
    const f = fixture();
    await runPrivateDaemonCommand({ op: "init", options }, f.deps);
    const spec = derivePrivateDaemonBatch(options)[0];
    f.files.set(spec.plainPidFilePath, "22\n");
    f.files.set(spec.pidFilePath, '{"pid":22}');
    f.deps.isPidAlive = () => true;
    f.deps.runCommand = async () => ({ exitCode: 7 });
    const stop = parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1"]);
    expect(await runPrivateDaemonCommand(stop, f.deps)).toBe(1);
    expect(f.files.get(spec.plainPidFilePath)).toBe("22\n");
    expect(f.removes).toEqual([]);
    f.files.delete(spec.plainPidFilePath);
    f.deps.isPidAlive = () => false;
    f.deps.runCommand = async () => ({ exitCode: 0 });
    expect(await runPrivateDaemonCommand(stop, f.deps)).toBe(0);
  },
);
posixTest(
  "status uses authoritative JSON pid and reports ok stale missing without mutations",
  async () => {
    const f = fixture();
    await runPrivateDaemonCommand({ op: "init", options }, f.deps);
    f.writes.length = 0;
    f.dirs.length = 0;
    const spec = derivePrivateDaemonBatch(options)[0];
    f.deps.isPidAlive = (pid) => pid === 42;
    f.deps.probeSocket = async () => ({ alive: true });
    const command = parsed(["status", "--batch-dir", options.batchDir, "--daemon", "1"]);
    for (const [txt, json, expectedPid, expectedTxt] of [
      ["42", 42, 42, "ok"],
      ["7", 42, 42, "stale"],
      [undefined, 42, 42, "missing"],
      ["42", undefined, 42, "ok"],
      ["7", undefined, 7, "stale"],
    ] as const) {
      if (txt) {
        f.files.set(spec.plainPidFilePath, txt);
      } else {
        f.files.delete(spec.plainPidFilePath);
      }
      if (json) {
        f.files.set(spec.pidFilePath, JSON.stringify({ pid: json }));
      } else {
        f.files.delete(spec.pidFilePath);
      }
      expect(await runPrivateDaemonCommand(command, f.deps)).toBe(0);
      expect(JSON.parse(f.logs.at(-1)!)).toMatchObject({
        pid: expectedPid,
        pidTxt: expectedTxt,
        socketAlive: true,
      });
    }
    f.deps.probeSocket = async () => ({ alive: false, reason: "dead" });
    await runPrivateDaemonCommand(command, f.deps);
    expect(JSON.parse(f.logs.at(-1)!).socketAlive).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.dirs).toEqual([]);
    expect(f.removes).toEqual([]);
  },
);
posixTest(
  "status devices reports host and live daemon devices through bounded injected reads",
  async () => {
    const f = fixture();
    await runPrivateDaemonCommand({ op: "init", options }, f.deps);
    f.writes.length = 0;
    f.dirs.length = 0;
    f.deps.queryAdbHost = async (host, port, request, timeout) => {
      expect([host, port, request, timeout]).toEqual(["127.0.0.1", 5037, "host:devices-l", 2000]);
      return "emu1 device model:fake\n";
    };
    f.deps.probeSocket = async (path, probe) =>
      path === derivePrivateDaemonBatch(options)[1].socketPath
        ? { alive: false, reason: "dead" }
        : { alive: true, result: probe?.method ? { devices: [{ deviceId: "emu1" }] } : {} };
    expect(
      await runPrivateDaemonCommand(
        parsed(["status", "--batch-dir", options.batchDir, "--devices"]),
        f.deps,
      ),
    ).toBe(0);
    expect(f.logs).toHaveLength(3);
    const inventory = JSON.parse(f.logs[2]);
    expect(inventory.hostDevices.android[0].deviceId).toBe("emu1");
    expect(inventory.hostDevices.ios[0].udid).toBe("sim1");
    expect(inventory.daemonDevices).toEqual({ P1: [{ deviceId: "emu1" }], P2: { error: "dead" } });
    expect(f.captures.some((call) => call.command === "adb")).toBe(false);
    expect(f.captures.map((call) => [call.command, call.args, call.timeoutMs])).toEqual([
      ["xcrun", ["simctl", "list", "devices", "booted", "--json"], 2000],
    ]);
    expect(inventory.hostDevices.android[0]).toEqual({
      deviceId: "emu1",
      state: "device",
      details: ["model:fake"],
    });
    expect(f.writes).toEqual([]);
    expect(f.dirs).toEqual([]);
    expect(f.removes).toEqual([]);
    expect(f.launches).toEqual([]);
  },
);
posixTest(
  "status skips absent adb server without invoking adb, and contains simctl errors",
  async () => {
    const f = fixture();
    await runPrivateDaemonCommand({ op: "init", options }, f.deps);
    const calls: string[] = [];
    f.deps.runCapture = async (command) => {
      calls.push(command);
      throw new Error("missing xcrun");
    };
    expect(
      await runPrivateDaemonCommand(
        parsed(["status", "--batch-dir", options.batchDir, "--devices"]),
        f.deps,
      ),
    ).toBe(0);
    expect(calls).toEqual(["xcrun"]);
    expect(JSON.parse(f.logs.at(-1)!).hostDevices).toEqual({
      android: { skipped: "no adb server listening" },
      ios: { skipped: "missing xcrun" },
    });
  },
);
posixTest("wrapper rendering quotes absolute paths containing spaces", () => {
  expect(renderPrivateDaemonWrappers("/private/a b", 1, "/repo root")).toEqual({
    am1: `#!/usr/bin/env bash\nset -euo pipefail\nexec bash '/repo root/scripts/manual-test/in-daemon-env.sh' --batch-dir '/private/a b' --daemon 1 --cd '/repo root' "$@"\n`,
    ...Object.fromEntries(
      ["proxy", "frame", "aux"].map((name) => [
        `${name}1`,
        `#!/usr/bin/env bash\nset -euo pipefail\nexec bash '/repo root/scripts/manual-test/in-daemon-env.sh' --batch-dir '/private/a b' --daemon 1 ${name} "$@"\n`,
      ]),
    ),
  });
});
posixTest("init and wrappers write exactly four executable wrappers per daemon", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  expect(f.modes).toHaveLength(8);
  expect(f.modes.every(([, mode]) => mode === 0o755)).toBe(true);
  f.writes.length = 0;
  f.modes.length = 0;
  expect(
    await runPrivateDaemonCommand(parsed(["wrappers", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(0);
  expect(f.writes).toHaveLength(8);
  expect(f.writes.every((path) => path.startsWith(join(options.batchDir, "bin") + "/"))).toBe(true);
  expect(f.modes).toHaveLength(8);
});
posixTest(
  "older manifest reports only missing new state defaults; other tampering stays refused",
  async () => {
    const f = fixture();
    await runPrivateDaemonCommand({ op: "init", options }, f.deps);
    const path = join(options.batchDir, "batch.json"),
      manifest = JSON.parse(f.files.get(path)!);
    for (const spec of manifest.specs) {
      for (const row of PRODUCT_PATH_ENV_VARIABLES.filter(
        (row) => row.kind === "state" && !row.owner,
      )) {
        delete spec.env[row.name];
      }
    }
    f.files.set(path, JSON.stringify(manifest));
    expect(
      await runPrivateDaemonCommand(parsed(["status", "--batch-dir", options.batchDir]), f.deps),
    ).toBe(2);
    expect(f.logs.at(-1)).toContain(
      "written by an older harness (missing AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR",
    );
    manifest.specs[0].port = 9000;
    f.files.set(path, JSON.stringify(manifest));
    await runPrivateDaemonCommand(parsed(["status", "--batch-dir", options.batchDir]), f.deps);
    expect(f.logs.at(-1)).toContain("Tampered");
  },
);
test("top and subcommand help list parser commands flags and state variables", () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["help"],
    ["init", "--help"],
    ["status", "--batch-dir", "/private/batch", "--help"],
  ]) {
    const result = parsePrivateDaemonArgs(args);
    if (!("help" in result)) {
      throw new Error("Expected help");
    }
    for (const word of [
      ...PRIVATE_DAEMON_COMMANDS,
      ...Object.keys(PRIVATE_DAEMON_FLAGS),
      ...PRODUCT_PATH_ENV_VARIABLES.filter((row) => row.kind === "state").map((row) => row.name),
    ]) {
      expect(result.help).toContain(word);
    }
  }
});

posixTest("wrappers refuse symlink aliases outside batch bin before writing", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.writes.length = 0;
  f.dirs.length = 0;
  const target = join(options.batchDir, "bin", "am1");
  f.deps.host.canonicalize = (path) => (path === target ? "/elsewhere/target" : resolve(path));
  expect(
    await runPrivateDaemonCommand(parsed(["wrappers", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(2);
  expect(f.writes).toEqual([]);
  expect(f.dirs).toEqual([]);
});

posixTest("status contains captured simctl failure and probes configured adb port", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.deps.env.ANDROID_ADB_SERVER_PORT = "5555";
  const ports: number[] = [];
  f.deps.queryAdbHost = async (_host, port) => {
    ports.push(port);
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  };
  f.deps.runCapture = async () => ({ exitCode: 1, stdout: "", stderr: "simctl failed" });
  expect(
    await runPrivateDaemonCommand(
      parsed(["status", "--batch-dir", options.batchDir, "--devices"]),
      f.deps,
    ),
  ).toBe(0);
  expect(ports).toEqual([5555]);
  expect(JSON.parse(f.logs.at(-1)!).hostDevices.ios).toEqual({ skipped: "simctl failed" });
});

import { selectHarnessLogSink } from "../../scripts/manual-test/harnessLogSink";
posixTest("launcher removes its sink override before handing env to runCommand", async () => {
  const f = fixture();
  f.deps.logSinkOverride = selectHarnessLogSink(f.deps.env, [resolve("/home/fake")], {
    realpath: resolve,
  });
  expect(f.deps.env.AUTOMOBILE_LOG_SINK).toBe("stderr");
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  expect(
    await runPrivateDaemonCommand(
      parsed(["start", "--batch-dir", options.batchDir, "--daemon", "1"]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.launches[0].env.AUTOMOBILE_LOG_SINK).toBeUndefined();
  expect(f.launches[0].env.AUTOMOBILE_LOG_DIR).toContain("daemon1");
});
posixTest(
  "status devices exposes the daemon inventory method and help says it refreshes",
  async () => {
    const f = fixture();
    await runPrivateDaemonCommand({ op: "init", options }, f.deps);
    expect(
      await runPrivateDaemonCommand(
        parsed(["status", "--batch-dir", options.batchDir, "--devices"]),
        f.deps,
      ),
    ).toBe(0);
    expect(JSON.parse(f.logs.at(-1)!).daemonDevicesMethod).toBe("daemon/availableDevices");
    const help = parsePrivateDaemonArgs(["--help"]);
    if (!("help" in help)) {
      throw new Error("Expected help");
    }
    expect(help.help).toContain("refreshing ownership and discovery");
    expect(help.help).toContain("Opt-in paths");
  },
);

posixTest("ADB host FAIL returns the server message without invoking adb", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.deps.queryAdbHost = async () => {
    throw new Error("server denied inventory");
  };
  await runPrivateDaemonCommand(
    parsed(["status", "--batch-dir", options.batchDir, "--devices"]),
    f.deps,
  );
  expect(JSON.parse(f.logs.at(-1)!).hostDevices.android).toEqual({
    skipped: "server denied inventory",
  });
  expect(f.captures.map((call) => call.command)).toEqual(["xcrun"]);
});
