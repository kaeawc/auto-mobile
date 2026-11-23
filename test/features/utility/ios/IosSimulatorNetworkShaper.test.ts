import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  DefaultIosSimulatorNetworkShaper,
  findLaunchdSimPid,
  formatShaperProfile,
  parseShaperProfile,
  type IosNetworkShaperProfile,
} from "../../../../src/features/utility/ios/IosSimulatorNetworkShaper";
import { parsePsSnapshot } from "../../../../src/devices/bootAdmission/psSnapshot";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { HostCommandOptions } from "../../../../src/utils/HostCommandExecutor";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const UDID = "79F93511-21AB-4E2F-9E1D-CE8BF15800B1";
const DYLIB = resolve(
  "/data/ios-network-shaper/ab77451dc09c-sim-universal/libAMNetworkShaper.dylib",
);
const PROFILE = join(resolve("/data/ios-network-shaper"), "profiles", `${UDID}.conf`);
const LAUNCHD = `launchd_sim /devices/${UDID}/data/var/run/launchd_bootstrap.plist`;
const LISTING = [
  "    1     0  12000   0.0 /sbin/launchd",
  `18299     1  20000   0.1 ${LAUNCHD}`,
  "18301     1  20000   0.1 launchd_sim /devices/7B3A3792-DB53-4654-BA94-27A1D305C3B7/data/var/run/launchd_bootstrap.plist",
].join("\n");
const SHAPED_ENV = `${LAUNCHD} HOME=/home DYLD_INSERT_LIBRARIES=${DYLIB} SIM_RS_NETSHAPE=${PROFILE}`;
const THREE_G: IosNetworkShaperProfile = {
  offline: false,
  delayMs: 200,
  downloadKbps: 1920,
  uploadKbps: 128,
  packetLossPercent: 2,
};

/** `ps` answers from the simulator's current boot: shaped only after a shaped `simctl boot`. */
class SimulatorHost extends FakeHostCommandExecutor {
  booted = true;
  shaped = false;
  bootInjects = true;
  override async executeCommand(
    command: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ) {
    const result = await super.executeCommand(command, args, options);
    if (command === "ps" && args[0] === "-axo") {
      return {
        ...result,
        stdout: this.booted ? LISTING : "    1     0  12000   0.0 /sbin/launchd",
      };
    }
    if (command === "ps" && args[0] === "-E") {
      return { ...result, stdout: this.shaped ? SHAPED_ENV : `${LAUNCHD} HOME=/home` };
    }
    if (args[1] === "shutdown") {
      this.booted = false;
      this.shaped = false;
    }
    if (args[1] === "boot") {
      this.booted = true;
      this.shaped =
        this.bootInjects &&
        options?.env?.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES === DYLIB &&
        options.env.SIMCTL_CHILD_SIM_RS_NETSHAPE === PROFILE;
    }
    return result;
  }
}

function setup() {
  const fs = new FakeFileSystem();
  const runner = new SimulatorHost();
  const shaper = new DefaultIosSimulatorNetworkShaper({
    runner,
    fileSystem: fs,
    idGenerator: new FakeIdGenerator(),
    env: { PATH: "/usr/bin" },
    dylibProvider: { ensure: async () => DYLIB },
    profileDirectory: () => resolve("/data/ios-network-shaper"),
  });
  return { fs, runner, shaper };
}

function simctlCalls(runner: FakeHostCommandExecutor) {
  return runner
    .getExecutedCalls()
    .filter(({ command }) => command === "xcrun")
    .map(({ args, options }) => ({
      args,
      dyld: options?.env?.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,
      profile: options?.env?.SIMCTL_CHILD_SIM_RS_NETSHAPE,
    }));
}

test("first apply writes the profile, then reboots the simulator with the shaper in launchd's env", async () => {
  const h = setup();
  expect(await h.shaper.apply(UDID, THREE_G)).toEqual({ rebooted: true });
  expect(await h.fs.readFile(PROFILE)).toBe(formatShaperProfile(THREE_G));
  expect(simctlCalls(h.runner)).toEqual([
    { args: ["simctl", "shutdown", UDID], dyld: undefined, profile: undefined },
    { args: ["simctl", "boot", UDID], dyld: DYLIB, profile: PROFILE },
    { args: ["simctl", "bootstatus", UDID], dyld: undefined, profile: undefined },
  ]);
  // The boot keeps the caller's environment (DEVELOPER_DIR, PATH) beside the shaper's.
  const boot = h.runner.getExecutedCalls().find(({ args }) => args[1] === "boot");
  expect(boot?.options?.env?.PATH).toBe("/usr/bin");
});

test("an injected simulator takes a new profile live, with no simctl call", async () => {
  const h = setup();
  h.runner.shaped = true;
  expect(await h.shaper.apply(UDID, { ...THREE_G, offline: true })).toEqual({ rebooted: false });
  expect(simctlCalls(h.runner)).toEqual([]);
  expect(parseShaperProfile(await h.fs.readFile(PROFILE)).offline).toBe(true);
});

test("a boot that does not carry the shaper is an error, not a silent unshaped success", async () => {
  const h = setup();
  h.runner.bootInjects = false;
  await expect(h.shaper.apply(UDID, THREE_G)).rejects.toBeInstanceOf(ActionableError);
  await expect(h.shaper.apply(UDID, THREE_G)).rejects.toThrow("does not carry the network shaper");
});

test("a failed boot is reported with the simctl command", async () => {
  const h = setup();
  h.runner.setCommandError("simctl boot", new Error("Unable to boot device"));
  await expect(h.shaper.apply(UDID, THREE_G)).rejects.toThrow("Rebooting the iOS Simulator");
});

test("clear writes an unshaped profile only when one exists, and never reboots", async () => {
  const h = setup();
  await h.shaper.clear(UDID);
  expect(h.fs.existsSync(PROFILE)).toBe(false);
  h.fs.setFile(PROFILE, formatShaperProfile(THREE_G));
  await h.shaper.clear(UDID);
  expect(parseShaperProfile(await h.fs.readFile(PROFILE))).toEqual({
    offline: false,
    delayMs: 0,
    downloadKbps: 0,
    uploadKbps: 0,
    packetLossPercent: 0,
  });
  expect(h.runner.getExecutedCalls()).toEqual([]);
});

test("read skips the process scan for a simulator AutoMobile never shaped", async () => {
  const h = setup();
  expect(await h.shaper.read(UDID)).toEqual({ injected: false });
  expect(h.runner.getExecutedCalls()).toEqual([]);
  h.fs.setFile(PROFILE, formatShaperProfile(THREE_G));
  h.runner.shaped = true;
  expect(await h.shaper.read(UDID)).toEqual({ injected: true, profile: THREE_G });
});

test("profile format round-trips and clamps loss to 100", () => {
  expect(formatShaperProfile({ ...THREE_G, packetLossPercent: 150 })).toBe(
    "offline=0\nlatency_ms=200\ndown_kbps=1920\nup_kbps=128\nloss_pct=100\n",
  );
  expect(parseShaperProfile("garbage\nlatency_ms = 9\noffline=1\n")).toMatchObject({
    offline: true,
    delayMs: 9,
  });
});

test("finds only this simulator's launchd_sim", () => {
  const rows = parsePsSnapshot(LISTING).rows;
  expect(findLaunchdSimPid(rows, `/${UDID}/data/var/run/launchd_bootstrap.plist`)).toBe(18299);
  expect(findLaunchdSimPid(rows, "/MISSING/data/var/run/launchd_bootstrap.plist")).toBeUndefined();
});
