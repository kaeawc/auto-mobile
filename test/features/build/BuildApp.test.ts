import { describe, expect, test } from "bun:test";
import { basename, dirname, join, normalize } from "node:path";
import {
  BuildApp,
  buildLogExcerpt,
  type BuildFileSystem,
  type BuildPathInfo,
} from "../../../src/features/build/BuildApp";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import type { ExecResult } from "../../../src/models";

interface Call {
  file: string;
  args: string[];
  options?: HostCommandOptions;
}

class FakeExecutor implements HostCommandExecutor {
  readonly calls: Call[] = [];
  constructor(
    private readonly outcome: (call: Call) => void = () => {},
    private readonly onRun: () => void = () => {},
  ) {}

  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    const call = { file, args, options };
    this.calls.push(call);
    this.outcome(call);
    this.onRun();
    return {
      stdout: "",
      stderr: "",
      toString: () => "",
      trim: () => "",
      includes: () => false,
    };
  }
}

/** A path-keyed fake tree; directories list their direct children by name. */
class FakeFileSystem implements BuildFileSystem {
  private readonly entries = new Map<string, BuildPathInfo>();

  add(path: string, isDirectory: boolean, mtimeMs = 0): this {
    this.entries.set(normalize(path), { isDirectory, mtimeMs });
    return this;
  }

  async stat(path: string): Promise<BuildPathInfo | null> {
    return this.entries.get(path) ?? null;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.entries.keys()]
      .filter((entry) => entry !== path && dirname(entry) === path)
      .map((entry) => basename(entry));
  }
}

/** Platform-native spelling of a POSIX-style fixture path, so the suite passes on Windows. */
const p = (path: string): string => normalize(path);

function execFailure(raw: Record<string, unknown>): Error {
  return new Error("Command failed", { cause: Object.assign(new Error("raw"), raw) });
}

const TV_PROJECT = p("/work/TvApp/TvApp.xcodeproj");
const TV_PRODUCTS = p(
  "/work/TvApp/build/AutoMobileDerivedData/Build/Products/Debug-appletvsimulator",
);

describe("BuildApp apple", () => {
  test("builds a tvOS scheme for a simulator UDID and returns the .app", async () => {
    const fs = new FakeFileSystem().add(TV_PROJECT, true);
    const executor = new FakeExecutor(
      () => {},
      () => fs.add(TV_PRODUCTS, true).add(join(TV_PRODUCTS, "TvApp.app"), true, 5),
    );
    const result = await new BuildApp({ executor, fs, hostPlatform: "darwin" }).build({
      platform: "tvos",
      projectPath: TV_PROJECT,
      scheme: "TvApp",
      simulatorUdid: "UDID-1",
    });

    expect(result).toMatchObject({ success: true, artifactPath: join(TV_PRODUCTS, "TvApp.app") });
    expect(executor.calls[0].file).toBe("xcodebuild");
    expect(executor.calls[0].args).toEqual([
      "-project",
      TV_PROJECT,
      "-scheme",
      "TvApp",
      "-configuration",
      "Debug",
      "-sdk",
      "appletvsimulator",
      "-destination",
      "platform=tvOS Simulator,id=UDID-1",
      "-derivedDataPath",
      p("/work/TvApp/build/AutoMobileDerivedData"),
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ]);
  });

  test("prefers the single workspace in a directory and uses the generic destination", async () => {
    const fs = new FakeFileSystem()
      .add(p("/work/App"), true)
      .add(p("/work/App/App.xcodeproj"), true)
      .add(p("/work/App/App.xcworkspace"), true);
    const executor = new FakeExecutor();
    const result = await new BuildApp({ executor, fs, hostPlatform: "darwin" }).build({
      platform: "visionos",
      projectPath: p("/work/App"),
      scheme: "App",
      configuration: "Release",
    });

    expect(executor.calls[0].args.slice(0, 2)).toEqual([
      "-workspace",
      p("/work/App/App.xcworkspace"),
    ]);
    expect(executor.calls[0].args).toContain("generic/platform=visionOS Simulator");
    expect(executor.calls[0].args).toContain("xrsimulator");
    expect(result).toMatchObject({ success: false, errorCode: "artifact_not_found" });
  });

  test("refuses Apple builds off macOS and without a scheme, without running anything", async () => {
    const fs = new FakeFileSystem().add(TV_PROJECT, true);
    const executor = new FakeExecutor();
    const linux = await new BuildApp({ executor, fs, hostPlatform: "linux" }).build({
      platform: "ios",
      projectPath: TV_PROJECT,
      scheme: "TvApp",
    });
    const noScheme = await new BuildApp({ executor, fs, hostPlatform: "darwin" }).build({
      platform: "ios",
      projectPath: TV_PROJECT,
    });

    expect(linux).toMatchObject({ success: false, errorCode: "unsupported_host" });
    expect(noScheme).toMatchObject({ success: false, errorCode: "invalid_request" });
    expect(executor.calls).toEqual([]);
  });

  test("reports a missing project", async () => {
    const result = await new BuildApp({
      executor: new FakeExecutor(),
      fs: new FakeFileSystem(),
      hostPlatform: "darwin",
    }).build({ platform: "tvos", projectPath: TV_PROJECT, scheme: "TvApp" });

    expect(result).toMatchObject({ success: false, errorCode: "project_not_found" });
  });

  test("a failing build returns build_failed with the error lines of the log", async () => {
    const fs = new FakeFileSystem().add(TV_PROJECT, true);
    const executor = new FakeExecutor(() => {
      throw execFailure({
        code: 65,
        stdout:
          "CompileSwift normal\n/work/TvApp/App.swift:3:5: error: cannot find 'Foo' in scope\n** BUILD FAILED **\n",
      });
    });
    const result = await new BuildApp({ executor, fs, hostPlatform: "darwin" }).build({
      platform: "tvos",
      projectPath: TV_PROJECT,
      scheme: "TvApp",
    });

    expect(result).toMatchObject({ success: false, errorCode: "build_failed" });
    expect(result.success ? "" : result.logExcerpt).toBe(
      "/work/TvApp/App.swift:3:5: error: cannot find 'Foo' in scope\n** BUILD FAILED **",
    );
    expect(result.success ? "" : result.error).toContain("exit code 65");
  });

  test("distinguishes a missing build tool and a timeout", async () => {
    const fs = new FakeFileSystem().add(TV_PROJECT, true);
    const run = (raw: Record<string, unknown>) =>
      new BuildApp({
        executor: new FakeExecutor(() => {
          throw execFailure(raw);
        }),
        fs,
        hostPlatform: "darwin",
      }).build({ platform: "tvos", projectPath: TV_PROJECT, scheme: "TvApp", timeoutMs: 5 });

    expect(await run({ code: "ENOENT" })).toMatchObject({ errorCode: "build_tool_not_found" });
    expect(await run({ killed: true, signal: "SIGTERM", code: null })).toMatchObject({
      errorCode: "build_timed_out",
    });
  });

  test("rethrows when the caller aborted", async () => {
    const fs = new FakeFileSystem().add(TV_PROJECT, true);
    const controller = new AbortController();
    const abortError = new Error("aborted");
    const builder = new BuildApp({
      executor: new FakeExecutor(() => {
        controller.abort();
        throw abortError;
      }),
      fs,
      hostPlatform: "darwin",
    });

    await expect(
      builder.build(
        { platform: "tvos", projectPath: TV_PROJECT, scheme: "TvApp" },
        controller.signal,
      ),
    ).rejects.toBe(abortError);
  });
});

