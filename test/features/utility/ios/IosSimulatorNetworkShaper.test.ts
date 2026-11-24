import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  DefaultIosSimulatorNetworkShaper,
  findLaunchdSimPid,
  formatShaperProfile,
  parseShaperProfile,
  type IosNetworkShaperProfile,
  type ShaperRebootLifecycle,
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
const OWNER = PROFILE.replace(/\.conf$/, ".owner");
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
  /** The boot's DYLD_INSERT_LIBRARIES; launchd_sim reports it while shaped. */
  inserted = DYLIB;
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
      return {
        ...result,
        stdout: this.shaped
          ? SHAPED_ENV.replace(
              `DYLD_INSERT_LIBRARIES=${DYLIB}`,
              `DYLD_INSERT_LIBRARIES=${this.inserted}`,
            )
          : `${LAUNCHD} HOME=/home`,
      };
    }
    if (args[1] === "shutdown") {
      this.booted = false;
      this.shaped = false;
    }
    if (args[1] === "boot") {
      this.booted = true;
      const inserted = options?.env?.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES ?? "";
      this.shaped =
        this.bootInjects &&
        // A prefix check, not split(":"): on Windows the fixture paths carry a drive letter.
        (inserted === DYLIB || inserted.startsWith(`${DYLIB}:`)) &&
        options?.env?.SIMCTL_CHILD_SIM_RS_NETSHAPE === PROFILE;
      this.inserted = inserted;
    }
    return result;
  }
}

