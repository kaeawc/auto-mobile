import type { DeviceResourceController, DeviceResourceRequest } from "./deviceResourceController";
import type {
  ConfigurableDeviceResource,
  DeviceResourceConfigurationResult,
} from "../models/DeviceResourceConfiguration";
import type { DeviceResourceStatus } from "../models/DeviceResource";
import type { AndroidResourceRestoration } from "../models/AndroidResourceRestoration";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "./android-cmdline-tools/AdbClientFactory";
import type { AdbExecuteOptions } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "./SystemTimer";
import {
  androidDeviceResourceCatalog,
  androidResourceSettings,
} from "./androidDeviceResourceCatalog";
import { shellQuote } from "./shellQuote";
import { errorMessage } from "./describeUnknownError";

type Entry = AndroidResourceRestoration["entries"][number];
interface Run {
  request: DeviceResourceRequest;
  result: DeviceResourceConfigurationResult;
  user: string;
  command(args: string[]): Promise<string>;
}
const packageCatalog: Partial<Record<ConfigurableDeviceResource, readonly string[]>> =
  androidDeviceResourceCatalog;
const settingsCatalog: Partial<
  Record<ConfigurableDeviceResource, { namespace: "global" | "secure"; keys: readonly string[] }>
> = androidResourceSettings;
const packageVerbs = [
  "default-state",
  "enable",
  "disable",
  "disable-user",
  "disable-until-used",
] as const;

/** Reads native state before and after writes. Requested state never substitutes for observation. */
export class AndroidDeviceResourceController implements DeviceResourceController {
  constructor(
    private readonly adbFactory: Pick<AdbClientFactory, "create"> = defaultAdbClientFactory,
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
  ) {}

  async setResources(request: DeviceResourceRequest): Promise<DeviceResourceConfigurationResult> {
    const result: DeviceResourceConfigurationResult = {
      success: true,
      requested: request.resources,
      resources: {},
      services: {},
      changed: [],
      verification: "current_boot",
    };
    const keys = request.restore
      ? ([
          ...new Set(request.restore.entries.map((entry) => entry.resource)),
        ] as ConfigurableDeviceResource[])
      : (Object.keys(request.resources) as ConfigurableDeviceResource[]).filter(
          (key) => request.resources[key] !== undefined,
        );
    const supported = this.supportedResources(request, result, keys);
    if (!supported.length) {
      return result;
    }
    return this.runResources(request, result, supported);
  }

  private supportedResources(
    request: DeviceResourceRequest,
    result: DeviceResourceConfigurationResult,
    keys: ConfigurableDeviceResource[],
  ): ConfigurableDeviceResource[] {
    const supported = keys.filter(
      (key) => packageCatalog[key] || settingsCatalog[key] || key === "backup",
    );
    for (const key of keys.filter((key) => !supported.includes(key))) {
      result.resources[key] = {
        state: "unsupported",
        reason: "No Android implementation for this resource; no changes made.",
      };
      result.success = false;
    }
    if (request.device.platform !== "android" || !/^emulator-\d+$/.test(request.device.deviceId)) {
      for (const key of supported) {
        result.resources[key] = {
          state: "unsupported",
          reason: "Resource optimization requires an Android emulator.",
        };
      }
      result.success = false;
      return [];
    }
    return supported;
  }

  private async runResources(
    request: DeviceResourceRequest,
    result: DeviceResourceConfigurationResult,
    supported: ConfigurableDeviceResource[],
  ): Promise<DeviceResourceConfigurationResult> {
    const adb = this.adbFactory.create(request.device);
    const run: Run = {
      request,
      result,
      user: "",
      command: async (args) => {
        request.signal?.throwIfAborted();
        const timeoutMs = request.deadlineMs - this.timer.now();
        if (timeoutMs <= 0) {
          throw new Error("Android resource configuration deadline expired");
        }
        const options: AdbExecuteOptions = {
          timeoutMs,
          signal: request.signal,
          noRetry: true,
          waitForProcessSettlementAfterAbort: true,
        };
        const output = await adb.execute(["shell", args.map(shellQuote).join(" ")], options);
        request.signal?.throwIfAborted();
        return output.stdout.trim();
      },
    };
    try {
      await this.identifyRun(run);
      for (const resource of supported) {
        await this.configureResource(run, resource);
      }
    } catch (error) {
      request.signal?.throwIfAborted();
      for (const resource of supported) {
        result.resources[resource] ??= { state: "unknown", reason: errorMessage(error) };
      }
      result.success = false;
    }
    if (!result.restore?.entries.length) {
      delete result.restore;
    }
    return result;
  }

