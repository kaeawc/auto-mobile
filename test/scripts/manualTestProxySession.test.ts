import { FakeBrokerDaemonClient } from "../helpers/FakeBrokerDaemonClient";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { expect, spyOn, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  parseProxySessionArgs,
  renderResponse,
  runProxySessionCommand,
  runServe,
  type ProxySessionCommand,
  type ProxySessionDeps,
  type ProxySessionClient,
} from "../../scripts/manual-test/proxy-session";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import type { SessionBrokerResult } from "../../src/models/sessionBrokerResult";
import { SESSION_EXPERIMENTAL_CAPABILITY } from "../../src/models/sessionConfig";
import { FakeTimer } from "../fakes/FakeTimer";
const posixTest = process.platform === "win32" ? test.skip : test;
const dir = resolve("/session");
function parsed(args: string[]): ProxySessionCommand {
  const result = parseProxySessionArgs(args);
  if ("help" in result) {
    throw new Error("Unexpected help");
  }
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}
function fixture() {
  const files = new Map<string, string>(),
    writes: string[] = [],
    logs: string[] = [],
    calls: string[] = [],
    exits: number[] = [];
  const timer = new FakeTimer();
  const env = derivePrivateDaemonBatch({
    batchDir: "/batch",
    count: 1,
    basePort: 3160,
    auxRoot: "/mt-aux",
    serverPath: "/built/index.js",
  })[0].env;
  files.set(env.AUTOMOBILE_DAEMON_PID_FILE_PATH, JSON.stringify({ pid: 9876 }));
  const client: ProxySessionClient = {
    connect: async () => {},
    close: async () => {
      calls.push("close");
    },
    pid: () => 5678,
    capabilities: () => ({ experimental: {} }),
    serverInfo: () => ({ name: "fake" }),
    callTool: async (tool, args) => {
      calls.push(tool);
      return { structuredContent: args };
    },
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    readResource: async () => ({ contents: [] }),
    subscribeResource: async () => ({}),
  };
  const deps: ProxySessionDeps = {
    env,
    probeDaemonSocket: async () => ({ alive: true }),
    host: { homeDirs: ["/home/fake"], uid: 4242, canonicalize: resolve },
    pid: 1234,
    timer,
    ids: new FakeIdGenerator(Array.from({ length: 50 }, (_, index) => `request-${index + 1}`)),
    rename: (from, to) => {
      for (const [path, bytes] of [...files]) {
        if (path === from || path.startsWith(`${from}/`)) {
          files.set(to + path.slice(from.length), bytes);
          files.delete(path);
        }
      }
    },
    spawnOwner: () => {
      calls.push("spawnOwner");
      return 2468;
    },
    ownerStartIdentity: () => "fake-owner-generation",
    exists: (path) => files.has(path),
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw new Error(`Missing fake file ${path}`);
      }
      return text;
    },
    writeFile: (path, text) => {
      files.set(path, text);
      writes.push(path);
    },
    writeJson: (path, value) => {
      files.set(path, JSON.stringify(value));
      writes.push(path);
    },
    appendFile: (path, text) => {
      files.set(path, (files.get(path) ?? "") + text);
    },
    mkdir: () => {},
    listFiles: (path) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1)),
    isPidAlive: () => true,
    createClient: () => {
      calls.push("createClient");
      return client;
    },
    spawnServe: () => {
      calls.push("spawnServe");
      return 1234;
    },
    log: (text) => {
      logs.push(text);
    },
    flush: async (text) => {
      logs.push(text);
    },
    exit: (code) => {
      exits.push(code);
    },
  };
  return { files, writes, logs, calls, exits, deps, client, timer };
}
test("parses every session command and call options", () => {
  for (const op of ["up", "serve", "tools", "resources", "status", "close"]) {
    expect(parsed([op, "--dir", dir]).op).toBe(op);
  }
  for (const op of ["read", "subscribe"]) {
    expect(parsed([op, "--dir", dir, "automobile:devices"]).uri).toBe("automobile:devices");
  }
  const call = parsed([
    "call",
    "--dir",
    dir,
    "startDevice",
    "@args.json",
    "--timeout-ms",
    "123",
    "--full",
    "--allow-selector",
  ]);
  expect(call.tool).toBe("startDevice");
  expect(call.json).toBe("@args.json");
  expect(call.timeoutMs).toBe(123);
  expect(call.full).toBe(true);
  expect(call.allowSelector).toBe(true);
  const up = parsed(["up", "--dir", dir, "--env", "NOTE=a=b", "--init-timeout-ms", "900"]);
  expect(up.env).toEqual({ NOTE: "a=b" });

  expect(up.initTimeoutMs).toBe(900);
});
test("rejects missing/unknown flags, command-specific options and bad env overrides", () => {
  for (const args of [
    [],
    ["sleep", "--dir", dir, "1"],
    ["up", "--dir"],
    ["call", "--dir", dir],
    ["tools", "--dir", dir, "extra"],
    ["read", "--dir", dir],
    ["up", "--dir", dir, "--config"],
    ["up", "--dir", dir, "--env", "BAD"],
    ["up", "--dir", dir, "--env", "AUTOMOBILE_AUX_SOCKET_DIR=/other"],
    ["up", "--dir", dir, "--env", "AUTOMOBILE_MANAGED_SLOT_CONFIG=other"],
    ["up", "--dir", dir, "--debug"],
    ["call", "--dir", dir, "observe", "--timeout-ms", "NaN"],
    ["call", "--dir", dir, "observe", "--timeout-ms", "0"],
    ["up", "--dir", dir, "--init-timeout-ms", "-1"],
    ["status", "--dir", dir, "--config", "slots.json"],
    ["tools", "--dir", dir, "--allow-selector"],
  ]) {
    expect(parseProxySessionArgs(args)).toHaveProperty("error");
  }
});
posixTest(
  "selector-only call is refused before a request is written; opt-in sends it",
  async () => {
    const f = fixture();
    f.files.set(join(dir, "init.json"), '{"ok":true}');
    const command = parsed(["call", "--dir", dir, "startDevice", '{"platform":"android"}']);
    expect(await runProxySessionCommand(command, f.deps)).toBe(2);
    expect(f.writes).toEqual([]);
    expect(f.calls).toEqual([]);
    f.files.set(join(dir, "out", "request-1.json"), '{"ok":true,"result":{}}');
    expect(await runProxySessionCommand({ ...command, allowSelector: true }, f.deps)).toBe(0);
    expect(JSON.parse(f.files.get(join(dir, "in", "request-1.json"))!).allowSelector).toBe(true);
  },
);
test("up refuses absent private env before spawning or writing", async () => {
  const f = fixture();
  f.deps.env = {};
  expect(await runProxySessionCommand(parsed(["up", "--dir", dir]), f.deps)).toBe(2);
  expect(f.writes).toEqual([]);
  expect(f.calls).toEqual([]);
});
posixTest("up enforces new plain directory before spawning", async () => {
  const f = fixture();
  f.files.set(join(dir, "closed.json"), "{}");
  expect(await runProxySessionCommand(parsed(["up", "--dir", dir]), f.deps)).toBe(2);
  expect(f.logs.join(" ")).toContain("NEW --dir");
  expect(f.calls).toEqual([]);
});
test("renderResponse handles structured content, JSON/text resources and full envelope", () => {
  const render = (result: unknown) =>
    JSON.parse(renderResponse({ ok: true, ms: 1, result }, false)).payload;
  expect(
    render({ structuredContent: { n: 1 }, content: [{ type: "text", text: "ignored" }] }),
  ).toEqual({ n: 1 });
  expect(render({ content: [{ type: "text", text: '{"n":2}' }] })).toEqual({ n: 2 });
  expect(render({ content: [{ type: "text", text: "plain" }] })).toBe("plain");
  expect(render({ contents: [{ text: "[1,2]" }] })).toEqual([1, 2]);
  const envelope = { ok: false, error: "failed", result: { isError: true } };
  expect(JSON.parse(renderResponse(envelope, true))).toEqual(envelope);
});
posixTest("serve answers a call, records notifications and closes via fake client", async () => {
  const f = fixture();
  const callPath = join(dir, "in", "1.json"),
    closePath = join(dir, "in", "2.json");
  f.files.set(
    callPath,
    JSON.stringify({ id: "1", op: "call", tool: "observe", args: { sessionUuid: "fake" } }),
  );
  const createClient = f.deps.createClient;
  f.deps.createClient = (options) => {
    options.onNotification({ method: "resources/updated" });
    return createClient(options);
  };
  // Publish close only after the call response, so the fake exercises a poll without real sleep.
  const writeJson = f.deps.writeJson;
  f.deps.writeJson = (path, value) => {
    writeJson(path, value);
    if (path === join(dir, "out", "1.json")) {
      f.files.set(closePath, JSON.stringify({ id: "2", op: "close" }));
    }
  };
  f.timer.enableAutoAdvance();
  try {
    expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(0);
    expect(f.calls).toEqual(["createClient", "observe", "close"]);
    expect(JSON.parse(f.files.get(join(dir, "out", "1.json"))!).result).toEqual({
      structuredContent: { sessionUuid: "fake" },
    });
    expect(JSON.parse(f.files.get(join(dir, "out", "2.json"))!).ok).toBe(true);
    expect(JSON.parse(f.files.get(join(dir, "closed.json"))!).reason).toBe("closed_by_request");
    expect(f.files.get(join(dir, "notifications.jsonl"))).toContain("resources/updated");
    expect(f.files.get(join(dir, "proxy.pid"))).toBe("5678\n");
    expect(f.exits).toEqual([0]);
  } finally {
    f.timer.reset();
  }
});
posixTest("serve marks only the request whose client call spans host sleep", async () => {
  const f = fixture();
  f.files.set(
    join(dir, "in", "1.json"),
    JSON.stringify({ id: "slept", op: "call", tool: "observe", args: {} }),
  );
  let slept = false;
  f.client.callTool = async () => {
    if (!slept) {
      slept = true;
      f.timer.simulateHostSleep(60_000);
    }
    return { ok: true };
  };
  const writeJson = f.deps.writeJson;
  f.deps.writeJson = (path, value) => {
    writeJson(path, value);
    if (path === join(dir, "out", "1.json")) {
      f.files.set(
        join(dir, "in", "2.json"),
        JSON.stringify({ id: "awake", op: "call", tool: "observe", args: {} }),
      );
    }
    if (path === join(dir, "out", "2.json")) {
      f.files.set(join(dir, "in", "3.json"), JSON.stringify({ id: "close", op: "close" }));
    }
  };
  f.timer.enableAutoAdvance();
  try {
    expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(0);
    const slept = JSON.parse(f.files.get(join(dir, "out", "1.json"))!);
    const awake = JSON.parse(f.files.get(join(dir, "out", "2.json"))!);
    expect(slept).toMatchObject({ invalid: "host-slept", hostSleptMs: 60_000 });
    expect(awake).not.toHaveProperty("invalid");
    expect(awake).not.toHaveProperty("hostSleptMs");
    expect(f.files.get(join(dir, "events.jsonl"))).toContain(
      '"kind":"host_slept","id":"slept","sleptMs":60000',
    );
    expect(JSON.parse(f.files.get(join(dir, "host-sleep.json"))!)).toEqual({
      invalidIds: ["slept"],
      lines: ["host-slept: 1 evidence row(s) invalid", "  - slept"],
    });
  } finally {
    f.timer.reset();
  }
});
posixTest(
  "serve marks overlapping requests when one sample detects their shared sleep",
  async () => {
    const f = fixture();
    f.files.set(
      join(dir, "in", "1.json"),
      JSON.stringify({ id: "A", op: "call", tool: "observe", args: {} }),
    );
    f.files.set(
      join(dir, "in", "2.json"),
      JSON.stringify({ id: "B", op: "call", tool: "observe", args: {} }),
    );
    let finishA!: (value: unknown) => void;
    f.client.callTool = async () => {
      if (!finishA) {
        f.timer.advanceTime(10);
        return await new Promise((resolveCall) => {
          finishA = resolveCall;
        });
      }
      f.timer.simulateHostSleep(60_000);
      finishA({ ok: true });
      return { ok: true };
    };
    const writeJson = f.deps.writeJson;
    f.deps.writeJson = (path, value) => {
      writeJson(path, value);
      if (path === join(dir, "out", "2.json")) {
        f.files.set(join(dir, "in", "3.json"), JSON.stringify({ id: "close", op: "close" }));
      }
    };
    f.timer.enableAutoAdvance();
    try {
      expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(0);
      expect(JSON.parse(f.files.get(join(dir, "out", "1.json"))!).invalid).toBe("host-slept");
      expect(JSON.parse(f.files.get(join(dir, "out", "2.json"))!).invalid).toBe("host-slept");
      expect(JSON.parse(f.files.get(join(dir, "host-sleep.json"))!).invalidIds).toEqual(["A", "B"]);
    } finally {
      f.timer.reset();
    }
  },
);
posixTest("serve does not mark a request for a sleep detected at its start", async () => {
  const f = fixture();
  f.files.set(
    join(dir, "in", "1.json"),
    JSON.stringify({ id: "awake", op: "call", tool: "observe", args: {} }),
  );
  const listFiles = f.deps.listFiles;
  let slept = false;
  f.deps.listFiles = (path) => {
    if (!slept && path === join(dir, "in")) {
      slept = true;
      f.timer.simulateHostSleep(60_000);
    }
    return listFiles(path);
  };
  const writeJson = f.deps.writeJson;
  f.deps.writeJson = (path, value) => {
    writeJson(path, value);
    if (path === join(dir, "out", "1.json")) {
      f.files.set(join(dir, "in", "2.json"), JSON.stringify({ id: "close", op: "close" }));
    }
  };
  f.timer.enableAutoAdvance();
  try {
    expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(0);
    const response = JSON.parse(f.files.get(join(dir, "out", "1.json"))!);
    expect(response).not.toHaveProperty("invalid");
    expect(response).not.toHaveProperty("hostSleptMs");
    expect(f.files.get(join(dir, "host-sleep.json"))).toBeUndefined();
  } finally {
    f.timer.reset();
  }
});
posixTest("serve starts requests concurrently and guards inbox device starts too", async () => {
  const f = fixture();
  let resolveCall!: (value: unknown) => void;
  f.client.callTool = (tool) => {
    f.calls.push(tool);
    return new Promise((done) => {
      resolveCall = done;
    });
  };
  f.client.listTools = async () => {
    f.calls.push("tools");
    resolveCall({ done: true });
    return { tools: [] };
  };
  for (const [id, body] of [
    ["1", { op: "call", tool: "observe", args: {} }],
    ["2", { op: "tools" }],
    ["3", { op: "call", tool: "startDevice", args: { platform: "android" } }],
    ["4", { op: "close" }],
  ] as const) {
    f.files.set(join(dir, "in", `${id}.json`), JSON.stringify({ id, ...body }));
  }
  try {
    expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(0);
    expect(f.calls).toEqual(["createClient", "observe", "tools", "close"]);
    expect(JSON.parse(f.files.get(join(dir, "out", "3.json"))!).ok).toBe(false);
  } finally {
    f.timer.reset();
  }
});
posixTest("serve initialization failure records typed error and closes client", async () => {
  const f = fixture();
  f.client.connect = async () => {
    throw new Error("fake initialize failure");
  };
  try {
    expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(4);
    expect(JSON.parse(f.files.get(join(dir, "init.json"))!).ok).toBe(false);
    expect(f.calls).toEqual(["createClient", "close"]);
    expect(f.exits).toEqual([4]);
  } finally {
    f.timer.reset();
  }
});

