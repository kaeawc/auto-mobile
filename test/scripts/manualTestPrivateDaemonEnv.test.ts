import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DEFAULT_DAEMON_PORT } from "../../src/daemon/constants";
import {
  derivePrivateDaemonBatch,
  privateDaemonBatchRefusal,
  renderEnvFile,
  DERIVED_PATH_VARIABLES,
  type PrivateDaemonBatchOptions,
} from "../../scripts/manual-test/privateDaemonEnv";
import { privateHarnessEnvRefusal } from "../../scripts/manual-test/harnessEnv";
import { resolveAutoMobileBaseDir } from "../../src/utils/tempDir";

const posixTest = process.platform === "win32" ? test.skip : test;
const host = { homeDirs: [resolve("/home/fake"), resolve("/home/other-fake")], uid: 4242 };
const options: PrivateDaemonBatchOptions = {
  batchDir: resolve("/evidence/batch"),
  count: 2,
  basePort: 3160,
  auxRoot: resolve("/mt-aux"),
  serverPath: resolve("/built/index.js"),
};
function refusal(changes: Partial<PrivateDaemonBatchOptions>): string | undefined {
  const modified = { ...options, ...changes };
  return privateDaemonBatchRefusal(derivePrivateDaemonBatch(modified), modified, host);
}
test("derives two isolated daemons with one shared ADB registry", () => {
  const specs = derivePrivateDaemonBatch(options);
  expect(specs.map((spec) => spec.port)).toEqual([3160, 3161]);
  expect(specs.map((spec) => spec.name)).toEqual(["P1", "P2"]);
  expect(specs[0].dir).toBe(join(options.batchDir, "daemon1"));
  expect(specs[0].dir).not.toBe(specs[1].dir);
  expect(specs[0].auxSocketDir).not.toBe(specs[1].auxSocketDir);
  expect(specs[0].adbServerCoordinationDir).toBe(join(options.batchDir, "shared", "adb-servers"));
  expect(specs[0].adbServerCoordinationDir).toBe(specs[1].adbServerCoordinationDir);
  for (const spec of specs) {
    for (const key of DERIVED_PATH_VARIABLES.slice(0, 10)) {
      expect(spec.env[key]).toBeDefined();
    }
    expect(spec.env.AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS).toBe("0");
    expect(spec.env.AUTOMOBILE_APPEARANCE_SYNC).toBe("off");
    expect(spec.env.MT_SERVER).toBe(options.serverPath);
    expect(spec.env.MT_BATCH).toBe(options.batchDir);
    expect(spec.env.MT_DAEMON).toBe(spec.name);
    expect(spec.env.MT_PORT).toBe(String(spec.port));
  }
});
test("split mode deliberately separates ADB registries", () => {
  const specs = derivePrivateDaemonBatch({ ...options, splitAdbCoordination: true });
  expect(specs[0].adbServerCoordinationDir).toBe(join(specs[0].dir, "adb-servers"));
  expect(specs[0].adbServerCoordinationDir).not.toBe(specs[1].adbServerCoordinationDir);
});
posixTest("clean batch passes and default aux root is a short batch hash", () => {
  expect(refusal({})).toBeUndefined();
  const specs = derivePrivateDaemonBatch({ ...options, auxRoot: undefined });
  expect(specs[0].auxSocketDir).toMatch(/^\/tmp\/am-mt-[a-f0-9]{8}\/1$/);
  expect(specs[0].auxSocketDir).not.toBe(
    derivePrivateDaemonBatch({ ...options, auxRoot: undefined, batchDir: "/another" })[0]
      .auxSocketDir,
  );
});
test("refuses either fake home's default state and default aux root", () => {
  for (const home of host.homeDirs) {
    const base = resolveAutoMobileBaseDir({}, home, options.batchDir);
    expect(refusal({ batchDir: join(base, "batch") })).toContain("default product");
    expect(refusal({ auxRoot: base })).toContain("default product");
  }
});
test("refuses relative paths, invalid count/ports, resident port, and long socket paths", () => {
  for (const key of ["batchDir", "auxRoot", "serverPath"]) {
    expect(refusal({ [key]: "relative" })).toContain("absolute");
  }
  for (const count of [0, 9, 1.5]) {
    expect(refusal({ count })).toContain("count");
  }
  for (const basePort of [0, 65535, 1.5]) {
    expect(refusal({ basePort })).toContain("ports");
  }
  expect(refusal({ basePort: DEFAULT_DAEMON_PORT })).toContain("DEFAULT_DAEMON_PORT");
  expect(refusal({ auxRoot: resolve(`/${"long".repeat(30)}`) })).toContain("103 bytes");
  const specs = derivePrivateDaemonBatch(options);
  specs[1].port = specs[0].port;
  expect(privateDaemonBatchRefusal(specs, options, host)).toContain("distinct");
});
test("refuses protected env overrides and quotes shell values", () => {
  for (const key of [...DERIVED_PATH_VARIABLES, "AUTOMOBILE_MANAGED_SLOT_CONFIG"]) {
    expect(refusal({ extraEnv: { [key]: "/override" } })).toContain("may not override");
  }
  const modified = { ...options, extraEnv: { NOTE: "a space and 'quote'" } };
  const spec = derivePrivateDaemonBatch(modified)[0];
  expect(renderEnvFile(spec, modified)).toContain("export NOTE='a space and '\\''quote'\\'''\n");
  expect(renderEnvFile(spec, modified)).toContain("unset AUTOMOBILE_MANAGED_SLOT_CONFIG\n");
});
posixTest("private harness guard requires both private paths and server", () => {
  const env = derivePrivateDaemonBatch(options)[0].env;
  expect(privateHarnessEnvRefusal(env, host)).toBeUndefined();
  for (const key of ["AUTOMOBILE_AUX_SOCKET_DIR", "AUTOMOBILE_DAEMON_SOCKET_PATH", "MT_SERVER"]) {
    expect(privateHarnessEnvRefusal({ ...env, [key]: "" }, host)).toBeDefined();
  }
  expect(
    privateHarnessEnvRefusal({ ...env, AUTOMOBILE_AUX_SOCKET_DIR: "relative" }, host),
  ).toBeDefined();
  expect(
    privateHarnessEnvRefusal(
      { ...env, AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/auto-mobile-daemon-4242.sock" },
      host,
    ),
  ).toContain("resident");
  expect(
    privateHarnessEnvRefusal(
      {
        ...env,
        AUTOMOBILE_AUX_SOCKET_DIR: resolveAutoMobileBaseDir({}, host.homeDirs[0], options.batchDir),
      },
      host,
    ),
  ).toContain("default auxiliary");
});

posixTest("private harness guard rejects whitespace-wrapped default paths", () => {
  const env = derivePrivateDaemonBatch(options)[0].env;
  expect(
    privateHarnessEnvRefusal(
      { ...env, AUTOMOBILE_DAEMON_SOCKET_PATH: " /tmp/auto-mobile-daemon-4242.sock " },
      host,
    ),
  ).toContain("resident");
  expect(
    privateHarnessEnvRefusal(
      { ...env, AUTOMOBILE_AUX_SOCKET_DIR: " /home/fake/.auto-mobile " },
      host,
    ),
  ).toContain("default auxiliary");
});
