import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  DefaultIosCameraPosterDylibProvider,
  IOS_CAMERA_POSTER_SOURCE,
  sourcePathsFromModule,
} from "../../../../src/features/utility/ios/IosCameraPosterDylibProvider";
import { ActionableError } from "../../../../src/models/ActionableError";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const source = resolve("/repo/CameraPosterInjection.m");
const bytes = "captured source bytes for hashing";
const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const output = join(
  resolve("/data/ios-camera-poster"),
  `${digest}-sim-universal`,
  "libAMCameraPoster.dylib",
);

class BuildRunner extends FakeHostCommandExecutor {
  beforeCommand?: (command: string, args: string[]) => Promise<void>;
  constructor(private readonly fs: FakeFileSystem) {
    super();
  }
  override async executeCommand(command: string, args: string[] = []) {
    await this.beforeCommand?.(command, args);
    const result = await super.executeCommand(command, args);
    const out = args.indexOf("-o");
    if (out >= 0) {
      this.fs.setFile(args[out + 1]!, "compiled dylib");
    }
    return result;
  }
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const fs = new FakeFileSystem();
  fs.setFile(source, bytes);
  const runner = new BuildRunner(fs);
  const provider = new DefaultIosCameraPosterDylibProvider({
    fileSystem: fs,
    runner,
    env,
    idGenerator: new FakeIdGenerator(),
    sourcePaths: [source],
    directory: () => resolve("/data/ios-camera-poster"),
  });
  return { fs, runner, provider };
}

test("explicit prebuilt override skips source discovery and commands", async () => {
  const h = setup({ AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB: resolve("/prebuilt.dylib") });
  h.fs.setFile(resolve("/prebuilt.dylib"), "prebuilt");
  expect(await h.provider.ensure()).toBe(resolve("/prebuilt.dylib"));
  expect(h.runner.getExecutedCalls()).toEqual([]);
});

test("missing override fails without falling back to a build", async () => {
  const h = setup({ AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB: "/missing.dylib" });
  await expect(h.provider.ensure()).rejects.toBeInstanceOf(ActionableError);
  await expect(h.provider.ensure()).rejects.toThrow("AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB");
  expect(h.runner.getExecutedCalls()).toEqual([]);
});

test("builds a universal arm64 + x86_64 simulator dylib, signs the partial, publishes under source hash", async () => {
  const h = setup();
  expect(await h.provider.ensure()).toBe(output);
  const partial = `${output}.fake-1.tmp`;
  expect(h.runner.getExecutedCalls().map(({ command, args }) => ({ command, args }))).toEqual([
    { command: "xcrun", args: ["--sdk", "iphonesimulator", "--find", "clang"] },
    {
      command: "xcrun",
      args: [
        "--sdk",
        "iphonesimulator",
        "clang",
        "-arch",
        "arm64",
        "-arch",
        "x86_64",
        "-dynamiclib",
        "-fobjc-arc",
        ...[
          "Foundation",
          "UIKit",
          "AVFoundation",
          "CoreImage",
          "CoreMedia",
          "CoreVideo",
          "ImageIO",
          "UniformTypeIdentifiers",
        ].flatMap((f) => ["-framework", f]),
        "-mios-simulator-version-min=17.0",
        source,
        "-o",
        partial,
      ],
    },
    { command: "codesign", args: ["-f", "-s", "-", partial] },
  ]);
  expect(h.fs.existsSync(output)).toBe(true);
  expect(h.fs.existsSync(partial)).toBe(false);
});

test("reuses existing hashed dylib without Xcode", async () => {
  const h = setup();
  h.fs.setFile(output, "previous build");
  expect(await h.provider.ensure()).toBe(output);
  expect(h.runner.getExecutedCalls()).toEqual([]);
});

test("missing xcrun returns install and prebuilt guidance", async () => {
  const h = setup();
  h.runner.setCommandError("--find", new Error("xcrun ENOENT"));
  await expect(h.provider.ensure()).rejects.toThrow("Install Xcode and run xcode-select --install");
  expect(h.runner.getExecutedCalls()).toHaveLength(1);
});

test("source override missing is actionable and does not fall back", async () => {
  const h = setup({ AUTOMOBILE_IOS_CAMERA_POSTER_SOURCE: "/missing.m" });
  await expect(h.provider.ensure()).rejects.toThrow("Reinstall the package");
  expect(h.runner.getExecutedCalls()).toEqual([]);
});

test("source override is compiled instead of local candidates", async () => {
  const h = setup({ AUTOMOBILE_IOS_CAMERA_POSTER_SOURCE: resolve("/override.m") });
  h.fs.setFile(resolve("/override.m"), bytes);
  await h.provider.ensure();
  expect(h.runner.getExecutedCalls()[1]?.args).toContain(resolve("/override.m"));
});