posixTest("serve polling failure closes its client and writes closed.json", async () => {
  const f = fixture();
  f.deps.listFiles = () => {
    throw new Error("fake inbox failure");
  };
  try {
    expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(1);
    expect(f.calls).toEqual(["createClient", "close"]);
    expect(JSON.parse(f.files.get(join(dir, "closed.json"))!).reason).toBe("driver_failed");
    expect(f.exits).toEqual([1]);
  } finally {
    f.timer.reset();
  }
});

posixTest("up success waits for initialize and keeps the parsed config/env", async () => {
  const f = fixture();
  const command = parsed(["up", "--dir", dir, "--env", "NOTE=value"]);
  let daemonAliveChecked = false;
  f.deps.isPidAlive = (pid) => {
    expect(pid).toBe(9876);
    daemonAliveChecked = true;
    return true;
  };
  f.deps.spawnServe = (received) => {
    expect(daemonAliveChecked).toBe(true);
    expect(received).toEqual(command);
    f.calls.push("spawnServe");
    f.files.set(join(dir, "init.json"), '{"ok":true,"driverPid":1234}');
    return 1234;
  };
  expect(await runProxySessionCommand(command, f.deps)).toBe(0);
  expect(f.calls).toEqual(["spawnServe"]);
  expect(f.logs.join(" ")).toContain('"driverPid": 1234');
});

