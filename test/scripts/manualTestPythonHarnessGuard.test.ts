import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolve } from "node:path";
import {
  runHarnessGuard,
  type HarnessGuardDeps,
} from "../../scripts/manual-test/python/harness-guard";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";

function fixture() {
  const env = derivePrivateDaemonBatch({
    batchDir: "/batch",
    count: 1,
    basePort: 3160,
    auxRoot: "/mt-aux",
    serverPath: "/built/index.js",
  })[0].env;
  const probes: string[] = [];
  let pidText = '{"pid":9876}';
  const deps: HarnessGuardDeps = {
    env,
    host: { homeDirs: ["/home/fake"], uid: 4242, canonicalize: resolve },
    runtimePath: "/bin/bun",
    readFile: () => pidText,
    isPidAlive: () => true,
    probeDaemonSocket: async (path) => {
      probes.push(path);
      return { alive: true };
    },
  };
  return {
    deps,
    probes,
    setPid: (value: string) => {
      pidText = value;
    },
  };
}
const input = JSON.stringify({ calls: [], allowSelector: false });
test.each([
  "AUTOMOBILE_SESSION_BROKER_CONFIG",
  "AUTOMOBILE_SESSION_CONFIG",
  "AUTOMOBILE_MANAGED_SLOT_CONFIG",
  "AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES",
])("resolve scrubs inherited harness-owned %s", async (key) => {
  const { deps } = fixture();
  deps.env[key] = "/inherited/config";
  const result = await runHarnessGuard("resolve", input, deps);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.message);
  }
  expect(JSON.parse(result.stdout).env).not.toHaveProperty(key);
});
test("resolve emits only the server entry point and sanitized env", async () => {
  const { deps, probes } = fixture();
  const result = await runHarnessGuard("resolve", input, deps);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.message);
  }
  const value = JSON.parse(result.stdout);
  expect([deps.env.AUTOMOBILE_DAEMON_SOCKET_PATH]).toEqual(probes);
  expect(value.command).toBe("/bin/bun");
  expect(value.args).toEqual(["/built/index.js"]);
  expect(value.env).toEqual(deps.env);
  expect(Object.keys(value.env).some((key) => key.startsWith("AUTO_MOBILE_"))).toBe(false);
  expect(value.daemon).toEqual({
    name: "P1",
    port: "3160",
    socketPath: deps.env.AUTOMOBILE_DAEMON_SOCKET_PATH,
    pidFilePath: deps.env.AUTOMOBILE_DAEMON_PID_FILE_PATH,
  });
});
test("namespace omissions, resident basename and inherited DB override fail closed", async () => {
  for (const change of [
    { AUTOMOBILE_LOG_DIR: undefined },
    { AUTOMOBILE_DAEMON_SOCKET_PATH: "/private/auto-mobile-daemon-4242.sock" },
    { AUTOMOBILE_DB_PATH: "/inherited/db" },
    { MT_PORT: undefined },
  ]) {
    const { deps, probes } = fixture();
    deps.env = { ...deps.env, ...change };
    expect((await runHarnessGuard("resolve", input, deps)).ok).toBe(false);
    expect(probes).toEqual([]);
  }
});
test("missing, malformed, unsafe, and dead daemon pid files refuse before proxy spawn", async () => {
  for (const text of ["no JSON", "{}", '{"pid":0}', '{"pid":1.5}', '{"pid":9007199254740992}']) {
    const { deps, setPid, probes } = fixture();
    setPid(text);
    const result = await runHarnessGuard("resolve", input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Run private-daemon.ts start first");
    }
    expect(probes).toEqual([]);
  }
  const { deps, probes } = fixture();
  deps.readFile = () => {
    throw new Error("Missing fake pid file");
  };
  expect((await runHarnessGuard("resolve", input, deps)).ok).toBe(false);
  expect(probes).toEqual([]);
  deps.readFile = () => '{"pid":9876}';
  deps.isPidAlive = () => false;
  expect((await runHarnessGuard("resolve", input, deps)).ok).toBe(false);
  expect(probes).toEqual([]);
});
test("device start guard is prefixed and selector acceptance is deliberate", async () => {
  const { deps } = fixture();
  const calls = [{ tool: "startDevice", arguments: { platform: "android" } }];
  const refused = await runHarnessGuard(
    "resolve",
    JSON.stringify({ calls, allowSelector: false }),
    deps,
  );
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.message).toStartWith("calls[0]: ");
  }
  expect(
    (await runHarnessGuard("resolve", JSON.stringify({ calls, allowSelector: true }), deps)).ok,
  ).toBe(true);
  expect(
    (
      await runHarnessGuard(
        "resolve",
        JSON.stringify({
          calls: [{ tool: "startDevice", arguments: { deviceId: "serial" } }],
          allowSelector: false,
        }),
        deps,
      )
    ).ok,
  ).toBe(true);
});
test("check-calls needs no environment, file reads, pid or socket probes", async () => {
  const { deps } = fixture();
  deps.env = {};
  deps.probeDaemonSocket = async () => {
    throw new Error("Must not probe socket");
  };
  deps.readFile = () => {
    throw new Error("Must not read");
  };
  deps.isPidAlive = () => {
    throw new Error("Must not probe");
  };
  expect(await runHarnessGuard("check-calls", input, deps)).toEqual({
    ok: true,
    stdout: '{"ok":true}',
  });
  expect(
    (
      await runHarnessGuard(
        "check-calls",
        JSON.stringify({ calls: [{ tool: "getAndroid", arguments: {} }], allowSelector: false }),
        deps,
      )
    ).ok,
  ).toBe(false);
});
test("malformed input and unknown command return typed refusals", async () => {
  const { deps } = fixture();
  for (const text of [
    "no JSON",
    "[]",
    "{}",
    '{"calls":[],"allowSelector":true,"unknown":1}',
    '{"calls":[{"tool":2}],"allowSelector":false}',
  ]) {
    expect((await runHarnessGuard("resolve", text, deps)).ok).toBe(false);
  }
  expect((await runHarnessGuard("unknown", input, deps)).ok).toBe(false);
});

