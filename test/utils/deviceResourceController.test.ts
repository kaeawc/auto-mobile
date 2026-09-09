import { beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultDeviceResourceController,
  type DeviceResourceRequest,
} from "../../src/utils/deviceResourceController";
import type { SimCtl } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { PlistReader } from "../../src/utils/ios-cmdline-tools/PlistClient";
import { createExecResult } from "../../src/utils/execResult";
import { FakeTimer } from "../fakes/FakeTimer";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { deviceResourceDescriptions } from "../../src/models/deviceResourceDescriptions";
import { basename, join } from "node:path";
import { DeviceLifecyclePreemptedError } from "../../src/utils/virtualDeviceLifecycleCoordinator";

const udid = "12345678-1234-1234-1234-123456789ABC";
const label = "com.apple.PosterBoard";
const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-18-6";

class FakeWallpaperSimctl implements Pick<SimCtl, "executeCommandArgs"> {
  calls: string[][] = [];
  budgets: number[] = [];
  disabled = false;
  loaded = true;
  booted = true;
  malformed = false;
  emptyOverrides = false;
  ignoreWrites = false;
  failVerb?: string;
  onCommand?: (args: string[]) => void;
  states = new Map<string, { disabled: boolean; loaded: boolean }>();
  failLabel?: string;

  state(service: string) {
    if (service === label) {
      return { disabled: this.disabled, loaded: this.loaded };
    }
    if (!this.states.has(service)) {
      this.states.set(service, { disabled: false, loaded: true });
    }
    return this.states.get(service)!;
  }

  async executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal) {
    this.calls.push(args);
    this.budgets.push(timeoutMs!);
    signal?.throwIfAborted();
    this.onCommand?.(args);
    if (args[0] === "list") {
      return createExecResult(
        JSON.stringify(
          args[1] === "devices"
            ? {
                devices: {
                  [runtime]: [
                    { udid, state: this.booted ? "Booted" : "Shutdown", isAvailable: true },
                  ],
                },
              }
            : { runtimes: [{ identifier: runtime, runtimeRoot: "/runtime", isAvailable: true }] },
        ),
        "",
      );
    }
    const verb = args[3];
    const service = args[4]?.startsWith("system/")
      ? args[4].slice(7)
      : basename(args[5] ?? "", ".plist");
    if (this.failVerb === verb && (!this.failLabel || this.failLabel === service)) {
      throw new Error("permission denied");
    }
    if (verb === "print-disabled") {
      return createExecResult(
        this.malformed
          ? "unexpected output"
          : this.emptyOverrides && !this.disabled
            ? "\n\tdisabled services = (no disabled services)\n"
            : `disabled services = {\n "${label}" => ${this.disabled}\n "com.apple.apsd" => true\n${[...this.states].map(([name, state]) => `"${name}" => ${state.disabled}`).join("\n")}\n}`,
        "",
      );
    }
    const state = this.state(service);
    if (verb === "print" && !state.loaded) {
      throw new Error(`Could not find service "${service}" in domain for system`);
    }
    if (!this.ignoreWrites) {
      if (verb === "disable") {
        state.disabled = true;
      }
      if (verb === "enable") {
        state.disabled = false;
      }
      if (verb === "bootout") {
        state.loaded = false;
      }
      if (verb === "bootstrap") {
        state.loaded = true;
      }
      if (service === label) {
        this.disabled = state.disabled;
        this.loaded = state.loaded;
      }
    }
    return createExecResult("", "");
  }

  mutations() {
    return this.calls.filter((args) =>
      ["disable", "enable", "bootout", "bootstrap"].includes(args[3] ?? ""),
    );
  }
}

