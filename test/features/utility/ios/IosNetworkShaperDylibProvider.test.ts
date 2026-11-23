import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DefaultIosNetworkShaperDylibProvider,
  IOS_NETWORK_SHAPER_DNS_STUB,
  IOS_NETWORK_SHAPER_SOURCE,
  IOS_XCODE_PIN_SCRIPT,
} from "../../../../src/features/utility/ios/IosNetworkShaperDylibProvider";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { HostCommandOptions } from "../../../../src/utils/HostCommandExecutor";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const ROOT = resolve("/pkg");
const SOURCE = join(ROOT, IOS_NETWORK_SHAPER_SOURCE);
const STUB = join(ROOT, IOS_NETWORK_SHAPER_DNS_STUB);
const ACTIVE_CLANG = "/Applications/Xcode-26.6.app/Contents/Developer/usr/bin/clang";
const PINNED_DIR = "/Applications/Xcode-27.2.0.app/Contents/Developer";
const PINNED_CLANG = `${PINNED_DIR}/usr/bin/clang`;
function outputFor(identity: string): string {
  const digest = createHash("sha256")
    .update("shaper c")
    .update("dns stub")
    .update(identity)
    .digest("hex")
    .slice(0, 12);
  return join(
    resolve("/data/ios-network-shaper"),
    `${digest}-sim-universal`,
    "libAMNetworkShaper.dylib",
  );
}
const OUTPUT = outputFor(`${ACTIVE_CLANG}\n24A100`);

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
    const pinned = options?.env?.DEVELOPER_DIR === PINNED_DIR;
    if (args.includes("--find")) {
      return { ...result, stdout: `${pinned ? PINNED_CLANG : ACTIVE_CLANG}\n` };
    }
    if (args.includes("--show-sdk-build-version")) {
      return { ...result, stdout: pinned ? "25B200\n" : "24A100\n" };
    }
    if (command === "bash") {
      return { ...result, stdout: PINNED_DIR };
    }
    const out = args.indexOf("-o");
    if (out >= 0) {
      this.fs.setFile(args[out + 1]!, "compiled dylib");
    }
    return result;
  }
}

function setup(roots = [resolve("/missing"), ROOT], env: NodeJS.ProcessEnv = {}) {
  const fs = new FakeFileSystem();
  fs.setFile(SOURCE, "shaper c");
  fs.setFile(STUB, "dns stub");
  const runner = new BuildRunner(fs);
  const provider = new DefaultIosNetworkShaperDylibProvider({
    fileSystem: fs,
    runner,
    idGenerator: new FakeIdGenerator(),
    rootCandidates: roots,
    env,
    directory: () => resolve("/data/ios-network-shaper"),
  });
  return { fs, runner, provider };
}

test("builds a universal simulator dylib linked against the resolver stub, signed, under both files' hash", async () => {
  const h = setup();
  expect(await h.provider.ensure()).toBe(OUTPUT);
  const partial = `${OUTPUT}.fake-1.tmp`;
  expect(h.runner.getExecutedCalls().map(({ command, args }) => ({ command, args }))).toEqual([
    { command: "xcrun", args: ["--sdk", "iphonesimulator", "--find", "clang"] },
    { command: "xcrun", args: ["--sdk", "iphonesimulator", "--show-sdk-build-version"] },
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
        "-O2",
        "-dynamiclib",
        "-framework",
        "Network",
        "-framework",
        "SystemConfiguration",
        "-mios-simulator-version-min=15.0",
        STUB,
        SOURCE,
        "-o",
        partial,
      ],
    },
    { command: "codesign", args: ["-f", "-s", "-", partial] },
  ]);
  expect(h.fs.existsSync(partial)).toBe(false);
});

test("a repo checkout builds with the repository's pinned Xcode, keyed by that toolchain", async () => {
  const h = setup(undefined, { PATH: "/usr/bin" });
  h.fs.setFile(join(ROOT, IOS_XCODE_PIN_SCRIPT), "pin");
  expect(await h.provider.ensure()).toBe(outputFor(`${PINNED_CLANG}\n25B200`));
  const calls = h.runner.getExecutedCalls();
  expect(calls[0]).toMatchObject({ command: "bash" });
  expect(calls[0]!.args.at(-1)).toBe(join(ROOT, IOS_XCODE_PIN_SCRIPT));
  // Every toolchain, compile and sign call runs under the pinned DEVELOPER_DIR.
  expect(calls.slice(1).map(({ options }) => options?.env?.DEVELOPER_DIR)).toEqual([
    PINNED_DIR,
    PINNED_DIR,
    PINNED_DIR,
    PINNED_DIR,
  ]);
  expect(calls[1]!.options?.env?.PATH).toBe("/usr/bin");
});

test("a caller's DEVELOPER_DIR wins over the pin", async () => {
  const h = setup(undefined, { DEVELOPER_DIR: PINNED_DIR });
  h.fs.setFile(join(ROOT, IOS_XCODE_PIN_SCRIPT), "pin");
  expect(await h.provider.ensure()).toBe(outputFor(`${PINNED_CLANG}\n25B200`));
  expect(h.runner.wasCommandExecuted("bash")).toBe(false);
});

test("a cached build is reused without invoking the compiler", async () => {
  const h = setup();
  await h.provider.ensure();
  const calls = h.runner.getExecutedCalls().length;
  expect(await h.provider.ensure()).toBe(OUTPUT);
  expect(h.runner.getExecutedCalls().length).toBe(calls);
});

test("a missing source fails with an actionable error and runs nothing", async () => {
  const h = setup([resolve("/missing")]);
  await expect(h.provider.ensure()).rejects.toBeInstanceOf(ActionableError);
  await expect(h.provider.ensure()).rejects.toThrow(IOS_NETWORK_SHAPER_SOURCE);
  expect(h.runner.getExecutedCalls()).toEqual([]);
});

test("a missing compiler is reported with the Xcode hint", async () => {
  const h = setup();
  h.runner.setCommandError("--find clang", new Error("xcrun: error: unable to find utility"));
  await expect(h.provider.ensure()).rejects.toThrow("compiler unavailable");
});

test("the shipped shaper source and resolver stub are in the checkout", () => {
  expect(existsSync(IOS_NETWORK_SHAPER_SOURCE)).toBe(true);
  expect(existsSync(IOS_NETWORK_SHAPER_DNS_STUB)).toBe(true);
});
