import { expect, test } from "bun:test";
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
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
const posixTest = process.platform === "win32" ? test.skip : test;
const dir = resolve("/session");
function parsed(args: string[]): ProxySessionCommand {
  const result = parseProxySessionArgs(args);
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
    host: { homeDirs: ["/home/fake"], uid: 4242, canonicalize: resolve },
    pid: 1234,
    timer,
    ids: new CountingIdGenerator("request"),
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
  const up = parsed([
    "up",
    "--dir",
    dir,
    "--config",
    "slots.json",
    "--env",
    "NOTE=a=b",
    "--init-timeout-ms",
    "900",
  ]);
  expect(up.env).toEqual({ NOTE: "a=b" });
  expect(up.config).toBe("slots.json");
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
posixTest("up validates config and new-dir refusal before spawning", async () => {
  const f = fixture();
  f.files.set("slots.json", '{"contractVersion":2}');
  expect(
    await runProxySessionCommand(parsed(["up", "--dir", dir, "--config", "slots.json"]), f.deps),
  ).toBe(2);
  expect(f.logs.join(" ")).toContain("contract_unsupported");
  expect(f.calls).toEqual([]);
  expect(f.writes).toEqual([]);
  f.files.set(join(dir, "closed.json"), "{}");
  expect(await runProxySessionCommand(parsed(["up", "--dir", dir]), f.deps)).toBe(2);
  expect(f.logs.join(" ")).toContain("NEW --dir");
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
