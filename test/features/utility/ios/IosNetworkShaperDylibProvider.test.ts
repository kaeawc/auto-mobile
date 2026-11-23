import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DefaultIosNetworkShaperDylibProvider,
  IOS_NETWORK_SHAPER_DNS_STUB,
  IOS_NETWORK_SHAPER_SOURCE,
} from "../../../../src/features/utility/ios/IosNetworkShaperDylibProvider";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { HostCommandOptions } from "../../../../src/utils/HostCommandExecutor";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const ROOT = resolve("/pkg");
const SOURCE = join(ROOT, IOS_NETWORK_SHAPER_SOURCE);
const STUB = join(ROOT, IOS_NETWORK_SHAPER_DNS_STUB);
const digest = createHash("sha256")
  .update("shaper c")
  .update("dns stub")
  .digest("hex")
  .slice(0, 12);
const OUTPUT = join(
  resolve("/data/ios-network-shaper"),
  `${digest}-sim-universal`,
  "libAMNetworkShaper.dylib",
);

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
    const out = args.indexOf("-o");
    if (out >= 0) {
      this.fs.setFile(args[out + 1]!, "compiled dylib");
    }
    return result;
  }
}

function setup(roots = [resolve("/missing"), ROOT]) {
  const fs = new FakeFileSystem();
  fs.setFile(SOURCE, "shaper c");
  fs.setFile(STUB, "dns stub");
  const runner = new BuildRunner(fs);
  const provider = new DefaultIosNetworkShaperDylibProvider({
    fileSystem: fs,
    runner,
    idGenerator: new FakeIdGenerator(),
    rootCandidates: roots,
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
