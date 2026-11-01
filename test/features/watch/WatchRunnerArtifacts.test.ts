import { expect, test } from "bun:test";
import path from "node:path";
import { WatchRunnerArtifacts } from "../../../src/features/watch/WatchRunnerArtifacts";
import { createExecResult } from "../../../src/utils/execResult";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";

function fixture() {
  let discovered: string | null = null;
  let afterBuild: string | null =
    "/derived/Build/Products/CtrlProxyWatch_watchsimulator26.0-arm64.xctestrun";
  let override: string | undefined;
  const commands: string[][] = [];
  const accesses: string[] = [];
  const platforms: string[] = [];
  const artifacts = new WatchRunnerArtifacts({
    builder: {
      getConfig: () => ({
        projectRoot: "/repo",
        derivedDataPath: "/derived",
      }),
      getXctestrunPath: async (platform) => {
        platforms.push(platform!);
        return discovered;
      },
    },
    xcodebuild: {
      executeCommand: async (args) => {
        commands.push(args);
        discovered = afterBuild;
        return createExecResult("BUILD SUCCEEDED", "");
      },
    },
    override: () => override,
    access: async (file) => {
      accesses.push(file);
    },
  });
  return {
    artifacts,
    commands,
    platforms,
    accesses,
    setDiscovered: (path: string) => {
      discovered = path;
    },
    setAfterBuild: (path: string | null) => {
      afterBuild = path;
    },
    setOverride: (path: string) => {
      override = path;
    },
  };
}

test("builds the watch scheme only when watchsimulator discovery is empty", async () => {
  const f = fixture();
  expect(await f.artifacts.resolve()).toContain("watchsimulator");
  expect(f.commands).toEqual([
    [
      "build-for-testing",
      "-project",
      path.join("/repo", "ios", "control-proxy", "CtrlProxy.xcodeproj"),
      "-scheme",
      "CtrlProxyWatch",
      "-destination",
      "generic/platform=watchOS Simulator",
      "-derivedDataPath",
      "/derived",
      "CODE_SIGNING_ALLOWED=NO",
    ],
  ]);
  await f.artifacts.resolve();
  expect(f.commands).toHaveLength(1);
  expect(f.platforms.every((value) => value === "watchSimulator")).toBe(true);
});

test("uses an explicit accessible xctestrun override without building", async () => {
  const f = fixture();
  f.setOverride("/prebuilt/Watch.xctestrun");
  expect(await f.artifacts.resolve()).toBe("/prebuilt/Watch.xctestrun");
  expect(f.accesses).toEqual(["/prebuilt/Watch.xctestrun"]);
  expect(f.commands).toEqual([]);
});

test("reports missing watch artifacts after a build", async () => {
  const f = fixture();
  f.setAfterBuild(null);
  await expect(f.artifacts.resolve()).rejects.toThrow("watchsimulator");
});

test("resolves a relative override against the daemon launch directory", async () => {
  const previousLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
  process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/launch");
  try {
    const f = fixture();
    f.setOverride("prebuilt/Watch.xctestrun");
    expect(await f.artifacts.resolve()).toBe(path.resolve("/launch", "prebuilt/Watch.xctestrun"));
    expect(f.accesses).toEqual([path.resolve("/launch", "prebuilt/Watch.xctestrun")]);
    expect(f.commands).toEqual([]);
  } finally {
    if (previousLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = previousLaunchCwd;
    }
  }
});
