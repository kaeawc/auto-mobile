import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DB_PATH_OVERRIDE_ENV_KEYS,
  isolatedTestDirectoryEnv,
  testDirectoryRoot,
  withoutInheritedDatabaseOverrides,
} from "./testDirectories";
import { DB_PATH_OVERRIDE_ENV_KEYS as guardDbOverrideKeys } from "../../src/db/database";
import { useScratchRoot } from "../helpers/scratchRoot";
import {
  assertUnitTestLogsDirIsolated,
  getAdbServerScopedAutoMobileDir,
  getSharedAutoMobileDir,
  resolveAutoMobileBaseDir,
  resolveAutoMobileLogsDir,
} from "../../src/utils/tempDir";

const root = path.resolve("/injected-temp/am-test-example");
const directories = [
  ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR", "data"],
  ["AUTOMOBILE_LOG_DIR", "AUTO_MOBILE_LOG_DIR", "logs"],
  ["AUTOMOBILE_COORDINATION_DIR", "AUTO_MOBILE_COORDINATION_DIR", "coord"],
  [
    "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR",
    "AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR",
    "adb-servers",
  ],
] as const;

test("unset directory overrides get independent temp children without mutating input", () => {
  const env = { NODE_ENV: "test" };
  const result = isolatedTestDirectoryEnv(env, root);
  for (const [primary, , child] of directories) {
    expect(result[primary]).toBe(path.join(root, child));
  }
  expect(env).toEqual({ NODE_ENV: "test" });
});

test.each(directories)(
  "%s preserves explicit values and independently fills its neighbours",
  (primary, twin) => {
    const env = { [primary]: " /explicit/value ", [twin]: "/legacy/value" };
    const result = isolatedTestDirectoryEnv(env, root);
    expect(result[primary]).toBe(env[primary]);
    expect(result[twin]).toBe(env[twin]);
    for (const [other, , child] of directories) {
      if (other !== primary) {
        expect(result[other]).toBe(path.join(root, child));
      }
    }
  },
);

test.each(directories)("%s treats both blank values as unset", (primary, twin, child) => {
  expect(isolatedTestDirectoryEnv({ [primary]: "  ", [twin]: "" }, root)[primary]).toBe(
    path.join(root, child),
  );
});

test.each(directories)("%s respects an explicit %s, even with a blank primary", (primary, twin) => {
  for (const blank of [undefined, "", "  "]) {
    const result = isolatedTestDirectoryEnv({ [primary]: blank, [twin]: "/legacy/value" }, root);
    expect(result[primary]).toBeUndefined();
    expect(result[twin]).toBe("/legacy/value");
  }
});

test("preload isolates data, logs, coordination and adb-server claims before production imports", () => {
  const realDefault = path.join(os.userInfo().homedir, ".auto-mobile");
  for (const directory of [
    resolveAutoMobileBaseDir(),
    resolveAutoMobileLogsDir(),
    getSharedAutoMobileDir("x"),
    getAdbServerScopedAutoMobileDir("tcp-localhost-5037", "x"),
  ]) {
    const relative = path.relative(realDefault, directory);
    expect(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))).toBe(
      false,
    );
  }
  expect(() => assertUnitTestLogsDirIsolated()).not.toThrow();
  for (const child of ["data", "logs", "coord", "adb-servers"]) {
    expect(existsSync(path.join(testDirectoryRoot, child))).toBe(true);
  }
});

test("directory isolation is the first preload dependency", () => {
  const source = readFileSync(new URL("./testPreload.ts", import.meta.url), "utf8");
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source);
  expect(imports[0]?.path).toBe("./testDirectories");
});

const inheritedDbEnv = Object.fromEntries(
  DB_PATH_OVERRIDE_ENV_KEYS.map((key, index) => [key, `inherited-db-${index}`]),
);

test.each(["/repo/test/daemon/x.test.ts", "C:\\repo\\test\\daemon\\x.test.ts"])(
  "%s discards inherited DB overrides without mutating input",
  (entrypoint) => {
    const env = { ...inheritedDbEnv, NODE_ENV: "test", OTHER: "kept" };
    const result = withoutInheritedDatabaseOverrides(env, entrypoint);
    expect(result).toEqual({ NODE_ENV: "test", OTHER: "kept" });
    expect(env).toEqual({ ...inheritedDbEnv, NODE_ENV: "test", OTHER: "kept" });
    expect(result).not.toBe(env);
  },
);

test.each(["/repo/test/daemon/x.integration.test.ts", "/repo/test/stress/x.test.ts"])(
  "%s preserves inherited DB overrides",
  (entrypoint) => {
    const env = { ...inheritedDbEnv, OTHER: "kept" };
    const result = withoutInheritedDatabaseOverrides(env, entrypoint);
    expect(result).toEqual(env);
    expect(env).toEqual({ ...inheritedDbEnv, OTHER: "kept" });
    expect(result).not.toBe(env);
  },
);

test("preload DB override keys match the production guard", () => {
  expect([...DB_PATH_OVERRIDE_ENV_KEYS].sort()).toEqual([...guardDbOverrideKeys].sort());
});

describe("inherited DB overrides through the real preload", () => {
  const scratch = useScratchRoot("db-override-preload-");
  let exitCode: number;
  let stderr: string;
  let unitEnv: NodeJS.ProcessEnv;
  let integrationEnv: NodeJS.ProcessEnv;

  // One child launch per file, outside the test timing budget. --isolate reruns
  // the preload against the inherited env for each filename, including integration.
  beforeAll(() => {
    const dir = scratch.next();
    const probes = ["probe.test.ts", "probe.integration.test.ts"].map((name) =>
      path.join(dir, name),
    );
    for (const probe of probes) {
      writeFileSync(
        probe,
        `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(`${probe}.json`)}, JSON.stringify(Object.fromEntries(${JSON.stringify(DB_PATH_OVERRIDE_ENV_KEYS)}.map(key => [key, process.env[key]]))));\ntest("fixture", () => {});\n`,
      );
    }
    writeFileSync(path.join(dir, "bunfig.toml"), "[test]\n");
    const env: NodeJS.ProcessEnv = { ...process.env, ...inheritedDbEnv };
    delete env.BUN_OPTIONS;
    delete env.AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE;
    delete env.AUTOMOBILE_SPAWN_GUARD_ALLOWLIST;
    const child = Bun.spawnSync(
      [
        process.execPath,
        "test",
        "--isolate",
        "--preload",
        fileURLToPath(new URL("./testDirectories.ts", import.meta.url)),
        ...probes,
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    exitCode = child.exitCode;
    stderr = child.stderr.toString();
    unitEnv = JSON.parse(readFileSync(`${probes[0]}.json`, "utf8"));
    integrationEnv = JSON.parse(readFileSync(`${probes[1]}.json`, "utf8"));
  });

  test("child unit and integration probes pass", () => {
    expect(exitCode, stderr).toBe(0);
  });

  test("unit probe has none of the inherited DB overrides", () => {
    expect(unitEnv).toEqual({});
  });

  test("integration probe retains all inherited DB overrides", () => {
    expect(integrationEnv).toEqual(inheritedDbEnv);
  });
});
