import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  DefaultSimHidHelperProvider,
  SIM_HID_SOURCES,
} from "../../../../src/utils/ios/simHid/SimHidHelperProvider";
import { ActionableError } from "../../../../src/models/ActionableError";
import { SimHidCompileError } from "../../../../src/utils/ios/simHid/SimHidCompileError";
import type { HostCommandOptions } from "../../../../src/utils/HostCommandExecutor";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const ROOT = resolve("/pkg");
const ACTIVE_DIR = "/Applications/Xcode-27.2.0.app/Contents/Developer";

class BuildRunner extends FakeHostCommandExecutor {
  constructor(private readonly fs: FakeFileSystem) {
    super();
  }
  override async executeCommand(
    command: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ) {
    const result = await super.executeCommand(command, args, options);
    if (command === "xcode-select") {
      return { ...result, stdout: `${ACTIVE_DIR}\n` };
    }
    if (args.includes("--find")) {
      return { ...result, stdout: `${options?.env?.DEVELOPER_DIR}/usr/bin/swiftc\n` };
    }
    const out = args.indexOf("-o");
    if (out >= 0) {
      this.fs.setFile(args[out + 1]!, "binary");
    }
    return result;
  }
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const fs = new FakeFileSystem();
  for (const source of SIM_HID_SOURCES) {
    fs.setFile(join(ROOT, source), `// ${source}`);
  }
  const runner = new BuildRunner(fs);
  const provider = new DefaultSimHidHelperProvider({
    fileSystem: fs,
    runner,
    env,
    idGenerator: new FakeIdGenerator(["p1", "p2"]),
    directory: () => resolve("/data/ios-sim-hid"),
    rootCandidates: [resolve("/missing"), ROOT],
  });
  return { fs, runner, provider };
}

describe("DefaultSimHidHelperProvider", () => {
  test("compiles every source in one swiftc call with the active Xcode, signs and caches it", async () => {
    const { runner, provider, fs } = setup();
    const build = await provider.ensure();
    expect(build.env.DEVELOPER_DIR).toBe(ACTIVE_DIR);
    expect(fs.existsSync(build.path)).toBe(true);
    const compile = runner.getExecutedCalls().find((call) => call.args[0] === "swiftc");
    expect(compile?.args).toEqual([
      "swiftc",
      "-O",
      "-swift-version",
      "6",
      "-module-name",
      "SimHidHelper",
      ...SIM_HID_SOURCES.map((source) => join(ROOT, source)),
      "-o",
      `${build.path}.p1.tmp`,
    ]);
    expect(runner.wasCommandExecuted("codesign -f -s -")).toBe(true);
    const again = await provider.ensure();
    expect(again.path).toBe(build.path);
    expect(runner.getExecutedCalls().filter((call) => call.args[0] === "swiftc")).toHaveLength(1);
  });

  test("DEVELOPER_DIR wins and keys a separate build", async () => {
    const active = await setup().provider.ensure();
    const configured = await setup({
      DEVELOPER_DIR: "/Applications/Xcode-26.6.app/Contents/Developer",
    }).provider.ensure();
    expect(configured.env.DEVELOPER_DIR).toBe("/Applications/Xcode-26.6.app/Contents/Developer");
    expect(configured.path).not.toBe(active.path);
  });

  test("missing sources and failed compiles are actionable", async () => {
    const empty = new DefaultSimHidHelperProvider({
      fileSystem: new FakeFileSystem(),
      runner: new FakeHostCommandExecutor(),
      rootCandidates: [ROOT],
    });
    await expect(empty.ensure()).rejects.toThrow("Reinstall the package");
    const { runner, provider } = setup();
    runner.setCommandError("swiftc -O", new Error("error: no such module"));
    await expect(provider.ensure()).rejects.toThrow("build step failed");
  });

  test("only a swiftc non-zero exit with diagnostics is a compile error", async () => {
    const { runner, provider } = setup();
    runner.setCommandError(
      "swiftc -O",
      Object.assign(new Error("failed"), { code: 1, stderr: "error: cannot find type 'X'" }),
    );
    await expect(provider.ensure()).rejects.toBeInstanceOf(SimHidCompileError);

    const transient = setup();
    transient.runner.setCommandError(
      "swiftc -O",
      Object.assign(new Error("failed"), { code: 1, stderr: "" }),
    );
    const failure = await transient.provider.ensure().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ActionableError);
    expect(failure).not.toBeInstanceOf(SimHidCompileError);

    const codesign = setup();
    codesign.runner.setCommandError(
      "codesign",
      Object.assign(new Error("failed"), { code: 1, stderr: "codesign: error" }),
    );
    const signFailure = await codesign.provider.ensure().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(signFailure).toBeInstanceOf(ActionableError);
    expect(signFailure).not.toBeInstanceOf(SimHidCompileError);
  });
});
