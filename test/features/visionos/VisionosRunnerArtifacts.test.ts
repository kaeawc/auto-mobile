import { expect, test } from "bun:test";
import path from "node:path";
import { Mutex } from "async-mutex";
import { VisionosRunnerArtifacts } from "../../../src/features/visionos/VisionosRunnerArtifacts";
import { createVisionosArtifactBuilder } from "../../../src/features/visionos/VisionosRunnerLifecycle";
import { createExecResult } from "../../../src/utils/execResult";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";

function fixture({ missingProject = false, projectRoot = "/repo" } = {}) {
  const schemes: Array<string | undefined> = [];
  let discovered: string | null = null;
  let afterBuild: string | null =
    "/derived/Build/Products/AutoMobileVisionTest_xrsimulator26.0-arm64.xctestrun";
  let override: string | undefined;
  const commands: string[][] = [];
  const accesses: string[] = [];
  const platforms: string[] = [];
  const artifacts = new VisionosRunnerArtifacts({
    builder: {
      getConfig: () => ({
        projectRoot,
        derivedDataPath: "/derived",
      }),
      getXctestrunPath: async (platform, options) => {
        platforms.push(platform!);
        schemes.push(options?.scheme);
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
      if (missingProject) {
        throw new Error("ENOENT");
      }
    },
  });
  return {
    artifacts,
    commands,
    platforms,
    schemes,
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

test("builds the visionos scheme only when xrsimulator discovery is empty", async () => {
  const f = fixture();
  expect(await f.artifacts.resolve()).toContain("xrsimulator");
  expect(f.commands).toEqual([
    [
      "build-for-testing",
      "-project",
      path.join("/repo", "ios", "control-proxy", "CtrlProxy.xcodeproj"),
      "-scheme",
      "AutoMobileVisionTest",
      "-destination",
      "generic/platform=visionOS Simulator",
      "-derivedDataPath",
      "/derived",
      "CODE_SIGNING_ALLOWED=NO",
    ],
  ]);
  await f.artifacts.resolve();
  expect(f.commands).toHaveLength(1);
  expect(f.platforms.every((value) => value === "visionSimulator")).toBe(true);
});

test("only reuses and accepts xctestrun plans of the visionos scheme", async () => {
  const f = fixture();
  await f.artifacts.resolve();
  expect(f.schemes).toEqual(["AutoMobileVisionTest", "AutoMobileVisionTest"]);
});

test("production builder adapter forwards the visionos scheme to the registered builder", async () => {
  const calls: Array<{ platform: string | undefined; scheme: string | undefined }> = [];
  const artifacts = new VisionosRunnerArtifacts({
    builder: createVisionosArtifactBuilder(() => ({
      getConfig: () => ({ projectRoot: "/repo", derivedDataPath: "/derived" }),
      getXctestrunPath: async (platform, options) => {
        calls.push({ platform, scheme: options?.scheme });
        return options?.scheme === "AutoMobileVisionTest"
          ? "/derived/Build/Products/AutoMobileVisionTest_xrsimulator26.0-arm64.xctestrun"
          : "/derived/Build/Products/OtherScheme_xrsimulator26.0-arm64.xctestrun";
      },
    })),
    override: () => undefined,
  });
  expect(await artifacts.resolve()).toContain("AutoMobileVisionTest_xrsimulator");
  expect(calls).toEqual([{ platform: "visionSimulator", scheme: "AutoMobileVisionTest" }]);
});

test("resolves a relative project root against the daemon launch directory", async () => {
  const previousLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
  process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/launch");
  try {
    const f = fixture({ projectRoot: "checkout" });
    await f.artifacts.resolve();
    expect(f.accesses).toEqual([
      path.join(path.resolve("/launch", "checkout"), "ios", "control-proxy", "CtrlProxy.xcodeproj"),
    ]);
  } finally {
    if (previousLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = previousLaunchCwd;
    }
  }
});

test("uses an explicit accessible xctestrun override without building", async () => {
  const f = fixture();
  f.setOverride("/prebuilt/Visionos.xctestrun");
  expect(await f.artifacts.resolve()).toBe("/prebuilt/Visionos.xctestrun");
  expect(f.accesses).toEqual(["/prebuilt/Visionos.xctestrun"]);
  expect(f.commands).toEqual([]);
});

test("reports missing visionos artifacts after a build", async () => {
  const f = fixture();
  f.setAfterBuild(null);
  await expect(f.artifacts.resolve()).rejects.toThrow("xrsimulator");
});

test("resolves a relative override against the daemon launch directory", async () => {
  const previousLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
  process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/launch");
  try {
    const f = fixture();
    f.setOverride("prebuilt/Visionos.xctestrun");
    expect(await f.artifacts.resolve()).toBe(
      path.resolve("/launch", "prebuilt/Visionos.xctestrun"),
    );
    expect(f.accesses).toEqual([path.resolve("/launch", "prebuilt/Visionos.xctestrun")]);
    expect(f.commands).toEqual([]);
  } finally {
    if (previousLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = previousLaunchCwd;
    }
  }
});

test("a missing source project requires a prebuilt override without building", async () => {
  const f = fixture({ missingProject: true });
  await expect(f.artifacts.resolve()).rejects.toThrow("AUTOMOBILE_VISIONOS_RUNNER_XCTESTRUN");
  expect(f.accesses).toEqual([path.join("/repo", "ios", "control-proxy", "CtrlProxy.xcodeproj")]);
  expect(f.commands).toEqual([]);
});

test("existing visionos artifacts bypass both building and the derived-data lock", async () => {
  let locks = 0;
  let builds = 0;
  const artifacts = new VisionosRunnerArtifacts({
    builder: {
      getConfig: () => ({ projectRoot: "/repo", derivedDataPath: "/derived" }),
      getXctestrunPath: async () => "/existing.xctestrun",
      runExclusiveOnDerivedData: async (task) => {
        locks += 1;
        return task();
      },
    },
    override: () => undefined,
    xcodebuild: {
      executeCommand: async () => {
        builds += 1;
        return createExecResult("", "");
      },
    },
  });
  expect(await artifacts.resolve()).toBe("/existing.xctestrun");
  expect(locks).toBe(0);
  expect(builds).toBe(0);
});

test("visionos build waits for extraction and holds the lock through post-build discovery", async () => {
  const mutex = new Mutex();
  const extraction = Promise.withResolvers<void>();
  const extractionStarted = Promise.withResolvers<void>();
  const lockRequested = Promise.withResolvers<void>();
  const buildStarted = Promise.withResolvers<void>();
  const buildFinished = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const lookupFinished = Promise.withResolvers<void>();
  let built = false;
  let extracting = false;
  const firstExtraction = mutex.runExclusive(async () => {
    extractionStarted.resolve();
    await extraction.promise;
  });
  await extractionStarted.promise;
  const artifacts = new VisionosRunnerArtifacts({
    builder: {
      getConfig: () => ({ projectRoot: "/repo", derivedDataPath: "/derived" }),
      getXctestrunPath: async () => {
        if (!built) {
          return null;
        }
        lookupStarted.resolve();
        await lookupFinished.promise;
        return "/built.xctestrun";
      },
      runExclusiveOnDerivedData: (task) => {
        lockRequested.resolve();
        return mutex.runExclusive(task);
      },
    },
    override: () => undefined,
    access: async () => {},
    xcodebuild: {
      executeCommand: async () => {
        built = true;
        buildStarted.resolve();
        await buildFinished.promise;
        return createExecResult("", "");
      },
    },
  });
  const resolving = artifacts.resolve();
  // Flush the bounded promise-only setup, including SingleFlight's task microtask.
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  expect(built).toBe(false);
  extraction.resolve();
  await firstExtraction;
  await lockRequested.promise;
  await buildStarted.promise;
  const secondExtraction = mutex.runExclusive(async () => {
    extracting = true;
  });
  await Promise.resolve();
  expect(extracting).toBe(false);
  buildFinished.resolve();
  await lookupStarted.promise;
  expect(extracting).toBe(false);
  lookupFinished.resolve();
  expect(await resolving).toBe("/built.xctestrun");
  await secondExtraction;
  expect(extracting).toBe(true);
});