posixTest(
  "call @file and resource/status commands use existing session without spawning",
  async () => {
    const f = fixture();
    f.files.set(join(dir, "init.json"), '{"ok":true}');
    f.files.set("args.json", '{"avdName":"TestOnly"}');
    const inputs = [
      ["call", "getAndroid", "@args.json"],
      ["read", "automobile:devices"],
      ["subscribe", "automobile:devices"],
      ["tools"],
      ["resources"],
      ["close"],
    ];
    for (const [index, input] of inputs.entries()) {
      f.files.set(join(dir, "out", `request-${index + 1}.json`), '{"ok":true,"result":{}}');
      expect(
        await runProxySessionCommand(parsed([input[0], "--dir", dir, ...input.slice(1)]), f.deps),
      ).toBe(0);
    }
    expect(JSON.parse(f.files.get(join(dir, "in", "request-1.json"))!).args).toEqual({
      avdName: "TestOnly",
    });
    expect(await runProxySessionCommand(parsed(["status", "--dir", dir]), f.deps)).toBe(0);
    expect(f.calls).toEqual([]);
  },
);

posixTest("up and serve refuse missing, invalid or dead daemon pid before any spawn", async () => {
  for (const op of ["up", "serve"]) {
    for (const text of [
      undefined,
      "not-json",
      "{}",
      '{"pid":"9876"}',
      '{"pid":0}',
      '{"pid":9876}',
    ]) {
      const f = fixture();
      const path = f.deps.env.AUTOMOBILE_DAEMON_PID_FILE_PATH!;
      if (text === undefined) {
        f.files.delete(path);
      } else {
        f.files.set(path, text);
      }
      f.deps.isPidAlive = () => false;
      expect(await runProxySessionCommand(parsed([op, "--dir", dir]), f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
      expect(f.writes).toEqual([]);
      expect(f.logs.join(" ")).toContain("private-daemon.ts start");
    }
  }
});
posixTest(
  "schema-invalid inbox gets an error, incomplete JSON retries, following call is served",
  async () => {
    const f = fixture();
    const incomplete = join(dir, "in", "2.json");
    f.files.set(join(dir, "in", "1.json"), '{"id":"1","op":"call"}');
    f.files.set(incomplete, '{"id":');
    const listFiles = f.deps.listFiles;
    let polls = 0;
    f.deps.listFiles = (path) => {
      if (++polls === 2) {
        f.files.set(incomplete, '{"id":"2","op":"call","tool":"observe","args":{}}');
      }
      return listFiles(path);
    };
    const writeJson = f.deps.writeJson;
    f.deps.writeJson = (path, value) => {
      writeJson(path, value);
      if (path === join(dir, "out", "2.json")) {
        f.files.set(join(dir, "in", "3.json"), '{"id":"3","op":"close"}');
      }
    };
    f.timer.enableAutoAdvance();
    try {
      expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(0);
      expect(JSON.parse(f.files.get(join(dir, "out", "1.json"))!).ok).toBe(false);
      expect(JSON.parse(f.files.get(join(dir, "out", "2.json"))!).ok).toBe(true);
      expect(f.calls).toEqual(["createClient", "observe", "close"]);
      expect(f.logs.join(" ")).toContain("Invalid inbox request");
      expect(f.logs.join(" ")).toContain("Incomplete inbox request");
    } finally {
      f.timer.reset();
    }
  },
);

posixTest("live pid with dead socket refuses before spawnServe", async () => {
  const f = fixture();
  f.deps.probeDaemonSocket = async () => ({ alive: false, reason: "fake dead socket" });
  f.deps.spawnServe = () => {
    throw new Error("must not spawnServe");
  };
  expect(await runProxySessionCommand(parsed(["up", "--dir", dir]), f.deps)).toBe(2);
  expect(f.calls).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.logs.join(" ")).toContain("fake dead socket");
});

import { selectHarnessLogSink } from "../../scripts/manual-test/harnessLogSink";
import {
  PROXY_SESSION_COMMANDS,
  PROXY_SESSION_FLAGS,
} from "../../scripts/manual-test/proxySessionHelp";
test("proxy help variants enumerate every parser command and flag", () => {
  for (const args of [["--help"], ["-h"], ["help"], ["call", "--help"]]) {
    const result = parseProxySessionArgs(args);
    if (!("help" in result)) {
      throw new Error("Expected help");
    }
    for (const name of [...PROXY_SESSION_COMMANDS, ...Object.keys(PROXY_SESSION_FLAGS)]) {
      expect(result.help).toContain(name);
    }
  }
});
posixTest("proxy child receives undone sink override and live socket permits startup", async () => {
  const f = fixture();
  delete f.deps.env.AUTOMOBILE_LOG_DIR;
  f.deps.logSinkOverride = selectHarnessLogSink(f.deps.env, [resolve("/home/fake")], {
    realpath: resolve,
  });
  f.deps.env.AUTOMOBILE_LOG_DIR = "/private/logs";
  const probes: string[] = [];
  f.deps.probeDaemonSocket = async (path) => {
    probes.push(path);
    return { alive: true };
  };
  f.deps.spawnServe = (_command, env) => {
    expect(env.AUTOMOBILE_LOG_SINK).toBeUndefined();
    expect(env.AUTOMOBILE_LOG_DIR).toBe("/private/logs");
    f.files.set(join(dir, "init.json"), '{"ok":true}');
    return 1234;
  };
  expect(await runProxySessionCommand(parsed(["up", "--dir", dir]), f.deps)).toBe(0);
  expect(probes).toEqual([f.deps.env.AUTOMOBILE_DAEMON_SOCKET_PATH!]);
});
posixTest("status reports answering daemon socket and serve refuses a recycled pid", async () => {
  const f = fixture();
  f.deps.probeDaemonSocket = async () => ({ alive: false, reason: "gone" });
  expect(await runServe(parsed(["serve", "--dir", dir]), f.deps)).toBe(2);
  expect(f.calls).toEqual([]);
  expect(await runProxySessionCommand(parsed(["status", "--dir", dir]), f.deps)).toBe(0);
  expect(JSON.parse(f.logs.at(-1)!).daemonSocketAlive).toBe(false);
  f.deps.probeDaemonSocket = async () => ({ alive: true });
  expect(await runProxySessionCommand(parsed(["status", "--dir", dir]), f.deps)).toBe(0);
  expect(JSON.parse(f.logs.at(-1)!).daemonSocketAlive).toBe(true);
});

import { main as helpMain } from "../../scripts/manual-test/proxy-session";
test("help main writes stdout and returns zero for top-level and subcommand help", async () => {
  const argv = process.argv;
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const args of [["--help"], ["-h"], ["help"], ["call", "--help"]]) {
      process.argv = ["bun", "proxy-session.ts", ...args];
      expect(await helpMain()).toBe(0);
    }
    expect(out).toHaveBeenCalledTimes(4);
    expect(err).not.toHaveBeenCalled();
    process.argv = ["bun", "proxy-session.ts", "invalid-command"];
    expect(await helpMain()).toBe(2);
    expect(err.mock.calls[0][0]).toContain("--help for usage");
  } finally {
    process.argv = argv;
    out.mockRestore();
    err.mockRestore();
  }
});