class FakeWallpaperPlist implements Pick<PlistReader, "readJsonFile"> {
  definition?: unknown;
  missing = new Set<string>();
  definitions = new Map<string, unknown>();
  paths: string[] = [];
  directoryReads = 0;
  async readDirectory(path: string): Promise<string[]> {
    this.directoryReads++;
    const labels = Object.values(iosDeviceResourceCatalog).flat();
    return labels
      .filter(
        (name) =>
          !this.missing.has(name) &&
          (name === label ? path.endsWith("LaunchAngels") : path.endsWith("LaunchDaemons")),
      )
      .map((name) => `${name}.plist`);
  }
  async readJsonFile(path: string) {
    this.paths.push(path);
    const name = basename(path, ".plist");
    return this.definition ?? this.definitions.get(name) ?? { Label: name };
  }
}

describe("device resource control", () => {
  let simctl: FakeWallpaperSimctl;
  let plist: FakeWallpaperPlist;
  let timer: FakeTimer;
  let controller: DefaultDeviceResourceController;
  let request: DeviceResourceRequest;
  beforeEach(() => {
    simctl = new FakeWallpaperSimctl();
    plist = new FakeWallpaperPlist();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    controller = new DefaultDeviceResourceController(simctl, plist, timer, (path) =>
      plist.readDirectory(path),
    );
    request = {
      device: { platform: "ios", name: "Phone", deviceId: udid },
      resources: { wallpaperRendering: "disabled" },
      deadlineMs: 10_000,
    };
  });

  test("disables only the wallpaper renderer and verifies that the job is absent", async () => {
    const result = await controller.setResources(request);
    expect(result).toMatchObject({
      success: true,
      resources: { wallpaperRendering: { state: "disabled" } },
      changed: ["wallpaperRendering"],
      verification: "current_boot",
    });
    expect(simctl.mutations()).toEqual([
      ["spawn", udid, "launchctl", "disable", `system/${label}`],
      ["spawn", udid, "launchctl", "bootout", `system/${label}`],
    ]);
    expect(plist.paths).toEqual([
      join("/runtime", "System", "Library", "LaunchAngels", "com.apple.PosterBoard.plist"),
    ]);
  });

  test("enabling bootstraps a previously removed job without a reboot", async () => {
    simctl.disabled = true;
    simctl.loaded = false;
    request.resources = { wallpaperRendering: "enabled" };
    expect((await controller.setResources(request)).success).toBe(true);
    expect(simctl.mutations()).toEqual([
      ["spawn", udid, "launchctl", "enable", `system/${label}`],
      [
        "spawn",
        udid,
        "launchctl",
        "bootstrap",
        "system",
        join("/runtime", "System", "Library", "LaunchAngels", "com.apple.PosterBoard.plist"),
      ],
    ]);
  });

  test("recognizes a clean runtime's explicit no-disabled-services diagnostic", async () => {
    simctl.emptyOverrides = true;
    expect((await controller.setResources(request)).success).toBe(true);
  });

  test("repeated disabling is idempotent", async () => {
    await controller.setResources(request);
    simctl.calls = [];
    expect((await controller.setResources(request)).changed).toEqual([]);
    expect(simctl.mutations()).toEqual([]);
  });

  test("repairs an override whose process is still loaded", async () => {
    simctl.disabled = true;
    expect((await controller.setResources(request)).success).toBe(true);
    expect(simctl.loaded).toBe(false);
  });

  test("unsupported Android settings run no Apple or Android commands", async () => {
    request.device = { platform: "android", name: "Pixel", deviceId: "emulator-5554" };
    request.resources = { wallpaperRendering: "disabled", googlePlayServices: "disabled" };
    expect(await controller.setResources(request)).toMatchObject({
      success: false,
      changed: [],
      resources: {
        wallpaperRendering: { state: "unsupported" },
        googlePlayServices: { state: "unsupported" },
      },
    });
    expect(simctl.calls).toEqual([]);
  });

  test("app-affecting resources are unsupported and omitted resources remain untouched", async () => {
    request.resources = {
      backgroundSync: "disabled",
      icloudSync: "disabled",
      googlePlayServices: "disabled",
    };
    const result = await controller.setResources(request);
    expect(result.success).toBe(false);
    expect(Object.keys(result.resources)).toEqual([
      "backgroundSync",
      "icloudSync",
      "googlePlayServices",
    ]);
    expect(Object.values(result.resources).every((value) => value.state === "unsupported")).toBe(
      true,
    );
    expect(simctl.calls).toEqual([]);
  });

  test.each(["booted", "all", "00008110-001234567890001E"])(
    "never sends a native command to alias or physical ID %s",
    async (deviceId) => {
      request.device.deviceId = deviceId;
      expect((await controller.setResources(request)).resources.wallpaperRendering?.state).toBe(
        "unsupported",
      );
      expect(simctl.calls).toEqual([]);
    },
  );

  test.each([
    { Label: "com.apple.apsd" },
    { Label: label, Disabled: true },
    { Label: label, Disabled: { conditional: true } },
  ])("does not mutate incompatible runtime service definitions %j", async (definition) => {
    plist.definition = definition;
    expect((await controller.setResources(request)).resources.wallpaperRendering?.state).toBe(
      "unsupported",
    );
    expect(simctl.mutations()).toEqual([]);
  });

  test("a shutdown target is unsupported without mutations", async () => {
    simctl.booted = false;
    expect((await controller.setResources(request)).success).toBe(false);
    expect(simctl.mutations()).toEqual([]);
  });

  test("malformed observation never means enabled or disabled", async () => {
    simctl.malformed = true;
    const result = await controller.setResources(request);
    expect(result.success).toBe(false);
    expect(result.resources.wallpaperRendering?.state).toBe("unknown");
    expect(simctl.mutations()).toEqual([]);
  });

  test("permission errors are not interpreted as an absent service", async () => {
    simctl.failVerb = "print";
    expect((await controller.setResources(request)).services?.wallpaperRendering?.[label]).toEqual({
      state: "unknown",
      reason: "permission denied",
    });
    expect(simctl.mutations()).toEqual([]);
  });

  test("successful commands without matching evidence fail verification", async () => {
    simctl.ignoreWrites = true;
    const result = await controller.setResources(request);
    expect(result.success).toBe(false);
    expect(result.resources.wallpaperRendering?.state).toBe("unknown");
  });

  test("waits for launchd to finish unregistering an acknowledged bootout", async () => {
    let unloading = false;
    simctl.onCommand = (args) => {
      if (args[3] === "bootout") {
        unloading = true;
      }
      if (args[3] === "print" && unloading) {
        simctl.loaded = timer.now() < 300;
      }
    };
    expect((await controller.setResources(request)).success).toBe(true);
    expect(timer.now()).toBe(300);
    expect(simctl.mutations().filter((args) => args[3] === "bootout")).toHaveLength(1);
  });

  test("a partial mutation remains visible and a retry repairs it", async () => {
    simctl.failVerb = "bootout";
    expect(await controller.setResources(request)).toMatchObject({
      success: false,
      changed: ["wallpaperRendering"],
      resources: { wallpaperRendering: { state: "unknown" } },
    });
    simctl.failVerb = undefined;
    expect((await controller.setResources(request)).success).toBe(true);
  });

  test("deadline exhaustion stops subsequent commands and preserves requested statuses", async () => {
    simctl.onCommand = (args) => {
      if (args[3] === "disable") {
        timer.advanceTime(10_000);
      }
    };
    request.resources.photoAnalysis = "disabled";
    const result = await controller.setResources(request);
    expect(result.success).toBe(false);
    expect(result.resources.wallpaperRendering?.state).toBe("unknown");
    expect(result.resources.photoAnalysis?.state).toBe("unknown");
    expect(simctl.mutations().map((args) => args[3])).toEqual(["disable"]);
    expect(simctl.budgets.every((value) => value > 0 && value <= 10_000)).toBe(true);
  });

  test("cancellation prevents native commands", async () => {
    request.signal = AbortSignal.abort(new Error("cancelled"));
    await expect(controller.setResources(request)).rejects.toThrow("cancelled");
    expect(simctl.calls).toEqual([]);
  });

  test("teardown preemption propagates immediately after a native resource write", async () => {
    const abort = new AbortController();
    const reason = new DeviceLifecyclePreemptedError({
      kind: "stable",
      platform: "ios",
      stableId: udid,
    });
    request.signal = abort.signal;
    request.resources.widgets = "disabled";
    simctl.onCommand = (args) => {
      if (args[3] === "disable") {
        abort.abort(reason);
        throw reason;
      }
    };
    await expect(controller.setResources(request)).rejects.toBe(reason);
    expect(simctl.mutations().map((args) => args[3])).toEqual(["disable"]);
  });

  test("wallpaper, widgets, and Live Activities have independent state and mutations", async () => {
    request.resources = {
      wallpaperRendering: "disabled",
      widgets: "enabled",
      liveActivities: "disabled",
    };
    const result = await controller.setResources(request);
    expect(result.success).toBe(true);
    expect(result.changed).toEqual(["wallpaperRendering", "liveActivities"]);
    expect(simctl.state("com.apple.chronod")).toEqual({ disabled: false, loaded: true });
    expect(simctl.state("com.apple.liveactivitiesd")).toEqual({ disabled: true, loaded: false });
    expect(plist.directoryReads).toBe(3);
    expect(simctl.calls.filter((args) => args[0] === "list")).toHaveLength(2);
  });

  test.each(Object.keys(iosDeviceResourceCatalog) as (keyof typeof iosDeviceResourceCatalog)[])(
    "%s disables and restores exactly its installed allowlist",
    async (resource) => {
      request.resources = { [resource]: "disabled" };
      const disabled = await controller.setResources(request);
      expect(disabled.success).toBe(true);
      expect(
        simctl
          .mutations()
          .filter((args) => args[3] === "disable")
          .map((args) => args[4]!.slice(7)),
      ).toEqual([...iosDeviceResourceCatalog[resource]]);
      simctl.calls = [];
      request.resources = { [resource]: "enabled" };
      expect((await controller.setResources(request)).success).toBe(true);
      expect(
        simctl
          .mutations()
          .filter((args) => args[3] === "bootstrap")
          .map((args) => basename(args[5]!, ".plist")),
      ).toEqual([...iosDeviceResourceCatalog[resource]]);
    },
  );

  test("catalog groups never overlap or include shared app infrastructure", () => {
    const labels = Object.values(iosDeviceResourceCatalog).flat();
    expect(labels).not.toContain("com.apple.siri.context.service");
    expect(labels).not.toContain("com.apple.imdpersistence.IMDPersistenceAgent");
    expect(new Set(labels).size).toBe(labels.length);
    for (const name of [
      "apsd",
      "akd",
      "securityd",
      "accountsd",
      "appleaccountd",
      "swcd",
      "sharingd",
      "assetsd",
      "assetsd.nebulad",
      "cloudphotod",
      "bird",
      "cloudd",
      "contactsd",
      "telephonyutilities.callservicesd",
      "identityservicesd",
      "corespeechd",
      "assistantd",
      "voiced",
      "voicebankingd",
      "naturallanguaged",
      "textunderstandingd",
      "modelmanagerd",
      "modelcatalogd",
      "mlhostd",
      "mlruntimed",
      "mediaanalysisd",
      "mediaanalysisd.service",
      "photosface",
      "intelligenceflowd",
      "devicecheckd",
      "mobileassetd",
      "countryd",
      "triald",
      "managedconfiguration.passcodenagd",
      "Safari.SafeBrowsing.Service",
      "Safari.passwordbreachd",
      "MapKit.SnapshotService",
      "storekitd",
      "itunesstored",
      "GameController.gamecontrollerd",
    ]) {
      expect(labels).not.toContain(`com.apple.${name}`);
    }
    expect(
      Object.keys(iosDeviceResourceCatalog).every(
        (resource) => resource in deviceResourceDescriptions,
      ),
    ).toBe(true);
  });

  test("absent runtime services are reported while the installed subset is verified", async () => {
    plist.missing.add("com.apple.healthrecordsd");
    simctl.states.set("com.apple.healthrecordsd", { disabled: false, loaded: false });
    request.resources = { healthServices: "disabled" };
    const result = await controller.setResources(request);
    expect(result.success).toBe(true);
    expect(result.resources.healthServices?.reason).toContain("absent");
    expect(result.services?.healthServices?.["com.apple.healthrecordsd"]?.state).toBe(
      "unsupported",
    );
    expect(simctl.mutations().some((args) => args.join(" ").includes("healthrecordsd"))).toBe(
      false,
    );
  });

  test("an entirely absent resource is unsupported", async () => {
    plist.missing.add("com.apple.chronod");
    simctl.states.set("com.apple.chronod", { disabled: false, loaded: false });
    request.resources = { widgets: "disabled" };
    expect((await controller.setResources(request)).resources.widgets?.state).toBe("unsupported");
    expect(simctl.mutations()).toEqual([]);
  });

  test("preflights all group definitions before a write", async () => {
    plist.definitions.set("com.apple.homeeventsd", {
      Label: "com.apple.homeeventsd",
      Disabled: true,
    });
    request.resources = { homeServices: "disabled" };
    expect((await controller.setResources(request)).resources.homeServices?.state).toBe(
      "unsupported",
    );
    expect(simctl.mutations()).toEqual([]);
  });

  test("a registered service without an approved definition blocks its group", async () => {
    plist.missing.add("com.apple.homeeventsd");
    request.resources = { homeServices: "disabled" };
    expect((await controller.setResources(request)).resources.homeServices?.state).toBe(
      "unsupported",
    );
    expect(simctl.mutations()).toEqual([]);
  });

  test("resolves approved runtime filenames independently of service labels", async () => {
    const aliasController = new DefaultDeviceResourceController(
      simctl,
      plist,
      timer,
      async (path) =>
        path.endsWith("LaunchDaemons") ? ["com.apple.CloudSettingsSyncAgent.plist"] : [],
    );
    plist.definition = { Label: "com.apple.cloudsettingssyncagent" };
    simctl.states.set("com.apple.syncdefaultsd", { disabled: false, loaded: false });
    simctl.states.set("com.apple.icloudsubscriptionoptimizerd", { disabled: false, loaded: false });
    request.resources = { icloudSettingsSync: "disabled" };
    expect((await aliasController.setResources(request)).success).toBe(true);
    expect(plist.paths).toContain(
      join(
        "/runtime",
        "System",
        "Library",
        "LaunchDaemons",
        "com.apple.CloudSettingsSyncAgent.plist",
      ),
    );
  });

  test("one failed service produces mixed evidence and does not suppress other resources", async () => {
    simctl.failVerb = "bootout";
    simctl.failLabel = "com.apple.homed";
    request.resources = {
      homeServices: "disabled",
      widgets: "disabled",
      backgroundSync: "disabled",
    };
    const result = await controller.setResources(request);
    expect(result.success).toBe(false);
    expect(result.resources.homeServices?.state).toBe("unknown");
    expect(result.services?.homeServices?.["com.apple.homed"]?.state).toBe("unknown");
    expect(result.services?.homeServices?.["com.apple.homeeventsd"]?.state).toBe("disabled");
    expect(result.resources.widgets?.state).toBe("disabled");
    expect(result.resources.backgroundSync?.state).toBe("unsupported");
    expect(result.changed).toEqual(["homeServices", "widgets"]);
    simctl.failVerb = undefined;
    request.resources = { homeServices: "disabled" };
    expect((await controller.setResources(request)).success).toBe(true);
  });

  test("directory permissions and ambiguous definitions fail closed", async () => {
    const denied = new DefaultDeviceResourceController(simctl, plist, timer, async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect((await denied.setResources(request)).resources.wallpaperRendering?.state).toBe(
      "unknown",
    );
    const duplicate = new DefaultDeviceResourceController(simctl, plist, timer, async () => [
      `${label}.plist`,
    ]);
    expect((await duplicate.setResources(request)).resources.wallpaperRendering?.state).toBe(
      "unknown",
    );
    expect(simctl.mutations()).toEqual([]);
  });
});
