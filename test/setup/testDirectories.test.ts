import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedTestDirectoryEnv, testDirectoryRoot } from "./testDirectories";
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