const brokerDir = resolve("/batch/sessions/a-phone");
const requirement = {
  schemaVersion: 1,
  platform: "android",
  hardware: { kind: "archetype", archetype: "phone" },
  os: { kind: "omitted" },
};
function brokerFixture(outcome: SessionBrokerResult["outcome"] = "ready") {
  const f = fixture();
  f.deps.env.MT_BATCH = "/batch";
  const clients = Object.fromEntries(
    ["a-phone", "other"].map((name) => [
      name,
      {
        platform: "android",
        profile: requirement,
        requestId: `batch-id-${name}-1`,
        tokenFile: `sessions/${name}/owner-token`,
      },
    ]),
  );
  f.files.set("/batch/broker/clients.json", JSON.stringify(clients));
  const session: SessionBrokerResult = {
    contractVersion: 1,
    requestId: "batch-id-a-phone-1",
    outcome,
    sessionUuid: outcome === "ready" ? "own-session" : null,
    profile:
      outcome === "ready"
        ? {
            platform: "android",
            metadataState: "current",
            archetype: "phone",
            profileId: "medium_phone",
            apiLevel: 35,
            osVersion: "15",
            versionPrecision: "major",
            abi: "arm64-v8a",
            flavor: "google_apis",
            systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
          }
        : null,
    cleanupPending: outcome === "pending",
    ...(outcome === "failed"
      ? { failure: { code: "capacity_exhausted", message: "Capacity exhausted", retryable: false } }
      : {}),
  };
  f.client.capabilities = () => ({
    experimental: { [SESSION_EXPERIMENTAL_CAPABILITY]: session },
    ...(outcome === "ready" ? { tools: {} } : {}),
  });
  const initialize = () => {
    f.files.set(join(brokerDir, "init.json"), JSON.stringify({ ok: true, session }));
    f.files.set(join(brokerDir, "driver.pid"), "1234\n");
    return 1234;
  };
  f.deps.spawnServe = initialize;
  const up = (extra: string[] = []) =>
    runProxySessionCommand(parsed(["up", "--client", "a-phone", ...extra]), f.deps);
  return { ...f, session, up, initialize };
}
test("broker parser flags reject incompatible, removed and malformed options", () => {
  for (const args of [
    ["up", "--config", "old.json", "--dir", dir],
    ["up", "--client", "a", "--dir", dir],
    ["up", "--client", "a", "--profile", "phone", "--request", "{}"],
    ["up", "--client", "a", "--resume", "--profile", "phone"],
    ["up", "--client", "a", "--owner", "host"],
    ["up", "--client", "a", "--expect", "pending"],
    ["call", "--client", "a", "observe", "--allow-selector"],
    ["status", "--all", "--client", "a"],
    ["up", "--dir", dir, "--resume"],
    ["up", "--client", "a", "--resume", "--resume"],
  ]) {
    expect(parseProxySessionArgs(args)).toHaveProperty("error");
  }
  expect(parsed(["status", "--all"]).all).toBe(true);
});
posixTest(
  "broker up uses the real flat outcome contract and expected outcome exit codes",
  async () => {
    for (const [outcome, expected, code] of [
      ["ready", undefined, 0],
      ["failed", undefined, 1],
      ["pending", undefined, 1],
      ["failed", "failed:capacity_exhausted", 0],
      ["ready", "failed:capacity_exhausted", 2],
      ["failed", "ready", 2],
      ["ready", "ready", 0],
      ["pending", "ready", 2],
    ] as const) {
      const f = brokerFixture(outcome);
      expect(await f.up(expected ? ["--expect", expected] : [])).toBe(code);
      expect(JSON.parse(f.files.get(join(brokerDir, "init.json"))!).session).toEqual(f.session);
      if (outcome === "failed") {
        expect(f.logs.join(" ")).toContain("capacity_exhausted");
      }
      if (outcome === "pending") {
        expect(f.logs.join(" ")).toContain("session_status_unresolved");
      }
    }
  },
);
posixTest(
  "broker up refuses live driver, resume preserves identity, fresh attempt archives prior bytes",
  async () => {
    const f = brokerFixture("failed");
    expect(await f.up()).toBe(1);
    const request = f.files.get(join(brokerDir, "request.json"));
    const token = f.files.get(join(brokerDir, "owner-token"));
    const writes = f.writes.length;
    expect(await f.up()).toBe(2);
    expect(f.writes.length).toBe(writes);
    f.deps.isPidAlive = (pid) => pid !== 1234;
    expect(await f.up(["--resume"])).toBe(1);
    expect(f.files.get(join(brokerDir, "request.json"))).toBe(request);
    expect(f.files.get(join(brokerDir, "owner-token"))).toBe(token);
    expect(JSON.parse(f.files.get(join(brokerDir, "attempts.json"))!)).toEqual([
      "batch-id-a-phone-1",
    ]);
    expect(await f.up()).toBe(1);
    expect(JSON.parse(f.files.get(join(brokerDir, "request.json"))!).requestId).toBe(
      "batch-id-a-phone-2",
    );
    expect(f.files.get(join(brokerDir, "attempts/1/execution/request.json"))).toBe(request);
    expect(f.files.get(join(brokerDir, "owner-token"))).toBe(token);
    expect(f.logs.join(" ")).not.toContain(token!);
  },
);
posixTest(
  "broker serve passes session flags, captures session/socket and redacts token in evidence",
  async () => {
    const f = brokerFixture();
    let options: Parameters<ProxySessionDeps["createClient"]>[0] | undefined;
    f.deps.createClient = (received) => {
      options = received;
      received.onNotification({ message: received.livenessOwnerToken });
      return f.client;
    };
    f.client.serverInfo = () => ({ message: options?.livenessOwnerToken });
    f.files.set(join(brokerDir, "in", "close.json"), '{"id":"close","op":"close"}');
    expect(await runServe(parsed(["serve", "--client", "a-phone"]), f.deps)).toBe(0);
    expect(options?.sessionConfig).toBe(join(brokerDir, "request.json"));
    expect(options?.livenessOwnerToken).toBe(f.files.get(join(brokerDir, "owner-token")));
    const init = JSON.parse(f.files.get(join(brokerDir, "init.json"))!);
    expect(init.session).toEqual(f.session);
    expect(init.daemonSocketAlive).toBe(true);
    expect(init).not.toHaveProperty("managedSlots");
    const token = f.files.get(join(brokerDir, "owner-token"))!;
    for (const [path, bytes] of f.files) {
      if (path.endsWith(".json") || path.endsWith(".jsonl")) {
        expect(bytes).not.toContain(token);
      }
    }
    expect(f.logs.join(" ")).not.toContain(token);
  },
);
posixTest(
  "broker guards refuse unavailable session, dead driver, forbidden tools and inventory before publication",
  async () => {
    for (const outcome of ["failed", "pending", "ready"] as const) {
      const f = brokerFixture(outcome);
      await f.up();
      if (outcome === "ready") {
        f.deps.isPidAlive = (pid) => pid !== 1234;
      }
      const before = f.writes.length;
      for (const input of [
        ["call", "observe"],
        ["read", "custom:resource"],
        ["tools"],
        ["resources"],
        ["subscribe", "custom:resource"],
      ]) {
        expect(
          await runProxySessionCommand(
            parsed([input[0], "--client", "a-phone", ...input.slice(1)]),
            f.deps,
          ),
        ).toBe(2);
      }
      expect(f.writes.length).toBe(before);
    }
    const f = brokerFixture();
    await f.up();
    const before = f.writes.length;
    for (const tool of ["startDevice", "provisionDevice", "getAndroid", "getApple", "killDevice"]) {
      expect(
        await runProxySessionCommand(
          parsed(["call", "--client", "a-phone", tool, '{"sessionUuid":"own-session"}']),
          f.deps,
        ),
      ).toBe(2);
    }
    for (const input of [
      ["resources"],
      ["read", "automobile:devices/booted"],
      ["subscribe", "automobile:devices/available"],
    ]) {
      expect(
        await runProxySessionCommand(
          parsed([input[0], "--client", "a-phone", ...input.slice(1)]),
          f.deps,
        ),
      ).toBe(2);
    }
    expect(f.writes.length).toBe(before);
  },
);
posixTest("foreign selectors require the exact ready grant of another batch client", async () => {
  const f = brokerFixture();
  await f.up();
  f.files.set(
    "/batch/sessions/other/init.json",
    JSON.stringify({ session: { ...f.session, sessionUuid: "other-session" } }),
  );
  const call = (selector: unknown, foreign?: string) =>
    runProxySessionCommand(
      parsed([
        "call",
        "--client",
        "a-phone",
        "observe",
        JSON.stringify(selector),
        ...(foreign ? ["--allow-foreign-session", foreign] : []),
      ]),
      f.deps,
    );
  expect(await call({ sessionUuid: "other-session" })).toBe(2);
  expect(await call({ nested: { deviceId: "foreign" } })).toBe(2);
  expect(await call({ sessionUuid: "other-session" }, "missing")).toBe(2);
  expect(await call({ sessionUuid: "other-session" }, "a-phone")).toBe(2);
  expect(await call({ sessionUuid: "random" }, "other")).toBe(2);
  // Token consumed request-1; the first successfully published MCP request gets request-2.
  f.files.set(join(brokerDir, "out", "request-2.json"), '{"ok":true,"result":{}}');
  expect(await call({ sessionUuid: "other-session" }, "other")).toBe(0);
  expect(
    JSON.parse(f.files.get(join(brokerDir, "in", "request-2.json"))!).allowForeignSession,
  ).toBe("other");
  f.files.set(join(brokerDir, "out", "request-3.json"), '{"ok":true,"result":{}}');
  expect(await call({ deviceId: "own-session" })).toBe(0);
});
posixTest(
  "profile/request validate before spawn; disposable owner records PID and generation",
  async () => {
    for (const extra of [
      ["--profile", '{"platform":"bogus"}'],
      ["--request", '{"contractVersion":2}'],
      ["--profile", "not-an-archetype"],
    ]) {
      const f = brokerFixture();
      expect(await f.up([...extra, "--owner", "disposable"])).toBe(2);
      expect(f.calls).toEqual([]);
      expect(f.writes).toEqual([]);
    }
    const f = brokerFixture();
    expect(await f.up(["--profile", "tablet", "--owner", "disposable"])).toBe(0);
    expect(JSON.parse(f.files.get(join(brokerDir, "request.json"))!)).toMatchObject({
      requestId: "batch-id-a-phone-1",
      device: { hardware: { kind: "archetype", archetype: "tablet" } },
      executionOwnerPid: 2468,
      executionOwnerStartIdentity: "fake-owner-generation",
    });
    expect(f.files.get(join(brokerDir, "owner.pid"))).toBe("2468\n");
    expect(f.calls).toEqual(["spawnOwner"]);
  },
);
posixTest("status reports broker fields and --all covers unstarted clients", async () => {
  const f = brokerFixture("failed");
  await f.up();
  expect(await runProxySessionCommand(parsed(["status", "--client", "a-phone"]), f.deps)).toBe(0);
  expect(JSON.parse(f.logs.at(-1)!)).toMatchObject({
    session: {
      outcome: "failed",
      failure: { code: "capacity_exhausted", retryable: false },
      cleanupPending: false,
    },
    ownerAlive: true,
    daemonSocketAlive: true,
  });
  expect(await runProxySessionCommand(parsed(["status", "--all"]), f.deps)).toBe(0);
  expect(f.logs.at(-1)).toContain("a-phone\tfailed");
  expect(f.logs.at(-1)).toContain("other\tnot_started");
  expect(f.logs.join(" ")).not.toContain(f.files.get(join(brokerDir, "owner-token"))!);
});

