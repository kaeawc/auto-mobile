import { expect, test } from "bun:test";
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
  let pidText = '{"pid":9876}';
  const deps: HarnessGuardDeps = {
    env,
    host: { homeDirs: ["/home/fake"], uid: 4242, canonicalize: resolve },
    runtimePath: "/bin/bun",
    readFile: () => pidText,
    isPidAlive: () => true,
  };
  return {
    deps,
    setPid: (value: string) => {
      pidText = value;
    },
  };
}
const input = JSON.stringify({ calls: [], allowSelector: false });
test("resolve emits only the server entry point and sanitized env", () => {
  const { deps } = fixture();
  const result = runHarnessGuard("resolve", input, deps);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.message);
  }
  const value = JSON.parse(result.stdout);
  expect(value.command).toBe("/bin/bun");
  expect(value.args).toEqual(["/built/index.js"]);
  expect(Object.keys(value.env).some((key) => key.startsWith("AUTO_MOBILE_"))).toBe(false);
  expect(value.daemon).toEqual({
    name: "P1",
    port: "3160",
    socketPath: deps.env.AUTOMOBILE_DAEMON_SOCKET_PATH,
    pidFilePath: deps.env.AUTOMOBILE_DAEMON_PID_FILE_PATH,
  });
});
test("namespace omissions, resident basename and inherited DB override fail closed", () => {
  for (const change of [
    { AUTOMOBILE_LOG_DIR: undefined },
    { AUTOMOBILE_DAEMON_SOCKET_PATH: "/private/auto-mobile-daemon-4242.sock" },
    { AUTOMOBILE_DB_PATH: "/inherited/db" },
    { MT_PORT: undefined },
  ]) {
    const { deps } = fixture();
    deps.env = { ...deps.env, ...change };
    expect(runHarnessGuard("resolve", input, deps).ok).toBe(false);
  }
});
test("missing, malformed, unsafe, and dead daemon pid files refuse before proxy spawn", () => {
  for (const text of ["no JSON", "{}", '{"pid":0}', '{"pid":1.5}', '{"pid":9007199254740992}']) {
    const { deps, setPid } = fixture();
    setPid(text);
    const result = runHarnessGuard("resolve", input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Run private-daemon.ts start first");
    }
  }
  const { deps } = fixture();
  deps.readFile = () => {
    throw new Error("Missing fake pid file");
  };
  expect(runHarnessGuard("resolve", input, deps).ok).toBe(false);
  deps.readFile = () => '{"pid":9876}';
  deps.isPidAlive = () => false;
  expect(runHarnessGuard("resolve", input, deps).ok).toBe(false);
});
test("device start guard is prefixed and selector acceptance is deliberate", () => {
  const { deps } = fixture();
  const calls = [{ tool: "startDevice", arguments: { platform: "android" } }];
  const refused = runHarnessGuard("resolve", JSON.stringify({ calls, allowSelector: false }), deps);
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.message).toStartWith("calls[0]: ");
  }
  expect(runHarnessGuard("resolve", JSON.stringify({ calls, allowSelector: true }), deps).ok).toBe(
    true,
  );
  expect(
    runHarnessGuard(
      "resolve",
      JSON.stringify({
        calls: [{ tool: "startDevice", arguments: { deviceId: "serial" } }],
        allowSelector: false,
      }),
      deps,
    ).ok,
  ).toBe(true);
});
test("check-calls needs no environment, file reads, or pid probes", () => {
  const { deps } = fixture();
  deps.env = {};
  deps.readFile = () => {
    throw new Error("Must not read");
  };
  deps.isPidAlive = () => {
    throw new Error("Must not probe");
  };
  expect(runHarnessGuard("check-calls", input, deps)).toEqual({ ok: true, stdout: '{"ok":true}' });
  expect(
    runHarnessGuard(
      "check-calls",
      JSON.stringify({ calls: [{ tool: "getAndroid", arguments: {} }], allowSelector: false }),
      deps,
    ).ok,
  ).toBe(false);
});
test("malformed input and unknown command return typed refusals", () => {
  const { deps } = fixture();
  for (const text of [
    "no JSON",
    "[]",
    "{}",
    '{"calls":[],"allowSelector":true,"unknown":1}',
    '{"calls":[{"tool":2}],"allowSelector":false}',
  ]) {
    expect(runHarnessGuard("resolve", text, deps).ok).toBe(false);
  }
  expect(runHarnessGuard("unknown", input, deps).ok).toBe(false);
});

test("invalid stdin is distinguished from daemon-file and unexpected failures", () => {
  const { deps } = fixture();
  for (const text of ["no JSON", "[]", "{}"]) {
    const result = runHarnessGuard("resolve", text, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toStartWith("Invalid guard input: ");
    }
  }
  deps.readFile = () => {
    throw new Error("secret file failure");
  };
  expect(runHarnessGuard("resolve", input, deps)).toEqual({
    ok: false,
    message:
      "Run private-daemon.ts start first; a Python stdio client must not wake a dead daemon.",
  });
  deps.readFile = () => '{"pid":123}';
  deps.isPidAlive = () => {
    throw new Error("injected probe failure");
  };
  expect(runHarnessGuard("resolve", input, deps)).toEqual({
    ok: false,
    message: "Guard failed: injected probe failure",
  });
});

test("resolve rejects malformed, out-of-range and resident default ports", () => {
  for (const port of ["3000", "0", "65536", "3.5", "1e3", "-4", " 3160", "3160junk"]) {
    const { deps } = fixture();
    deps.env.MT_PORT = port;
    const result = runHarnessGuard("resolve", input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("3000");
    }
  }
});