test("compiler stderr is trimmed, launch fails and no cache entry is published", async () => {
  const h = setup();
  h.runner.setCommandError(
    "-arch",
    Object.assign(new Error("clang failed"), { stderr: "  missing header  \n" }),
  );
  await expect(h.provider.ensure()).rejects.toThrow("missing header");
  expect(h.fs.existsSync(output)).toBe(false);
  expect(h.runner.wasCommandExecuted("codesign")).toBe(false);
});

test("signing failure removes partial and permits a retry", async () => {
  const h = setup();
  h.runner.setCommandError("codesign", new Error("sign failed"));
  await expect(h.provider.ensure()).rejects.toThrow("sign failed");
  expect(h.fs.existsSync(output)).toBe(false);
  expect(h.fs.existsSync(`${output}.fake-1.tmp`)).toBe(false);
});

test("concurrent launches share one build and never publish a partial early", async () => {
  const h = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let compiles = 0;
  h.runner.beforeCommand = async (_command, args) => {
    if (args.includes("-arch")) {
      compiles++;
      entered.resolve();
      await release.promise;
    }
  };
  const pending = Promise.all([h.provider.ensure(), h.provider.ensure(), h.provider.ensure()]);
  await entered.promise;
  expect(h.fs.existsSync(output)).toBe(false);
  release.resolve();
  expect(await pending).toEqual([output, output, output]);
  expect(compiles).toBe(1);
  expect(h.runner.getExecutedCalls()).toHaveLength(3);
});

test("source absence without override explains repository and env alternatives", async () => {
  const fs = new FakeFileSystem();
  const runner = new BuildRunner(fs);
  const provider = new DefaultIosCameraPosterDylibProvider({
    fileSystem: fs,
    runner,
    env: {},
    sourcePaths: [source],
  });
  await expect(provider.ensure()).rejects.toBeInstanceOf(ActionableError);
  await expect(provider.ensure()).rejects.toThrow("AUTOMOBILE_IOS_CAMERA_POSTER_SOURCE");
  expect(runner.getExecutedCalls()).toEqual([]);
});

test("source content changes choose a new hash directory", async () => {
  const h = setup();
  await h.provider.ensure();
  h.fs.setFile(source, "changed source");
  const hash = createHash("sha256").update("changed source").digest("hex").slice(0, 12);
  expect(await h.provider.ensure()).toBe(
    join(resolve("/data/ios-camera-poster"), `${hash}-sim-universal`, "libAMCameraPoster.dylib"),
  );
  expect(h.runner.getExecutedCalls()).toHaveLength(6);
});

test("an arm64-only build cached under the bare source hash is not reused", async () => {
  const h = setup();
  h.fs.setFile(
    join(resolve("/data/ios-camera-poster"), digest, "libAMCameraPoster.dylib"),
    "arm64 only",
  );
  expect(await h.provider.ensure()).toBe(output);
  expect(h.runner.wasCommandExecuted("codesign")).toBe(true);
});

test("an installed package finds the shipped source from its bundled dist/src module", async () => {
  const fs = new FakeFileSystem();
  const root = resolve("/usr/lib/node_modules/@kaeawc/auto-mobile");
  const shipped = join(root, IOS_CAMERA_POSTER_SOURCE);
  fs.setFile(shipped, bytes);
  const runner = new BuildRunner(fs);
  const provider = new DefaultIosCameraPosterDylibProvider({
    fileSystem: fs,
    runner,
    env: {},
    idGenerator: new FakeIdGenerator(),
    moduleDirectory: join(root, "dist", "src"),
    directory: () => resolve("/data/ios-camera-poster"),
  });
  expect(await provider.ensure()).toBe(output);
  expect(runner.getExecutedCalls()[1]?.args).toContain(shipped);
});

test("module ancestors are searched nearest first up to the filesystem root", () => {
  const root = resolve("/pkg");
  const paths = sourcePathsFromModule(join(root, "dist", "src"));
  expect(paths.slice(0, 3)).toEqual([
    join(root, "dist", "src", IOS_CAMERA_POSTER_SOURCE),
    join(root, "dist", IOS_CAMERA_POSTER_SOURCE),
    join(root, IOS_CAMERA_POSTER_SOURCE),
  ]);
});

test("the npm package ships the injection source the provider looks for", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    files: string[];
  };
  expect(manifest.files).toContain(IOS_CAMERA_POSTER_SOURCE);
  expect(readFileSync(resolve(IOS_CAMERA_POSTER_SOURCE), "utf8")).toContain("AM_CAMERA_POSTER");
});
