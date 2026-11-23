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
const ACTIVE_DIR = "/Applications/Xcode-26.6.app/Contents/Developer";
const ACTIVE_CLANG = `${ACTIVE_DIR}/usr/bin/clang`;
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
  /** What `xcode-select -p` answers: the operator can switch it while the daemon runs. */
  activeDir = ACTIVE_DIR;
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
    if (command === "xcode-select") {
      return { ...result, stdout: `${this.activeDir}\n` };
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
  const clock = { now: 0 };
  const provider = new DefaultIosNetworkShaperDylibProvider({
    fileSystem: fs,
    runner,
    idGenerator: new FakeIdGenerator(),
    rootCandidates: roots,
    env,
    directory: () => resolve("/data/ios-network-shaper"),
    now: () => clock.now,
    toolchainTtlMs: 30_000,
  });
  return { fs, runner, provider, clock };
}

test("builds a universal simulator dylib linked against the resolver stub, signed, under both files' hash", async () => {
  const h = setup();
  expect(await h.provider.ensure()).toBe(OUTPUT);
  const partial = `${OUTPUT}.fake-1.tmp`;
  expect(h.runner.getExecutedCalls().map(({ command, args }) => ({ command, args }))).toEqual([
    { command: "xcode-select", args: ["-p"] },
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

function builds(runner: FakeHostCommandExecutor): number {
  return runner.getExecutedCalls().filter(({ command }) => command === "codesign").length;
}

test("a cached build is reused without invoking the compiler", async () => {
  const h = setup();
  await h.provider.ensure();
  expect(await h.provider.ensure()).toBe(OUTPUT);
  expect(builds(h.runner)).toBe(1);
});

test("the toolchain is probed once per TTL, so live applies stay fast", async () => {
  const h = setup();
  await h.provider.ensure();
  h.clock.now = 29_999;
  await h.provider.ensure();
  expect(
    h.runner.getExecutedCalls().filter(({ command }) => command === "xcode-select"),
  ).toHaveLength(1);
  h.clock.now = 30_000;
  await h.provider.ensure();
  expect(
    h.runner.getExecutedCalls().filter(({ command }) => command === "xcode-select"),
  ).toHaveLength(2);
});

test("an unreadable active Xcode fails instead of building unpinned", async () => {
  const h = setup();
  h.runner.setCommandError("xcode-select", new Error("no developer directory"));
  await expect(h.provider.ensure()).rejects.toThrow("cannot determine the active Xcode");
  expect(builds(h.runner)).toBe(0);
});

test("the active Xcode is re-resolved after the TTL and pinned for its build, so a switch is a new build", async () => {
  const h = setup(undefined, { PATH: "/opt/bin" });
  expect(await h.provider.ensure()).toBe(OUTPUT);
  h.runner.activeDir = PINNED_DIR;
  h.clock.now = 30_000;
  expect(await h.provider.ensure()).toBe(outputFor(`${PINNED_CLANG}\n25B200`));
  expect(builds(h.runner)).toBe(2);
  // The injected environment reaches every lookup, compile and sign call on the active path.
  const calls = h.runner.getExecutedCalls();
  expect(calls.every(({ options }) => options?.env?.PATH === "/opt/bin")).toBe(true);
  expect(
    calls
      .filter(({ command }) => command !== "xcode-select")
      .map(({ options }) => options?.env?.DEVELOPER_DIR),
  ).toEqual([
    ACTIVE_DIR,
    ACTIVE_DIR,
    ACTIVE_DIR,
    ACTIVE_DIR,
    PINNED_DIR,
    PINNED_DIR,
    PINNED_DIR,
    PINNED_DIR,
  ]);
});

test("concurrent ensures share one toolchain probe and one build", async () => {
  const h = setup();
  const outputs = await Promise.all([h.provider.ensure(), h.provider.ensure()]);
  expect(outputs).toEqual([OUTPUT, OUTPUT]);
  expect(
    h.runner.getExecutedCalls().filter(({ command }) => command === "xcode-select"),
  ).toHaveLength(1);
  expect(builds(h.runner)).toBe(1);
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