  private async identifyRun(run: Run): Promise<void> {
    run.user = await run.command(["am", "get-current-user"]);
    if (!/^\d+$/.test(run.user)) {
      throw new Error("Cannot determine Android foreground user");
    }
    const bootId = await run.command(["cat", "/proc/sys/kernel/random/boot_id"]);
    if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(bootId)) {
      throw new Error("Cannot identify this Android boot");
    }
    const { request } = run;
    run.result.restore = {
      deviceId: request.device.deviceId,
      bootId,
      userId: Number(run.user),
      entries: [],
    };
    if (!request.restore) {
      return;
    }
    if (
      request.restore.deviceId !== request.device.deviceId ||
      request.restore.bootId !== bootId ||
      request.restore.userId !== Number(run.user)
    ) {
      throw new Error("Restoration receipt belongs to a different device, boot or user");
    }
    if (!request.restore.entries.every((entry) => this.validEntry(entry))) {
      throw new Error("Restoration receipt contains unsupported targets or values");
    }
    if (
      new Set(request.restore.entries.map((entry) => `${entry.kind}:${entry.target}`)).size !==
      request.restore.entries.length
    ) {
      throw new Error("Restoration receipt contains duplicate targets");
    }
  }

  private async configureResource(run: Run, resource: ConfigurableDeviceResource): Promise<void> {
    const { request, result } = run;
    try {
      const entries = request.restore
        ? request.restore.entries.filter((entry) => entry.resource === resource)
        : await this.discover(run, resource);
      if (!entries.length) {
        result.resources[resource] = {
          state: "unsupported",
          reason: "No compatible installed targets for this resource.",
        };
        result.success = false;
        return;
      }
      const evidence: Record<string, DeviceResourceStatus> = {};
      result.services![resource] = evidence;
      if (
        entries.some((entry) => entry.kind === "package" && this.desiredValue(run, entry) !== "1")
      ) {
        await this.protectActivePackages(run, entries);
      }
      for (const entry of entries) {
        evidence[entry.target] = await this.configureEntry(run, entry);
      }
      const states = Object.values(evidence).map((value) => value.state);
      result.resources[resource] = {
        state: states.every((state) => state === states[0]) ? states[0]! : "unknown",
        ...(request.restore ? { reason: "Exact prior overrides restored and verified." } : {}),
      };
    } catch (error) {
      request.signal?.throwIfAborted();
      result.resources[resource] = { state: "unknown", reason: errorMessage(error) };
      result.success = false;
    }
  }

  private desiredValue(run: Run, entry: Entry): string | null {
    if (run.request.restore) {
      return entry.value;
    }
    if (run.request.resources[entry.resource as ConfigurableDeviceResource] !== "disabled") {
      return "1";
    }
    return entry.kind === "package" ? "3" : "0";
  }

  private async configureEntry(run: Run, entry: Entry): Promise<DeviceResourceStatus> {
    const before = await this.read(run, entry);
    const desired = this.desiredValue(run, entry);
    const resource = entry.resource as ConfigurableDeviceResource;
    if (before !== desired) {
      run.result.restore!.entries.push({ ...entry, value: before });
      if (!run.result.changed.includes(resource)) {
        run.result.changed.push(resource);
      }
      await this.write(run, entry, desired);
    }
    const after = await this.read(run, entry);
    if (after !== desired) {
      throw new Error(`Native state for ${entry.target} did not match requested value`);
    }
    return {
      state: this.state(entry, after),
      reason: `Verified value ${after ?? "default"} for user ${run.user}.`,
    };
  }

  private validEntry(entry: Entry): boolean {
    const resource = entry.resource as ConfigurableDeviceResource;
    if (entry.kind === "package") {
      return (
        !!packageCatalog[resource]?.includes(entry.target) && /^[0-4]$/.test(String(entry.value))
      );
    }
    if (entry.kind === "backup") {
      return (
        resource === "backup" &&
        entry.target === "backup" &&
        ["0", "1"].includes(String(entry.value))
      );
    }
    const setting = settingsCatalog[resource];
    return (
      setting?.namespace === entry.kind &&
      setting.keys.includes(entry.target) &&
      (entry.value === null || /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(entry.value))
    );
  }

  private async discover(run: Run, resource: ConfigurableDeviceResource): Promise<Entry[]> {
    const packages = packageCatalog[resource];
    if (packages) {
      const output = await run.command(["pm", "list", "packages", "-s", "--user", run.user]);
      const installed = new Set(
        output
          .split(/\r?\n/)
          .filter((line) => line.startsWith("package:"))
          .map((line) => line.slice(8)),
      );
      return packages
        .filter((name) => installed.has(name))
        .map((target) => ({ resource, kind: "package", target, value: null }));
    }
    const settings = settingsCatalog[resource];
    if (settings) {
      return settings.keys.map((target) => ({
        resource,
        kind: settings.namespace,
        target,
        value: null,
      }));
    }
    return [{ resource, kind: "backup", target: "backup", value: null }];
  }

  private async protectActivePackages(run: Run, entries: Entry[]): Promise<void> {
    const targets = entries
      .filter((entry) => entry.kind === "package")
      .map((entry) => entry.target);
    const activity = await run.command(["dumpsys", "activity", "activities"]);
    const input = await run.command([
      "settings",
      "--user",
      run.user,
      "get",
      "secure",
      "default_input_method",
    ]);
    const accessibility = await run.command([
      "settings",
      "--user",
      run.user,
      "get",
      "secure",
      "enabled_accessibility_services",
    ]);
    const roles: string[] = [];
    for (const role of ["HOME", "BROWSER", "DIALER", "SMS", "ASSISTANT"]) {
      const output = await run.command([
        "cmd",
        "role",
        "get-role-holders",
        "--user",
        run.user,
        `android.app.role.${role}`,
      ]);
      if (/unknown|error|not found|exception/i.test(output)) {
        throw new Error("Cannot verify protected Android role holders on this runtime");
      }
      roles.push(output);
    }
    for (const target of targets) {
      if (
        input.startsWith(`${target}/`) ||
        accessibility.split(":").some((service) => service.startsWith(`${target}/`)) ||
        roles.some((output) => output.split(/\s+/).includes(target)) ||
        activity
          .split("\n")
          .some(
            (line) =>
              /(?:mResumedActivity|topResumedActivity)/.test(line) && line.includes(`${target}/`),
          )
      ) {
        throw new Error(
          `${target} is an active app, role holder, input method or accessibility service; leave it available`,
        );
      }
    }
  }

  private async read(run: Run, entry: Entry): Promise<string | null> {
    if (entry.kind === "package") {
      const output = await run.command(["dumpsys", "package", entry.target]);
      const lines = output
        .split("\n")
        .filter(
          (line) => line.trimStart().startsWith(`User ${run.user}:`) && /\binstalled=/.test(line),
        );
      const match = lines.length === 1 ? /\benabled=([0-4])\b/.exec(lines[0]!) : null;
      if (
        !match ||
        !/\binstalled=true\b/.test(lines[0]!) ||
        /\b(?:hidden|suspended)=true\b/.test(lines[0]!)
      ) {
        throw new Error(`Cannot verify installed package override for ${entry.target}`);
      }
      return match[1]!;
    }
    if (entry.kind === "backup") {
      const output = await run.command(["bmgr", "--user", run.user, "enabled"]);
      if (output === "Backup Manager currently enabled") {
        return "1";
      }
      if (output === "Backup Manager currently disabled") {
        return "0";
      }
      throw new Error("Cannot verify Backup Manager state");
    }
    const value = await run.command([
      "settings",
      "--user",
      run.user,
      "get",
      entry.kind,
      entry.target,
    ]);
    if (value === "null") {
      return null;
    }
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
      throw new Error(`Cannot verify setting ${entry.target}`);
    }
    return value;
  }

  private async write(run: Run, entry: Entry, value: string | null): Promise<void> {
    if (entry.kind === "package") {
      await run.command(["pm", packageVerbs[Number(value)]!, "--user", run.user, entry.target]);
    } else if (entry.kind === "backup") {
      await run.command(["bmgr", "--user", run.user, "enable", value === "1" ? "true" : "false"]);
    } else {
      await run.command([
        "settings",
        "--user",
        run.user,
        value === null ? "delete" : "put",
        entry.kind,
        entry.target,
        ...(value === null ? [] : [value]),
      ]);
    }
  }

  private state(entry: Entry, value: string | null): DeviceResourceStatus["state"] {
    if (entry.kind === "package") {
      return value === "1" ? "enabled" : value === "0" ? "unknown" : "disabled";
    }
    return value === null ? "unknown" : Number(value) === 0 ? "disabled" : "enabled";
  }
}