posixTest(
  "broker driver independently refuses inbox guard bypasses and unavailable outcomes",
  async () => {
    for (const outcome of ["ready", "failed", "pending"] as const) {
      const f = brokerFixture(outcome);
      for (const [id, request] of [
        [
          "1",
          {
            op: "call",
            tool: "startDevice",
            args: { sessionUuid: "own-session" },
            allowSelector: true,
          },
        ],
        ["2", { op: "call", tool: "observe", args: { sessionUuid: "foreign-session" } }],
        ["3", { op: "resources" }],
        ["4", { op: "read", uri: "automobile:devices/booted" }],
        ["5", { op: "close" }],
      ] as const) {
        f.files.set(join(brokerDir, "in", `${id}.json`), JSON.stringify({ id, ...request }));
      }
      expect(await runServe(parsed(["serve", "--client", "a-phone"]), f.deps)).toBe(0);
      expect(f.calls).toEqual(["createClient", "close"]);
      for (const id of ["1", "2", "3", "4"]) {
        expect(JSON.parse(f.files.get(join(brokerDir, "out", `${id}.json`))!).ok).toBe(false);
      }
      const init = JSON.parse(f.files.get(join(brokerDir, "init.json"))!);
      expect(init.session).toEqual(f.session);
      if (outcome !== "ready") {
        expect(init.capabilities).not.toHaveProperty("tools");
      }
    }
  },
);
posixTest(
  "broker initialization errors redact the liveness token from all evidence and logs",
  async () => {
    const f = brokerFixture();
    f.deps.createClient = (options) => {
      f.client.connect = async () => {
        throw new Error(`refused owner ${options.livenessOwnerToken}`);
      };
      return f.client;
    };
    expect(await runServe(parsed(["serve", "--client", "a-phone"]), f.deps)).toBe(4);
    const token = f.files.get(join(brokerDir, "owner-token"))!;
    expect(f.files.get(join(brokerDir, "init.json"))).toContain("[REDACTED]");
    expect(f.files.get(join(brokerDir, "init.json"))).not.toContain(token);
    expect(f.logs.join(" ")).not.toContain(token);
  },
);
posixTest(
  "direct serve validates an explicit override rather than silently replaying a prepared request",
  async () => {
    const f = brokerFixture();
    await f.up();
    f.files.delete(join(brokerDir, "driver.pid"));
    f.files.delete(join(brokerDir, "init.json"));
    expect(
      await runServe(
        parsed(["serve", "--client", "a-phone", "--profile", '{"invalid":true}']),
        f.deps,
      ),
    ).toBe(2);
    expect(f.calls).toEqual([]);
    expect(JSON.parse(f.files.get(join(brokerDir, "request.json"))!).requestId).toBe(
      "batch-id-a-phone-1",
    );
  },
);
posixTest(
  "inline profile and file request use new batch IDs and preserve product-validated timeouts",
  async () => {
    const inline = brokerFixture();
    expect(
      await inline.up([
        "--profile",
        JSON.stringify({ ...requirement, hardware: { kind: "archetype", archetype: "tablet" } }),
      ]),
    ).toBe(0);
    expect(
      JSON.parse(inline.files.get(join(brokerDir, "request.json"))!).device.hardware.archetype,
    ).toBe("tablet");
    const f = brokerFixture();
    f.files.set(
      "request-input.json",
      JSON.stringify({
        contractVersion: 1,
        requestId: "ignored-input-id",
        device: requirement,
        idleTimeoutMs: 600000,
      }),
    );
    expect(await f.up(["--request", "request-input.json"])).toBe(0);
    expect(JSON.parse(f.files.get(join(brokerDir, "request.json"))!)).toMatchObject({
      requestId: "batch-id-a-phone-1",
      idleTimeoutMs: 600000,
    });
  },
);
posixTest(
  "broker requests require a capability grant even after successful MCP initialize",
  async () => {
    const f = brokerFixture();
    f.deps.spawnServe = () => {
      f.files.set(join(brokerDir, "init.json"), '{"ok":true}');
      return 1234;
    };
    expect(await f.up()).toBe(1);
    expect(f.logs.join(" ")).toContain("session_broker_unavailable");
    const before = f.writes.length;
    expect(
      await runProxySessionCommand(parsed(["call", "--client", "a-phone", "observe"]), f.deps),
    ).toBe(2);
    expect(f.writes.length).toBe(before);
  },
);