describe("BuildApp android", () => {
  const apkRoot = p("/work/droid/app/build/outputs/apk");

  test("assembles the variant with the wrapper and returns the newest matching APK", async () => {
    const fs = new FakeFileSystem()
      .add(p("/work/droid/gradlew"), false)
      .add(apkRoot, true)
      .add(p(`${apkRoot}/free`), true)
      .add(p(`${apkRoot}/free/debug`), true)
      .add(p(`${apkRoot}/free/debug/app-free-debug.apk`), false, 9)
      .add(p(`${apkRoot}/paid`), true)
      .add(p(`${apkRoot}/paid/debug`), true)
      .add(p(`${apkRoot}/paid/debug/app-paid-debug.apk`), false, 10);
    const executor = new FakeExecutor();
    const result = await new BuildApp({ executor, fs, hostPlatform: "linux" }).build({
      platform: "android",
      projectPath: p("/work/droid"),
      variant: "freeDebug",
    });

    expect(executor.calls[0]).toMatchObject({
      file: p("/work/droid/gradlew"),
      args: [":app:assembleFreeDebug", "--console=plain"],
      options: { cwd: p("/work/droid") },
    });
    expect(result).toMatchObject({
      success: true,
      artifactPaths: [p(`${apkRoot}/free/debug/app-free-debug.apk`)],
    });
  });

  test("uses gradlew.bat on Windows and a nested module path", async () => {
    const fs = new FakeFileSystem().add(join(p("/work/droid"), "gradlew.bat"), false);
    const executor = new FakeExecutor();
    await new BuildApp({ executor, fs, hostPlatform: "win32" }).build({
      platform: "android",
      projectPath: p("/work/droid"),
      module: ":apps:tv",
    });

    expect(executor.calls[0].file).toBe(join(p("/work/droid"), "gradlew.bat"));
    expect(executor.calls[0].args[0]).toBe(":apps:tv:assembleDebug");
  });

  test("a project without the wrapper is project_not_found", async () => {
    const result = await new BuildApp({
      executor: new FakeExecutor(),
      fs: new FakeFileSystem(),
      hostPlatform: "linux",
    }).build({ platform: "android", projectPath: p("/work/droid") });

    expect(result).toMatchObject({ success: false, errorCode: "project_not_found" });
  });
});

describe("buildLogExcerpt", () => {
  test("keeps Gradle failure lines", () => {
    const log = [
      "> Task :app:compileDebugKotlin FAILED",
      "e: file:///work/A.kt:1:1 Unresolved reference: Foo",
      "FAILURE: Build failed with an exception.",
      "* What went wrong:",
      "BUILD FAILED in 3s",
    ].join("\n");
    expect(buildLogExcerpt(log).split("\n")).toHaveLength(5);
  });

  test("falls back to the tail when nothing matches", () => {
    const log = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    const excerpt = buildLogExcerpt(log).split("\n");
    expect(excerpt).toHaveLength(40);
    expect(excerpt.at(-1)).toBe("line 59");
  });
});
