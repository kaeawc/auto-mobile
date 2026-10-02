import { AndroidDeviceResourceReader } from "./androidDeviceResourceReader";
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
import { defaultTimer, type Timer } from "./SystemTimer";
import {
  androidDeviceResourceCatalog,
  androidResourceSettings,
} from "./androidDeviceResourceCatalog";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";

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
    adbFactory: Pick<AdbClientFactory, "create"> = defaultAdbClientFactory,
    timer: Pick<Timer, "now"> = defaultTimer,
  ) {
    this.reader = new AndroidDeviceResourceReader({ adbFactory, timer });
  }
  private readonly reader: AndroidDeviceResourceReader;

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
    const run: Run = { ...this.reader.createRun(request), request, result };
    try {
      await this.identifyRun(run);
      for (const resource of supported) {
        await this.configureResource(run, resource);
      }
    } catch (error) {
      request.signal?.throwIfAborted();
      logger.warn(`Android resource configuration failed: ${errorMessage(error)}`, error);
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
    const bootId = await this.reader.identifyRun(run);
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
        : await this.reader.discover(run, resource);
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
      logger.warn(`Android resource configuration failed: ${errorMessage(error)}`, error);
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
    const before = await this.reader.read(run, entry);
    const desired = this.desiredValue(run, entry);
    const resource = entry.resource as ConfigurableDeviceResource;
    if (before !== desired) {
      run.result.restore!.entries.push({ ...entry, value: before });
      if (!run.result.changed.includes(resource)) {
        run.result.changed.push(resource);
      }
      await this.write(run, entry, desired);
    }
    const after = await this.reader.read(run, entry);
    if (after !== desired) {
      throw new Error(`Native state for ${entry.target} did not match requested value`);
    }
    return {
      state: this.reader.state(entry, after),
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
}