posixTest(
  "broker lifecycle release polls cleanup, abandon accepts unknown requests, and info writes native binding",
  async () => {
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    f.deps.brokerDaemonClient = broker;
    const released = { ...f.session, outcome: "released" as const, cleanupPending: false };
    broker.releaseResults = [{ sessionUuid: "own-session", outcome: "cleanup_pending" }];
    broker.statusResults = [{ ...released, cleanupPending: true }, released];
    const pending = runProxySessionCommand(parsed(["release", "--client", "a-phone"]), f.deps);
    await drainUntilQuiescent(f.timer);
    f.timer.advanceTime(250);
    expect(await pending).toBe(0);
    expect(broker.calls.map((c) => c.method)).toEqual(["release", "status", "status"]);
    broker.abandonResults = [
      {
        ...released,
        outcome: "failed",
        sessionUuid: null,
        failure: {
          code: "session_request_abandoned",
          retryable: false,
          message: "Abandoned unknown request",
        },
      },
    ];
    f.files.delete(join(brokerDir, "init.json"));
    expect(await runProxySessionCommand(parsed(["abandon", "--client", "a-phone"]), f.deps)).toBe(
      0,
    );
    f.initialize();
    broker.infoResults = [
      {
        sessionId: "own-session",
        assignedDevice: "native",
        nativeDevice: { deviceId: "native", name: "ambroker-device", platform: "android" },
      },
    ];
    expect(await runProxySessionCommand(parsed(["info", "--client", "a-phone"]), f.deps)).toBe(0);
    expect(JSON.parse(f.files.get(join(brokerDir, "info.json"))!)).toEqual(broker.infoResults[0]);
    expect(f.files.get("/batch/evidence/ledger.jsonl")).toContain('"kind":"info"');
    const token = f.files.get(join(brokerDir, "owner-token"))!;
    expect(broker.calls[0].args).toEqual(["own-session", token]);
    expect(f.logs.join(" ")).not.toContain(token);
  },
);
posixTest(
  "as-client is batch guarded, reads only stored tokens, and redacts both owners",
  async () => {
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    f.deps.brokerDaemonClient = broker;
    f.files.set(
      "/batch/sessions/other/request.json",
      JSON.stringify({
        ...JSON.parse(f.files.get(join(brokerDir, "request.json"))!),
        requestId: "batch-id-other-1",
      }),
    );
    f.files.set("/batch/sessions/other/attempts.json", '["batch-id-other-1"]');
    f.files.set("/batch/sessions/other/owner-token", "other-secret");
    for (const name of ["a-phone", "missing"]) {
      expect(
        await runProxySessionCommand(
          parsed(["release", "--client", "a-phone", "--as-client", name]),
          f.deps,
        ),
      ).toBe(2);
    }
    expect(broker.calls).toEqual([]);
    broker.releaseResults = [{ sessionUuid: "own-session", outcome: "unknown_session" }];
    expect(
      await runProxySessionCommand(
        parsed(["release", "--client", "a-phone", "--as-client", "other"]),
        f.deps,
      ),
    ).toBe(1);
    expect(broker.calls.at(-1)?.args).toEqual(["own-session", "other-secret"]);
    expect(f.logs.join(" ")).toContain("Isolation test:");
    broker.abandonResults = [
      new Error(`other-secret ${f.files.get(join(brokerDir, "owner-token"))!}`),
    ];
    expect(
      await runProxySessionCommand(
        parsed(["abandon", "--client", "a-phone", "--as-client", "other"]),
        f.deps,
      ),
    ).toBe(2);
    expect(f.logs.join(" ")).not.toContain("other-secret");
    expect(f.logs.join(" ")).not.toContain(f.files.get(join(brokerDir, "owner-token"))!);
  },
);
posixTest(
  "owner-kill fences PID reuse, missing identity, and driver/proxy targets before signaling",
  async () => {
    for (const mode of ["different", "unknown", "missing", "driver", "proxy"] as const) {
      const f = brokerFixture();
      await f.up(["--owner", "disposable"]);
      const signals: unknown[] = [];
      f.deps.compareOwnerIdentity = () =>
        mode === "different" ? "different" : mode === "unknown" ? "unknown" : "same";
      f.deps.signalPid = (...args) => {
        signals.push(args);
      };
      if (mode === "missing") {
        f.files.delete(join(brokerDir, "owner-identity"));
      }
      if (mode === "driver" || mode === "proxy") {
        f.files.set(join(brokerDir, `${mode}.pid`), "2468\n");
      }
      expect(
        await runProxySessionCommand(parsed(["owner-kill", "--client", "a-phone"]), f.deps),
      ).toBe(2);
      expect(signals).toEqual([]);
    }
  },
);
posixTest(
  "owner-kill escalates only a confirmed disposable owner and rechecks identity",
  async () => {
    for (const reused of [false, true]) {
      const f = brokerFixture();
      await f.up(["--owner", "disposable"]);
      const signals: Array<[number, string]> = [];
      let checked = 0;
      f.deps.compareOwnerIdentity = () => (++checked === 2 && reused ? "different" : "same");
      f.deps.signalPid = (pid, signal) => {
        signals.push([pid, signal]);
      };
      f.deps.isPidAlive = (pid) =>
        pid !== 2468 || !signals.some(([, signal]) => signal === "SIGKILL");
      const pending = runProxySessionCommand(parsed(["owner-kill", "--client", "a-phone"]), f.deps);
      await drainUntilQuiescent(f.timer);
      f.timer.advanceTime(1000);
      expect(await pending).toBe(reused ? 2 : 0);
      expect(signals).toEqual(
        reused
          ? [[2468, "SIGTERM"]]
          : [
              [2468, "SIGTERM"],
              [2468, "SIGKILL"],
            ],
      );
    }
  },
);
posixTest("broker close waits for released status and records driver close evidence", async () => {
  const f = brokerFixture();
  await f.up();
  const broker = new FakeBrokerDaemonClient();
  f.deps.brokerDaemonClient = broker;
  broker.statusResults = [
    { ...f.session, cleanupPending: false },
    { ...f.session, outcome: "released" },
  ];
  f.files.set(join(brokerDir, "out", "request-2.json"), '{"ok":true,"result":{}}');
  f.files.set(join(brokerDir, "closed.json"), '{"reason":"closed"}');
  const pending = runProxySessionCommand(parsed(["close", "--client", "a-phone"]), f.deps);
  await drainUntilQuiescent(f.timer);
  expect(JSON.parse(f.files.get(join(brokerDir, "closed.json"))!)).not.toHaveProperty("release");
  f.timer.advanceTime(250);
  expect(await pending).toBe(0);
  expect(JSON.parse(f.files.get(join(brokerDir, "closed.json"))!)).toMatchObject({
    reason: "closed",
    release: { outcome: "released" },
  });
  expect(broker.calls.map((c) => c.method)).toEqual(["status", "status"]);
});
posixTest(
  "broker live status is included per client and connection failure stays diagnostic",
  async () => {
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    f.deps.brokerDaemonClient = broker;
    broker.statusResults = [{ ...f.session, outcome: "released" }];
    expect(await runProxySessionCommand(parsed(["status", "--client", "a-phone"]), f.deps)).toBe(0);
    expect(JSON.parse(f.logs.at(-1)!)).toMatchObject({ liveStatus: { outcome: "released" } });
    expect(await runProxySessionCommand(parsed(["status", "--all"]), f.deps)).toBe(0);
    expect(f.logs.at(-1)).toContain('"outcome":"released"');
    broker.statusResults = [new Error("socket refused")];
    expect(await runProxySessionCommand(parsed(["status", "--client", "a-phone"]), f.deps)).toBe(0);
    expect(JSON.parse(f.logs.at(-1)!)).toMatchObject({ liveStatus: { unavailable: true } });
  },
);

