import { expect, test } from "bun:test";
import path from "node:path";
import { Mutex } from "async-mutex";
import { WatchRunnerArtifacts } from "../../../src/features/watch/WatchRunnerArtifacts";
import { createExecResult } from "../../../src/utils/execResult";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";

const PROJECT = path.join("ios", "control-proxy", "CtrlProxy.xcodeproj");

function fixture({
  missingProject = false,
  projectRoot = "/repo",
  presentProjects,
}: { missingProject?: boolean; projectRoot?: string; presentProjects?: string[] } = {}) {
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
        projectRoot,
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
      if (missingProject || (presentProjects && !presentProjects.includes(file))) {
        throw new Error("ENOENT");
      }
    },
    projectLocator: { launchDirectory: () => "/launch", packageRoot: () => "/package" },
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

test("a missing source project names every searched path and each fix without building", async () => {
  const f = fixture({ missingProject: true });
  const error = await f.artifacts.resolve().then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  const message = error instanceof Error ? error.message : String(error);
  const checked = ["/repo", "/launch", "/package"].map((root) => path.join(root, PROJECT));
  expect(f.accesses).toEqual(checked);
  for (const searched of checked) {
    expect(message).toContain(searched);
  }
  expect(message).toContain("not built in /derived");
  expect(message).toContain("AUTOMOBILE_PROJECT_ROOT");
  expect(message).toContain("xcodebuild build-for-testing");
  expect(message).toContain("-scheme CtrlProxyWatch");
  expect(message).toContain("-derivedDataPath /derived");
  expect(message).toContain("AUTOMOBILE_WATCH_RUNNER_XCTESTRUN");
  expect(f.commands).toEqual([]);
});

// #17285: the detached daemon runs in the home directory, so the default project root
// (the process working directory) misses a checkout the daemon was launched from.
test("builds from the daemon launch checkout when the configured root lacks the project", async () => {
  const launchProject = path.join("/launch", PROJECT);
  const f = fixture({ projectRoot: "/home/user", presentProjects: [launchProject] });
  expect(await f.artifacts.resolve()).toContain("watchsimulator");
  expect(f.accesses).toEqual([path.join("/home/user", PROJECT), launchProject]);
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]?.slice(0, 5)).toEqual([
    "build-for-testing",
    "-project",
    launchProject,
    "-scheme",
    "CtrlProxyWatch",
  ]);
});

test("falls back to the AutoMobile package checkout running the daemon", async () => {
  const packageProject = path.join("/package", PROJECT);
  const f = fixture({ projectRoot: "/home/user", presentProjects: [packageProject] });
  expect(await f.artifacts.resolve()).toContain("watchsimulator");
  expect(f.commands[0]?.[2]).toBe(packageProject);
});

test("existing watch artifacts bypass both building and the derived-data lock", async () => {
  let locks = 0;
  let builds = 0;
  const artifacts = new WatchRunnerArtifacts({
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

test("watch build waits for extraction and holds the lock through post-build discovery", async () => {
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
  const artifacts = new WatchRunnerArtifacts({
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
