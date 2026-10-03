import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import {
  bootstrapEnvironment,
  defaultDirectoryExists,
  type EnvBootstrapDeps,
} from "../../src/utils/envBootstrap";

const home = path.join(path.sep, "home", "u");
const localAppData = path.join(home, "AppData", "Local");
const systemDirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/usr/local/sbin"];
const homebrewDirs = ["/opt/homebrew/bin", "/opt/homebrew/sbin"];
const darwinSdk = path.join(home, "Library/Android/sdk");
const linuxSdk = path.join(home, "Android/Sdk");
const windowsSdk = path.join(localAppData, "Android", "Sdk");

function sdkTools(sdk: string): string[] {
  return [
    path.join(sdk, "platform-tools"),
    path.join(sdk, "emulator"),
    path.join(sdk, "cmdline-tools", "latest", "bin"),
  ];
}

function fakeDeps(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
  directories: readonly string[] = [],
): EnvBootstrapDeps & { probes: string[] } {
  const existing = new Set(directories);
  const probes: string[] = [];
  return {
    env,
    platform,
    homedir: () => home,
    directoryExists: (candidate) => {
      probes.push(candidate);
      return existing.has(candidate);
    },
    probes,
  };
}

describe("bootstrapEnvironment", () => {
  test("darwin appends system, homebrew, then SDK tools in candidate order", () => {
    const candidates = [...systemDirs, ...homebrewDirs, ...sdkTools(darwinSdk)];
    const env = { PATH: "original" };
    const deps = fakeDeps("darwin", env, candidates);
    bootstrapEnvironment(deps);
    expect(deps.probes).toEqual([...candidates, darwinSdk]);
    expect(env.PATH).toBe(["original", ...candidates].join(path.delimiter));
  });

  test("darwin appends only existing directories without reordering them", () => {
    const additions = ["/bin", "/opt/homebrew/sbin", ...sdkTools(darwinSdk).slice(1)];
    const env = { PATH: "original" };
    bootstrapEnvironment(fakeDeps("darwin", env, additions.toReversed()));
    expect(env.PATH).toBe(["original", ...additions].join(path.delimiter));
  });

  test("linux probes system and SDK tools without homebrew entries", () => {
    const candidates = [...systemDirs, ...sdkTools(linuxSdk)];
    const env = { PATH: "original" };
    const deps = fakeDeps("linux", env, [...candidates, ...homebrewDirs]);
    bootstrapEnvironment(deps);
    expect(deps.probes).toEqual([...candidates, linuxSdk]);
    expect(env.PATH).toBe(["original", ...candidates].join(path.delimiter));
  });

  test("win32 appends only LOCALAPPDATA SDK tools", () => {
    const candidates = sdkTools(windowsSdk);
    const env = { PATH: "original", LOCALAPPDATA: localAppData };
    const deps = fakeDeps("win32", env, [...candidates, ...systemDirs, ...homebrewDirs]);
    bootstrapEnvironment(deps);
    expect(deps.probes).toEqual([...candidates, windowsSdk]);
    expect(env.PATH).toBe(["original", ...candidates].join(path.delimiter));
  });

  for (const local of [undefined, ""]) {
    test(`win32 leaves PATH and ANDROID_HOME alone with LOCALAPPDATA ${String(local)}`, () => {
      const env: NodeJS.ProcessEnv = { PATH: "original", LOCALAPPDATA: local };
      const deps = fakeDeps("win32", env, [...sdkTools(windowsSdk), windowsSdk]);
      bootstrapEnvironment(deps);
      expect(env.PATH).toBe("original");
      expect(env.ANDROID_HOME).toBeUndefined();
      expect(deps.probes).toEqual([]);
    });
  }

  for (const platform of ["freebsd", "aix"] as const) {
    test(`${platform} leaves PATH and ANDROID_HOME alone`, () => {
      const env: NodeJS.ProcessEnv = { PATH: "original" };
      const deps = fakeDeps(platform, env, [...systemDirs, darwinSdk, linuxSdk]);
      bootstrapEnvironment(deps);
      expect(env.PATH).toBe("original");
      expect(env.ANDROID_HOME).toBeUndefined();
      expect(deps.probes).toEqual([]);
    });
  }

  for (const initialPath of [undefined, ""]) {
    test(`PATH ${String(initialPath)} has no leading delimiter after additions`, () => {
      const env: NodeJS.ProcessEnv = { PATH: initialPath };
      bootstrapEnvironment(fakeDeps("linux", env, systemDirs));
      expect(env.PATH).toBe(systemDirs.join(path.delimiter));
    });

    test(`PATH ${String(initialPath)} stays unchanged when no directory exists`, () => {
      const env: NodeJS.ProcessEnv = { PATH: initialPath };
      bootstrapEnvironment(fakeDeps("linux", env));
      expect(env.PATH).toBe(initialPath);
    });
  }

  test("preserves the exact PATH prefix including empty and duplicate segments", () => {
    const prefix = ["", "custom path", "/bin", "", "/bin", ""].join(path.delimiter);
    const env = { PATH: prefix };
    const deps = fakeDeps("linux", env, ["/bin", "/usr/bin"]);
    bootstrapEnvironment(deps);
    expect(env.PATH).toBe(`${prefix}${path.delimiter}/usr/bin`);
    expect(deps.probes).not.toContain("/bin");
  });

  test("does not add duplicate candidates and repeat calls are idempotent", () => {
    const candidates = [...systemDirs, ...homebrewDirs, ...sdkTools(darwinSdk)];
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    const deps = fakeDeps("darwin", env, [...candidates, darwinSdk]);
    bootstrapEnvironment(deps);
    const firstPath = env.PATH;
    expect(firstPath).toBe(
      ["/bin", ...candidates.filter((p) => p !== "/bin")].join(path.delimiter),
    );
    expect(new Set(firstPath?.split(path.delimiter)).size).toBe(candidates.length);
    expect(deps.probes).toEqual([...candidates.filter((p) => p !== "/bin"), darwinSdk]);
    deps.probes.length = 0;
    bootstrapEnvironment(deps);
    expect(env.PATH).toBe(firstPath);
    expect(env.ANDROID_HOME).toBe(darwinSdk);
    expect(deps.probes).toEqual([]);
  });

  test("leaves an already complete PATH string unchanged", () => {
    const original = [...systemDirs, ...sdkTools(linuxSdk), ""].join(path.delimiter);
    const env = { PATH: original };
    bootstrapEnvironment(fakeDeps("linux", env, [...systemDirs, ...sdkTools(linuxSdk)]));
    expect(env.PATH).toBe(original);
  });

  const sdkCases: readonly [NodeJS.Platform, string, NodeJS.ProcessEnv][] = [
    ["darwin", darwinSdk, {}],
    ["linux", linuxSdk, {}],
    ["win32", windowsSdk, { LOCALAPPDATA: localAppData }],
  ];
  for (const [platform, sdk, baseEnv] of sdkCases) {
    test(`${platform} sets unset ANDROID_HOME when the SDK directory exists`, () => {
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      bootstrapEnvironment(fakeDeps(platform, env, [sdk]));
      expect(env.ANDROID_HOME).toBe(sdk);
      expect(env.PATH).toBeUndefined();
    });

    test(`${platform} leaves ANDROID_HOME unset when the SDK directory is missing`, () => {
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      bootstrapEnvironment(fakeDeps(platform, env, sdkTools(sdk)));
      expect(env.ANDROID_HOME).toBeUndefined();
    });
  }

  test("does not overwrite an existing ANDROID_HOME or probe its replacement", () => {
    const env = { ANDROID_HOME: "custom-sdk" };
    const deps = fakeDeps("linux", env, [linuxSdk]);
    bootstrapEnvironment(deps);
    expect(env.ANDROID_HOME).toBe("custom-sdk");
    expect(deps.probes).not.toContain(linuxSdk);
  });

  test("ANDROID_SDK_ROOT prevents setting an unset ANDROID_HOME", () => {
    const env: NodeJS.ProcessEnv = { ANDROID_SDK_ROOT: "custom-sdk" };
    const deps = fakeDeps("linux", env, [linuxSdk]);
    bootstrapEnvironment(deps);
    expect(env.ANDROID_HOME).toBeUndefined();
    expect(env.ANDROID_SDK_ROOT).toBe("custom-sdk");
    expect(deps.probes).not.toContain(linuxSdk);
  });

  test("empty ANDROID_HOME is treated as unset", () => {
    const env = { ANDROID_HOME: "" };
    bootstrapEnvironment(fakeDeps("linux", env, [linuxSdk]));
    expect(env.ANDROID_HOME).toBe(linuxSdk);
  });

  test("empty ANDROID_SDK_ROOT allows setting ANDROID_HOME", () => {
    const env: NodeJS.ProcessEnv = { ANDROID_SDK_ROOT: "" };
    bootstrapEnvironment(fakeDeps("linux", env, [linuxSdk]));
    expect(env.ANDROID_HOME).toBe(linuxSdk);
    expect(env.ANDROID_SDK_ROOT).toBe("");
  });

  test("retains the no-argument call signature without invoking real defaults", () => {
    const noArgumentBootstrap: () => void = bootstrapEnvironment;
    expect(typeof noArgumentBootstrap).toBe("function");
  });
});

describe("defaultDirectoryExists", () => {
  let directory: string;
  let file: string;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "automobile-env-bootstrap-"));
    file = path.join(directory, "file.txt");
    writeFileSync(file, "fixture");
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("returns true for an existing directory", () => {
    expect(defaultDirectoryExists(directory)).toBe(true);
  });

  test("returns false for an existing file", () => {
    expect(defaultDirectoryExists(file)).toBe(false);
  });

  test("returns false for a missing path", () => {
    expect(defaultDirectoryExists(path.join(directory, "missing"))).toBe(false);
  });
});