posixTest(
  "broker status resolves daemon 1 socket from batch.json rather than wrapper environment",
  async () => {
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    const socket = "/batch/daemon1/broker.sock";
    f.files.set(
      "/batch/batch.json",
      JSON.stringify({
        broker: { daemon: 1 },
        specs: [
          { index: 2, socketPath: "/batch/daemon2/other.sock" },
          { index: 1, socketPath: socket },
        ],
      }),
    );
    const paths: string[] = [];
    f.deps.createBrokerDaemonClient = (path) => {
      paths.push(path);
      return broker;
    };
    f.deps.probeDaemonSocket = async (path) => {
      expect(path).toBe(socket);
      return { alive: true };
    };
    expect(await runProxySessionCommand(parsed(["status", "--client", "a-phone"]), f.deps)).toBe(0);
    expect(await runProxySessionCommand(parsed(["status", "--all"]), f.deps)).toBe(0);
    expect(paths).toEqual([socket, socket]);
  },
);
posixTest("release and close cannot succeed on unknown or perpetually pending status", async () => {
  for (const op of ["release", "close"] as const) {
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    f.deps.brokerDaemonClient = broker;
    broker.releaseResults = [{ sessionUuid: "own-session", outcome: "cleanup_pending" }];
    broker.statusResults = [undefined];
    if (op === "close") {
      f.files.set(join(brokerDir, "closed.json"), '{"reason":"closed"}');
    }
    const pending = runProxySessionCommand(parsed([op, "--client", "a-phone"]), f.deps);
    await drainUntilQuiescent(f.timer);
    f.timer.advanceTime(240000);
    expect(await pending).toBe(2);
    expect(f.logs.join(" ")).toContain("timed out");
    if (op === "close") {
      expect(JSON.parse(f.files.get(join(brokerDir, "closed.json"))!)).not.toHaveProperty(
        "release",
      );
    }
    f.timer.reset();
  }
});
posixTest(
  "clean close publishes a request then joins driver evidence and release status",
  async () => {
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    f.deps.brokerDaemonClient = broker;
    broker.statusResults = [{ ...f.session, outcome: "released" }];
    const writeJson = f.deps.writeJson;
    f.deps.writeJson = (path, value) => {
      writeJson(path, value);
      if (path === join(brokerDir, "in", "request-2.json")) {
        f.files.set(join(brokerDir, "out", "request-2.json"), '{"ok":true}');
      }
    };
    const pending = runProxySessionCommand(parsed(["close", "--client", "a-phone"]), f.deps);
    await drainUntilQuiescent(f.timer);
    expect(JSON.parse(f.files.get(join(brokerDir, "in", "request-2.json"))!)).toMatchObject({
      op: "close",
    });
    f.files.set(join(brokerDir, "closed.json"), '{"reason":"close_requested"}');
    f.timer.advanceTime(50);
    expect(await pending).toBe(0);
    expect(JSON.parse(f.files.get(join(brokerDir, "closed.json"))!)).toMatchObject({
      reason: "close_requested",
      release: { outcome: "released" },
    });
  },
);
posixTest("lifecycle operations require the stored identity and broker-only flags", async () => {
  for (const op of ["release", "abandon", "info", "owner-kill"]) {
    expect(parseProxySessionArgs([op, "--dir", dir])).toHaveProperty("error");
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    f.deps.brokerDaemonClient = broker;
    f.files.delete(join(brokerDir, "owner-token"));
    expect(await runProxySessionCommand(parsed([op, "--client", "a-phone"]), f.deps)).toBe(2);
    expect(broker.calls).toEqual([]);
  }
  expect(
    parseProxySessionArgs(["info", "--client", "a-phone", "--as-client", "other"]),
  ).toHaveProperty("error");
});

