import { DUMPSYS_MAX_BUFFER } from "./android-cmdline-tools/dumpsysLimits";
import type { DeviceResourceObservationRequest } from "./deviceResourceObserver";
import type { ConfigurableDeviceResource } from "../models/DeviceResourceConfiguration";
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

type Entry = AndroidResourceRestoration["entries"][number];
export interface AndroidResourceReadRun {
  request: DeviceResourceObservationRequest;
  user: string;
  command(args: string[]): Promise<string>;
}
const packageCatalog: Partial<Record<ConfigurableDeviceResource, readonly string[]>> =
  androidDeviceResourceCatalog;
const settingsCatalog: Partial<
  Record<ConfigurableDeviceResource, { namespace: "global" | "secure"; keys: readonly string[] }>
> = androidResourceSettings;

/** Native read paths shared by observation and configuration. No mutation or receipt creation. */
export class AndroidDeviceResourceReader {
  constructor(
    private readonly options: {
      adbFactory?: Pick<AdbClientFactory, "create">;
      timer?: Pick<Timer, "now">;
    } = {},
  ) {}
  private get adbFactory() {
    return this.options.adbFactory ?? defaultAdbClientFactory;
  }
  private get timer() {
    return this.options.timer ?? defaultTimer;
  }
  createRun(
    request: DeviceResourceObservationRequest,
    observationOnly = false,
  ): AndroidResourceReadRun {
    const reads = new Map<string, Promise<string>>();
    const adb = this.adbFactory.create(request.device);
    const run: AndroidResourceReadRun = {
      request,
      user: "",
      command: (args) => {
        if (request.signal?.aborted) {
          return Promise.reject(request.signal.reason);
        }
        if (request.deadlineMs <= this.timer.now()) {
          return Promise.reject(new Error("Android resource configuration deadline expired"));
        }
        const cacheable =
          observationOnly &&
          ((args[0] === "pm" && args[1] === "list") ||
            (args[0] === "dumpsys" && args[1] === "package"));
        const key = JSON.stringify(args);
        if (cacheable && reads.has(key)) {
          return reads.get(key)!;
        }
        const read = execute(args);
        if (cacheable) {
          reads.set(key, read);
          void read.then(undefined, () => reads.delete(key));
        }
        return read;
      },
    };
    const execute = async (args: string[]): Promise<string> => {
      request.signal?.throwIfAborted();
      const timeoutMs = request.deadlineMs - this.timer.now();
      if (timeoutMs <= 0) {
        throw new Error("Android resource configuration deadline expired");
      }
      const options: AdbExecuteOptions = {
        maxBuffer: args[0] === "dumpsys" ? DUMPSYS_MAX_BUFFER : undefined,
        timeoutMs,
        signal: request.signal,
        noRetry: true,
        waitForProcessSettlementAfterAbort: true,
      };
      const output = await adb.execute(["shell", args.map(shellQuote).join(" ")], options);
      request.signal?.throwIfAborted();
      return output.stdout.trim();
    };
    return run;
  }
  async identifyRun(run: AndroidResourceReadRun): Promise<string> {
    run.user = await run.command(["am", "get-current-user"]);
    if (!/^\d+$/.test(run.user)) {
      throw new Error("Cannot determine Android foreground user");
    }
    const bootId = await run.command(["cat", "/proc/sys/kernel/random/boot_id"]);
    if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(bootId)) {
      throw new Error("Cannot identify this Android boot");
    }
    return bootId;
  }
  async discover(
    run: AndroidResourceReadRun,
    resource: ConfigurableDeviceResource,
  ): Promise<Entry[]> {
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

  async read(run: AndroidResourceReadRun, entry: Entry): Promise<string | null> {
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

  state(entry: Entry, value: string | null): DeviceResourceStatus["state"] {
    if (entry.kind === "package") {
      return value === "1" ? "enabled" : value === "0" ? "unknown" : "disabled";
    }
    return value === null ? "unknown" : Number(value) === 0 ? "disabled" : "enabled";
  }
}