function setup(options: { companions?: string[] } = {}) {
  const fs = new FakeFileSystem();
  const booted: string[] = [];
  const runner = new SimulatorHost();
  const lifecycleEvents: string[] = [];
  const livePids = new Set([4242]);
  const lifecycle: ShaperRebootLifecycle = {
    retireForShutdown: async (platform, udid) => {
      lifecycleEvents.push(`retire ${platform} ${udid}`);
    },
    resumeAfterDeviceStart: (platform, udid) => {
      lifecycleEvents.push(`resume ${platform} ${udid}`);
    },
  };
  const shaper = new DefaultIosSimulatorNetworkShaper({
    lifecycle,
    runner,
    fileSystem: fs,
    idGenerator: new FakeIdGenerator(),
    env: { PATH: "/usr/bin" },
    dylibProvider: { ensure: async () => DYLIB },
    profileDirectory: () => resolve("/data/ios-network-shaper"),
    ownerPid: 4242,
    isProcessRunning: (pid) => livePids.has(pid),
    bootHooks: { notifyBooted: (udid) => booted.push(udid) },
    ...(options.companions ? { companionLibraries: async () => options.companions! } : {}),
  });
  return { fs, runner, shaper, lifecycleEvents, livePids, booted };
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

test("clear removes the profile, so a later read reports nothing and scans no processes", async () => {
  const h = setup();
  await h.shaper.clear(UDID);
  expect(h.fs.existsSync(PROFILE)).toBe(false);
  h.fs.setFile(PROFILE, formatShaperProfile(THREE_G));
  h.runner.shaped = true;
  await h.shaper.clear(UDID);
  expect(h.fs.existsSync(PROFILE)).toBe(false);
  // The injected shaper still runs, but with no profile file it passes traffic through.
  expect(await h.shaper.read(UDID)).toEqual({ injected: false });
  expect(h.runner.getExecutedCalls()).toEqual([]);
});

test("concurrent first applies on one simulator reboot it once", async () => {
  const h = setup();
  const results = await Promise.all([
    h.shaper.apply(UDID, THREE_G),
    h.shaper.apply(UDID, { ...THREE_G, offline: true }),
  ]);
  expect(results).toEqual([{ rebooted: true }, { rebooted: true }]);
  expect(simctlCalls(h.runner).map(({ args }) => args[1])).toEqual([
    "shutdown",
    "boot",
    "bootstatus",
  ]);
  // The later request's profile is the one in effect.
  expect(parseShaperProfile(await h.fs.readFile(PROFILE)).offline).toBe(true);
  // A later apply sees the injected boot and changes the profile live.
  expect(await h.shaper.apply(UDID, THREE_G)).toEqual({ rebooted: false });
  expect(simctlCalls(h.runner)).toHaveLength(3);
});

test("a shaped reboot fences the CtrlProxy client and re-admits it after boot", async () => {
  const h = setup();
  await h.shaper.apply(UDID, THREE_G);
  expect(h.lifecycleEvents).toEqual([`retire ios ${UDID}`, `resume ios ${UDID}`]);
  const failed = setup();
  failed.runner.setCommandError("simctl boot", new Error("Unable to boot device"));
  await expect(failed.shaper.apply(UDID, THREE_G)).rejects.toThrow("Rebooting");
  expect(failed.lifecycleEvents).toEqual([`retire ios ${UDID}`, `resume ios ${UDID}`]);
});

test("clearOrphaned deletes only profiles whose writing process is gone", async () => {
  const h = setup();
  expect(await h.shaper.clearOrphaned()).toEqual([]);
  await h.shaper.apply(UDID, THREE_G);
  expect(await h.fs.readFile(OWNER)).toBe("4242\n");
  const dir = join(resolve("/data/ios-network-shaper"), "profiles");
  const peer = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
  const ownerless = "0F0E0D0C-0000-4000-8000-000000000001";
  h.fs.setFile(join(dir, `${peer}.conf`), "offline=1\n");
  h.fs.setFile(join(dir, `${peer}.owner`), "777\n");
  h.fs.setFile(join(dir, `${ownerless}.conf`), "offline=1\n");
  h.fs.setFile(join(dir, "notes.txt"), "keep");
  h.livePids.add(777);
  const calls = h.runner.getExecutedCalls().length;

  // This daemon (4242) and a live peer (777) still own theirs; only the ownerless one goes.
  expect(await h.shaper.clearOrphaned()).toEqual([ownerless]);
  // After a crash, 4242 is gone: the next daemon unshapes its simulator.
  h.livePids.delete(4242);
  expect(await h.shaper.clearOrphaned()).toEqual([UDID]);
  expect(h.fs.existsSync(PROFILE)).toBe(false);
  expect(h.fs.existsSync(OWNER)).toBe(false);
  expect(h.fs.existsSync(join(dir, `${peer}.conf`))).toBe(true);
  expect(h.fs.existsSync(join(dir, "notes.txt"))).toBe(true);
  expect(h.runner.getExecutedCalls()).toHaveLength(calls);
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

test("apply publishes the owner file before the profile, so a sweep never sees an unowned profile", async () => {
  const h = setup();
  const renamed: string[] = [];
  const rename = h.fs.rename.bind(h.fs);
  h.fs.rename = async (from: string, to: string) => {
    renamed.push(to);
    await rename(from, to);
  };
  await h.shaper.apply(UDID, THREE_G);
  expect(renamed).toEqual([OWNER, PROFILE]);
  expect(await h.fs.readFile(OWNER)).toBe("4242\n");
});

test("a failed profile write leaves the previous profile and owner in place", async () => {
  const h = setup();
  h.fs.setFile(PROFILE, formatShaperProfile(THREE_G));
  h.fs.setFile(OWNER, "999\n");
  const rename = h.fs.rename.bind(h.fs);
  h.fs.rename = async (from: string, to: string) => {
    if (to === PROFILE) {
      throw new Error("disk full");
    }
    await rename(from, to);
  };
  await expect(h.shaper.apply(UDID, { ...THREE_G, offline: true })).rejects.toThrow("disk full");
  h.fs.rename = rename;
  expect(parseShaperProfile(await h.fs.readFile(PROFILE))).toEqual(THREE_G);
  expect(await h.fs.readFile(OWNER)).toBe("999\n");
});

test("a failed shaped reboot removes the new profile when there was none before", async () => {
  const h = setup();
  h.runner.setCommandError("simctl boot", new Error("Unable to boot device"));
  await expect(h.shaper.apply(UDID, { ...THREE_G, offline: true })).rejects.toThrow("Rebooting");
  expect(h.fs.existsSync(PROFILE)).toBe(false);
  expect(h.fs.existsSync(OWNER)).toBe(false);
});

test("a failed shaped reboot restores the profile that was in effect before", async () => {
  const h = setup();
  h.runner.shaped = true;
  await h.shaper.apply(UDID, THREE_G);
  // The simulator was booted again without the shaper, and the shaped reboot now fails.
  h.runner.shaped = false;
  h.runner.bootInjects = false;
  await expect(h.shaper.apply(UDID, { ...THREE_G, offline: true })).rejects.toThrow(
    "does not carry the network shaper",
  );
  expect(parseShaperProfile(await h.fs.readFile(PROFILE))).toEqual(THREE_G);
});

test("the sweep keeps a profile a live daemon took over after the sweep read the dead owner", async () => {
  const h = setup();
  h.fs.setFile(PROFILE, "offline=1\n");
  h.fs.setFile(OWNER, "999\n");
  h.livePids.add(777);
  const rename = h.fs.rename.bind(h.fs);
  h.fs.rename = async (from: string, to: string) => {
    if (from === PROFILE && to.endsWith(".sweep")) {
      // Another daemon writes its owner, then its profile, between the sweep's read and claim.
      h.fs.setFile(OWNER, "777\n");
      h.fs.setFile(PROFILE, "offline=0\nlatency_ms=500\n");
    }
    await rename(from, to);
  };
  expect(await h.shaper.clearOrphaned()).toEqual([]);
  expect(await h.fs.readFile(PROFILE)).toBe("offline=0\nlatency_ms=500\n");
  expect(await h.fs.readFile(OWNER)).toBe("777\n");
  const dir = join(resolve("/data/ios-network-shaper"), "profiles");
  expect((await h.fs.readdir(dir)).filter((name) => name.endsWith(".sweep"))).toEqual([]);
});

test("the sweep waits for this daemon's in-flight apply on the same simulator", async () => {
  const h = setup();
  h.runner.shaped = true;
  h.fs.setFile(PROFILE, "offline=1\n");
  h.fs.setFile(OWNER, "999\n");
  const applying = h.shaper.apply(UDID, THREE_G);
  const swept = h.shaper.clearOrphaned();
  expect(await applying).toEqual({ rebooted: false });
  expect(await swept).toEqual([]);
  expect(parseShaperProfile(await h.fs.readFile(PROFILE))).toEqual(THREE_G);
  expect(await h.fs.readFile(OWNER)).toBe("4242\n");
});

test("a profile removed while read scans processes reads as unshaped", async () => {
  const h = setup();
  h.fs.setFile(PROFILE, formatShaperProfile(THREE_G));
  h.runner.shaped = true;
  const execute = h.runner.executeCommand.bind(h.runner);
  h.runner.executeCommand = async (command, args = [], options) => {
    if (command === "ps" && args[0] === "-E") {
      await h.shaper.clear(UDID);
    }
    return execute(command, args, options);
  };
  expect(await h.shaper.read(UDID)).toEqual({ injected: false });
});

test("applies sharing one failed shaped reboot restore the profile from before any of them", async () => {
  const h = setup();
  h.runner.shaped = true;
  await h.shaper.apply(UDID, THREE_G);
  h.runner.shaped = false;
  h.runner.bootInjects = false;
  const results = await Promise.allSettled([
    h.shaper.apply(UDID, { ...THREE_G, offline: true }),
    h.shaper.apply(UDID, { ...THREE_G, delayMs: 900 }),
  ]);
  expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  expect(parseShaperProfile(await h.fs.readFile(PROFILE))).toEqual(THREE_G);
});

test("a clear that lands during a failing shaped reboot is not undone by the rollback", async () => {
  const h = setup();
  const execute = h.runner.executeCommand.bind(h.runner);
  h.runner.bootInjects = false;
  h.runner.executeCommand = async (command, args = [], options) => {
    if (args[1] === "boot") {
      await h.shaper.clear(UDID);
    }
    return execute(command, args, options);
  };
  await expect(h.shaper.apply(UDID, THREE_G)).rejects.toThrow();
  expect(h.fs.existsSync(PROFILE)).toBe(false);
});

test("a rollback leaves a profile another daemon wrote while the reboot failed", async () => {
  const h = setup();
  const execute = h.runner.executeCommand.bind(h.runner);
  h.runner.bootInjects = false;
  h.runner.executeCommand = async (command, args = [], options) => {
    if (args[1] === "boot") {
      h.fs.setFile(PROFILE, "offline=0\nlatency_ms=500\n");
    }
    return execute(command, args, options);
  };
  await expect(h.shaper.apply(UDID, THREE_G)).rejects.toThrow();
  expect(await h.fs.readFile(PROFILE)).toBe("offline=0\nlatency_ms=500\n");
});

test("the sweep keeps an owner a live daemon wrote between the sweep's claim and its owner removal", async () => {
  const h = setup();
  h.fs.setFile(PROFILE, "offline=1\n");
  h.fs.setFile(OWNER, "999\n");
  h.livePids.add(777);
  const rename = h.fs.rename.bind(h.fs);
  h.fs.rename = async (from: string, to: string) => {
    await rename(from, to);
    if (from === PROFILE && to.endsWith(".sweep")) {
      // The takeover lands after the profile claim and the sweep's owner read.
      h.fs.setFile(OWNER, "777\n");
      h.fs.setFile(PROFILE, "offline=0\nlatency_ms=500\n");
    }
  };
  expect(await h.shaper.clearOrphaned()).toEqual([]);
  expect(await h.fs.readFile(PROFILE)).toBe("offline=0\nlatency_ms=500\n");
  expect(await h.fs.readFile(OWNER)).toBe("777\n");
  const dir = join(resolve("/data/ios-network-shaper"), "profiles");
  expect((await h.fs.readdir(dir)).filter((name) => name.includes(".sweep"))).toEqual([]);
});

const GATE = resolve("/data/ios-camera-poster-active/libAMCameraPosterGate.dylib");

// launchd_sim keeps the boot's DYLD_INSERT_LIBRARIES over every launch's (#19165): the launch gate
// must be in the boot list, or launchApp prototype:true and the camera poster cannot load.
test("a shaped boot inserts its companion libraries after the shaper", async () => {
  const h = setup({ companions: [GATE] });
  expect(await h.shaper.apply(UDID, THREE_G)).toEqual({ rebooted: true });
  const boot = simctlCalls(h.runner).find(({ args }) => args[1] === "boot");
  expect(boot?.dyld).toBe(`${DYLIB}:${GATE}`);
});

test("a simulator shaped without the gate is rebooted once to add it, then shapes live", async () => {
  const h = setup({ companions: [GATE] });
  h.runner.shaped = true; // An earlier build booted the shaper alone.
  expect(await h.shaper.apply(UDID, THREE_G)).toEqual({ rebooted: true });
  expect(await h.shaper.apply(UDID, { ...THREE_G, offline: true })).toEqual({ rebooted: false });
  expect(simctlCalls(h.runner).filter(({ args }) => args[1] === "boot")).toHaveLength(1);
});

test("a shaped reboot tells the boot hooks, so launchd-environment features re-apply", async () => {
  const h = setup({ companions: [GATE] });
  await h.shaper.apply(UDID, THREE_G);
  expect(h.booted).toEqual([UDID]);
  h.booted.length = 0;
  await h.shaper.apply(UDID, THREE_G);
  expect(h.booted).toEqual([]);
});