posixTest.each(["call", "read", "subscribe", "resources"])(
  "broker batch refuses sessionless --dir %s before publication",
  async (op) => {
    const f = brokerFixture();
    await f.up();
    const args =
      op === "call" ? ["observe"] : ["read", "subscribe"].includes(op) ? ["custom:resource"] : [];
    const before = f.writes.length;
    expect(await runProxySessionCommand(parsed([op, "--dir", brokerDir, ...args]), f.deps)).toBe(2);
    expect(f.writes.length).toBe(before);
    expect(f.logs.join(" ")).toContain("require --client");
  },
);

posixTest(
  "broker info fails closed on missing native identity and never appends an info record",
  async () => {
    const f = brokerFixture();
    await f.up();
    const broker = new FakeBrokerDaemonClient();
    f.deps.brokerDaemonClient = broker;
    broker.infoResults = [{ sessionId: "own-session", assignedDevice: "emulator-5556" }];
    expect(await runProxySessionCommand(parsed(["info", "--client", "a-phone"]), f.deps)).not.toBe(
      0,
    );
    expect(f.files.get("/batch/evidence/ledger.jsonl") ?? "").not.toContain('"kind":"info"');
  },
);

posixTest(
  "broker manifest still blocks a sessionless call when clients.json is missing",
  async () => {
    const f = brokerFixture();
    await f.up();
    f.files.delete("/batch/broker/clients.json");
    f.files.set("/batch/batch.json", JSON.stringify({ broker: { daemon: 1 } }));
    const before = f.writes.length;
    expect(
      await runProxySessionCommand(parsed(["call", "--dir", brokerDir, "observe"]), f.deps),
    ).toBe(2);
    expect(f.writes.length).toBe(before);
  },
);