test("invalid stdin is distinguished from daemon-file and unexpected failures", async () => {
  const { deps } = fixture();
  for (const text of ["no JSON", "[]", "{}"]) {
    const result = await runHarnessGuard("resolve", text, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toStartWith("Invalid guard input: ");
    }
  }
  deps.readFile = () => {
    throw new Error("secret file failure");
  };
  expect(await runHarnessGuard("resolve", input, deps)).toEqual({
    ok: false,
    message:
      "Run private-daemon.ts start first; a Python stdio client must not wake a dead daemon.",
  });
  deps.readFile = () => '{"pid":123}';
  deps.isPidAlive = () => {
    throw new Error("injected probe failure");
  };
  expect(await runHarnessGuard("resolve", input, deps)).toEqual({
    ok: false,
    message: "Guard failed: injected probe failure",
  });
});

test("resolve rejects malformed, out-of-range and resident default ports", async () => {
  for (const port of ["3000", "0", "65536", "3.5", "1e3", "-4", " 3160", "3160junk"]) {
    const { deps } = fixture();
    deps.env.MT_PORT = port;
    const result = await runHarnessGuard("resolve", input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("3000");
    }
  }
});

let firstImport: string | undefined;
beforeAll(() => {
  const ast = ts.createSourceFile(
    "harness-guard.ts",
    readFileSync(
      resolve(import.meta.dir, "../../scripts/manual-test/python/harness-guard.ts"),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const node = ast.statements.find(ts.isImportDeclaration);
  firstImport =
    node && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
});
test("the guard imports the isolated log sink before product modules", () => {
  expect(firstImport).toBe("../harnessLogSink");
});
test("resolve requires the exact private control socket to answer before checking calls", async () => {
  const { deps, probes } = fixture();
  deps.probeDaemonSocket = async (path) => {
    probes.push(path);
    return { alive: false, reason: "Injected socket refusal" };
  };
  const result = await runHarnessGuard(
    "resolve",
    JSON.stringify({
      calls: [{ tool: "startDevice", arguments: { platform: "android" } }],
      allowSelector: false,
    }),
    deps,
  );
  expect(result).toEqual({
    ok: false,
    message:
      "Run private-daemon.ts start first; a Python stdio client must not wake a dead daemon. Injected socket refusal",
  });
  expect([deps.env.AUTOMOBILE_DAEMON_SOCKET_PATH]).toEqual(probes);
});
test("resolve supplies the default reason when the socket probe has none", async () => {
  const { deps } = fixture();
  deps.probeDaemonSocket = async () => ({ alive: false });
  expect(await runHarnessGuard("resolve", input, deps)).toEqual({
    ok: false,
    message:
      "Run private-daemon.ts start first; a Python stdio client must not wake a dead daemon. Control socket did not answer.",
  });
});

test("a rejected socket probe becomes a typed guard refusal", async () => {
  const { deps } = fixture();
  deps.probeDaemonSocket = async () => {
    throw new Error("injected socket failure");
  };
  expect(await runHarnessGuard("resolve", input, deps)).toEqual({
    ok: false,
    message: "Guard failed: injected socket failure",
  });
});
